# Architecture

## The problem

ChatGPT and Claude.ai are React SPAs that render conversations into a **virtualized** list:
offscreen messages are unmounted from the DOM and their containers collapse to zero height.
Both also stream replies, so the document reflows continuously while the user is reading.

That makes the naive implementation of this extension fail in three separate ways:

1. **You cannot cache DOM nodes.** A node resolved a second ago may already be detached.
2. **You cannot scroll to what is not mounted.** The target has to be forced into existence first.
3. **`element.scrollIntoView()` is not usable.** Inside nested scroll containers it scrolls the
   wrong ancestor, and native smooth scrolling is interrupted by the very reflows that
   streaming and virtualization produce.

Most of the design below exists to handle those three facts.

---

## Data flow

```
ChatGPT / Claude.ai DOM
   │
   ├── MutationObserver ──────────┐
   │                              │
   └── (ChatGPT only)             │
       fetch interceptor ─────────┤
       /backend-api/conversation  │
                                  ▼
                      content/adapters/*  ──►  content/timeline/parser.js
                      (platform DOM/API)       (pure: turns -> TimelineTurn[])
                                                         │
                                          TIMELINE_UPDATE │ chrome.runtime.sendMessage
                                                         ▼
                                                panel/sidepanel.js
                                                (renders the outline)
```

Jumping runs the other way: the side panel sends `SCROLL_TO_ANCHOR`, and the content script
resolves the anchor and hands it to the scroll engine.

### Module responsibilities

| Module | Responsibility | Excluded |
|---|---|---|
| `adapters/*` | Platform-specific DOM reading | No scrolling, no messaging |
| `timeline/parser.js` | Turns -> `TimelineTurn[]` | Pure; no DOM, no I/O |
| `timeline/anchorManager.js` | `anchorId` -> the live DOM node | Never scrolls or mounts |
| `timeline/scrollEngine.js` | All scrolling | Does not decide the active anchor |
| `timeline/scrollTracker.js` | Which anchor is being read | Does not parse |
| `timeline/timelineController.js` | Orchestration | — |

The split between `anchorManager` (resolve) and `scrollEngine` (move) is what keeps the
scrolling logic testable in isolation from the parsing logic.

---

## Message protocol

| Message | Direction | Payload |
|---|---|---|
| `TIMELINE_UPDATE` | content → panel | `TimelineTurn[]`, plus `url` and `contextStats` |
| `TIMELINE_CLEAR` | content → panel | — (SPA navigated to another conversation) |
| `SCROLL_TO_ANCHOR` | panel → content | `anchorId` |
| `ANCHOR_VISIBLE` | content → panel | `anchorId` currently being read |
| `REPARSE_NOW` | panel/background → content | — |
| `ADD_PROMPT_FROM_CONTENT` | content → background → panel | Prompt record |
| `REVISE_VIA_API` | content → background | `{ prompt, apiKey, model }` |

`REVISE_VIA_API` is handled in the service worker rather than the content script because the
content page's CSP blocks a direct call to `api.anthropic.com`.

### Timeline data

```javascript
[
  {
    id: "message-id",                 // stable id of the user message
    userText: "truncated question",
    assistantAnchors: [
      { id: "tl-anchor-0", label: "Heading text" },
    ],
  },
]
```

---

## Reading the conversation

**Claude.ai** is read purely from the DOM: `div[data-testid="user-message"]` and
`div.font-claude-response` are collected, sorted by `compareDocumentPosition`, and headings are
extracted from `.standard-markdown h1,h2,h3` (excluding anything inside `<pre>`).

**ChatGPT** additionally intercepts `fetch`. A `MAIN`-world content script at `document_start`
wraps `window.fetch` and clones the response to `/backend-api/conversation/{id}`, which
contains the entire message mapping — every message, regardless of what is currently mounted.
Messages are rebuilt in tree order by walking from `current_node` up through `parent` links and
reversing, which yields the *active branch* (regenerating or editing a message creates
branches; `current_node` points at the live leaf).

Two constraints shape that interceptor:

