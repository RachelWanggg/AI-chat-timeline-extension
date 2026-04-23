# AI Chat Timeline Extension — Design Doc

## 1. Project Overview

AI Chat Timeline is a Chrome Extension (Manifest V3) for ChatGPT and Claude.ai.
It parses chat DOM in real time and renders a structured timeline in Chrome Side Panel.

Core value:
- Fast navigation across long conversations (user turns + assistant headings)
- Better information density with per-turn collapse / unfold
- Prompt productivity tools (save + revise) without backend services

---

## 2. Current Scope

### Timeline
- Parse user and assistant messages on ChatGPT + Claude.ai
- Extract assistant anchors from headings (`h1`–`h3`, excluding `pre` descendants)
- Render turn tree in side panel (`user row` + `assistant anchors`)
- Click-to-scroll for both user row and assistant anchor row
- Active anchor highlight via viewport observation
- URL change + DOM mutation reparse
- **Fold system**
  - Per-turn fold button (`▾ / ▸`) in user row
  - Header action: `⊟ Fold All / ⊞ Unfold All`
  - Runtime state via `collapsedTurns: Set<string>` (no persistence)

### Pinning
- Pin assistant anchors to a top pinned section
- Per-conversation storage key namespace (`pins:${currentPageUrl}`)

### Prompt Tools
- Inject `Save to Prompt Library` into user message bubbles
- Inject `✨ Revise` into user message bubbles
- Inject floating `✨ Revise` for composer draft (ChatGPT + Claude.ai)
- Revision modal supports Copy and Use in Composer
  - ChatGPT: Use in Composer works
  - Claude.ai: Use in Composer works

### Prompt Library + Settings
- Prompt Library CRUD + category + tags + search + inline edit
- Theme mode: light / dark / system
- Revise settings:
  - Anthropic API key
  - Anthropic model
  - `reviseMode` stored as `"pro"` (current supported mode)

---

## 3. Tech Stack

| Layer | Choice |
|-------|--------|
| Extension | Chrome MV3 |
| UI | Vanilla JS + native DOM |
| Storage | `chrome.storage.local` |
| AI API | Anthropic Messages API |
| Build | None (direct source load) |

---

## 4. File Structure

```text
timeline-extension/
├── manifest.json
├── background.js
├── content.js                        # Entry point: injects content/index.js
├── content/
│   ├── index.js                      # Wires up all modules, registers message listeners
│   ├── adapters/
│   │   ├── adapterFactory.js         # Detects host and returns the right adapter
│   │   ├── chatgptAdapter.js         # ChatGPT-specific DOM parsing + observer
│   │   └── claudeAdapter.js          # Claude.ai-specific DOM parsing + observer
│   ├── revise/
│   │   ├── promptBuilder.js          # Builds the revise prompt string
│   │   ├── reviseController.js       # Orchestrates revise flow end-to-end
│   │   └── reviseService.js          # Sends REVISE_VIA_API to background
│   ├── state/
│   │   └── store.js                  # Shared mutable state (anchorCounter, currentUrl, etc.)
│   ├── timeline/
│   │   ├── anchorManager.js          # Injects/removes tl-anchor-* DOM nodes
│   │   ├── parser.js                 # Converts raw DOM turns to TimelineTurn[]
│   │   ├── scrollTracker.js          # IntersectionObserver → ANCHOR_VISIBLE messages
│   │   └── timelineController.js     # Orchestrates parse → send → observe cycle
│   ├── ui/
│   │   ├── actionButtons.js          # Save + Revise buttons injected into message bubbles
│   │   ├── draftReviseButton.js      # Floating Draft Revise button above composer
│   │   ├── revisionModal.js          # Revision result modal (Copy / Use in Composer)
│   │   └── setupModal.js             # API key setup modal
│   └── utils/
│       ├── constants.js              # Shared string constants (selectors, message types)
│       ├── dom.js                    # DOM helpers (waitForElement, etc.)
│       ├── logger.js                 # [Timeline] prefixed console wrapper
│       └── text.js                   # Text extraction + truncation helpers
└── panel/
    ├── sidepanel.html
    ├── sidepanel.css
    └── sidepanel.js
```