- It must never disturb the original response, hence `response.clone()`.
- The `MAIN` world and the isolated world can only exchange structured-cloneable data, so
  results cross via a `CustomEvent`. The interceptor runs at `document_start` but the listener
  is only ready at `document_idle`, so the last successful parse is cached and replayed on
  request — otherwise the first screen is silently lost.

DOM parsing remains the fallback whenever the interception path yields nothing.

---

## Scrolling

`scrollEngine` is the single authority for moving the page. Its rules were verified with
chrome-devtools against live pages:

**Find the container by walking up, not by class name.** From the target element, walk to the
first ancestor whose `overflowY` is `auto`/`scroll` *and* whose `scrollHeight` exceeds its
`clientHeight`. Measured, this resolves to a `[scrollbar-gutter]` div on ChatGPT and a
`[scrollbar-gutter:stable]` div on Claude — on neither platform is it `window`. Walking up also
naturally skips unrelated nested scrollers such as the sidebar.

**Position arithmetically.**

```
top = container.scrollTop + (elementTop - containerTop) - offset
top = clamp(top, 0, scrollHeight - clientHeight)
```

The clamp makes overscroll impossible. Measured landing error: 0px.

**Mount before moving, but only when needed.** If `resolveElement` cannot find the target, it
has been virtualized away. The engine locates the placeholder turn container (ChatGPT keeps the
`<section>` even when it drops the contents), scrolls it in with an instant arithmetic jump to
trigger the React mount, and polls until resolution succeeds. If the target was already
mounted, this phase is skipped entirely so the user never sees a jump.

**Drive smooth scrolling yourself.** Native smooth scrolling gets interrupted by reflows in the
virtualized list — the symptom is "one click only scrolls part of the way." Instead, on every
`requestAnimationFrame`, re-resolve the target and advance `scrollTop` along an easing curve.
When the target remounts or shifts because a reply is still streaming, the next frame simply
follows the new position, still smoothly.

**Then settle.** After arrival, keep verifying for a few frames that the target is still at the
intended offset and the layout has stopped moving, correcting if not, with a deadline so a
still-streaming reply cannot hold the engine open forever.

**Jump tokens.** Every jump takes a monotonically increasing token. A new jump invalidates all
async phases of the previous one, so two jumps can never fight over `scrollTop`.

### Why highlighting needs a gate

While a jump is in flight, mounting and unmounting floods the `MutationObserver`. Re-parsing
then — rebuilding the `IntersectionObserver`, re-extracting every heading — piles work onto the
exact frames where the page is already struggling to mount heavy turns, which is what made
scrolling stutter. So during a jump:

- reparse is suspended, and runs exactly once after the scroll settles;
- `scrollTracker` is locked, so anchors scrolled past are not briefly reported as active;
- the side panel highlights the target optimistically and unlocks with that id, so the
  highlight does not snap backwards on arrival.

`scrollTracker` also uses the real scroll container as its `IntersectionObserver` root, with a
`rootMargin` that reserves the sticky header, and requires an element to stay in the reading
band for 250ms before it counts. Without that stability delay the highlight flickers between
anchors that intersect in the same frame.

---

## Context estimate

`tokenEstimator.js` approximates how much of the model's context window a conversation fills,
without shipping a tokenizer. It separates `<pre>` content from prose (code tokenizes more
densely), counts CJK characters at a higher rate than Latin, detects URLs and long opaque
tokens as dense regions, classifies the conversation's overall density, and applies a safety
multiplier. It is deliberately biased to over-count: a bar that warns early is useful, one that
warns late is not.

---

## Testing

The pure modules are tested with Node's built-in runner (`npm test`): `parser.js`,
`tokenEstimator.js`, `promptBuilder.js`, `adapterFactory.js`, and `claudeAdapter.js` — the last
driven by jsdom with synthetic conversation markup.

`scrollEngine` and `timelineController` are not unit-tested. They depend on live layout,
`requestAnimationFrame` timing, and React's virtualization behaviour, none of which jsdom
reproduces faithfully enough for a test to mean anything; they are verified manually against
real pages instead.