Responsibilities:
- `content.js` + `content/`: parse page DOM, inject buttons, send timeline updates, handle scroll targets
- `sidepanel.js`: render timeline/pinned/library/settings, maintain fold state
- `background.js`: side panel open, tab listeners, Anthropic API proxy, prompt save relay

---

## 5. Runtime Architecture

### 5.1 Timeline data flow

```text
ChatGPT / Claude DOM
  -> content/adapters/* (site adapter + MutationObserver)
  -> content/timeline/parser.js
  -> content/timeline/timelineController.js
  -> chrome.runtime.sendMessage(TIMELINE_UPDATE)
  -> sidepanel.js renderTimeline()
```

### 5.2 Jump flow

```text
sidepanel click
  -> chrome.tabs.sendMessage(SCROLL_TO_ANCHOR, anchorId)
  -> content/index.js message listener
  -> anchorManager.js find target node + scrollIntoView()
```

### 5.3 Fold flow (side panel only)

```text
renderTurn(turn)
  -> fold button click
  -> update collapsedTurns
  -> toggle .hidden on that turn's .assistant-anchors
  -> update per-turn button icon + fold-all button state
```

`Fold All` / `Unfold All`:
- If any turn expanded -> collapse all tracked turn IDs
- If all turns collapsed -> clear collapsed set

### 5.4 Revise flow

```text
content/ui/actionButtons.js or draftReviseButton.js
  -> content/revise/reviseController.js
  -> content/revise/reviseService.js
  -> chrome.runtime.sendMessage(REVISE_VIA_API)
  -> background.js call https://api.anthropic.com/v1/messages
  -> return revised text to content
  -> content/ui/revisionModal.js show result
```

---

## 6. Message Protocol

| Type | Direction | Payload |
|------|-----------|---------|
| `TIMELINE_UPDATE` | content -> sidepanel | `TimelineTurn[]` |
| `TIMELINE_CLEAR` | content/background -> sidepanel | none |
| `SCROLL_TO_ANCHOR` | sidepanel -> content | `anchorId` |
| `ANCHOR_VISIBLE` | content -> sidepanel | `anchorId` |
| `REPARSE_NOW` | sidepanel/background -> content | none |
| `ADD_PROMPT_FROM_CONTENT` | content -> background | `{ title, text }` |
| `PROMPT_LIBRARY_UPDATED` | background -> sidepanel | none |
| `REVISE_VIA_API` | content -> background | `{ prompt, apiKey, model }` |

---

## 7. Key Data Structures

```ts
interface TimelineTurn {
  id: string;
  userText: string;
  assistantAnchors: { id: string; label: string }[];
}
```

Runtime-only state in side panel:

```ts
const collapsedTurns: Set<string>; // default empty => all expanded
```

Pinned storage shape:

```ts
Map<anchorId, { id: string; label: string; userText?: string }>
```

---

## 8. Storage Keys

| Key | Purpose |
|-----|---------|
| `promptLibrary` | Prompt Library records |
| `settings` | UI settings (theme, etc.) |
| `reviseMode` | Current revise mode (`"pro"` or null) |
| `anthropicApiKey` | API key |
| `anthropicModel` | Model id |
| `pins:${currentPageUrl}` | Per-conversation pinned anchors |
| `_byokCleanupDone` | One-time migration marker |

---

## 9. Permissions & Hosts (manifest.json)

### permissions
- `sidePanel`
- `storage`

### host_permissions
- `https://api.anthropic.com/*`

### content script matches
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`

---

## 10. Known Limitations

- Claude.ai composer uses ProseMirror; `Use in Composer` from revision modal is not reliable there.
- Parsing depends on host DOM structure and requires selector maintenance when upstream UI changes.

---

## 11. Roadmap

- Bookmark (cross-platform conversation saving)
- Enter key behavior toggle (newline vs submit)
- Copy LaTeX
- Claude.ai `Use in Composer` support via ProseMirror-compatible injection
