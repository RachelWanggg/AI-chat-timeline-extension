# AI Chat Timeline Extension — Design Doc

## 1. Project Overview

A Chrome Extension (Manifest V3) that adds structured, navigable **timeline panels** to ChatGPT and Claude. It parses conversation DOM in real time and builds a sidebar that lets users jump to any turn or heading. It also surfaces per-message utilities: saving prompts to a library and revising prompts via the AI's own API.

**Core value props:**
- Jump to any user question *or* assistant heading in one click
- Pin important anchors for persistent reference
- Save, organize, and reuse prompts (Prompt Library)
- AI-powered prompt revision without polluting chat history

---

## 2. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Extension API | Chrome MV3 | Required for new Chrome extensions |
| UI | Native JS, no framework | Zero build tooling, instant load |
| Persistence | `chrome.storage.local` | Per-device, offline, no backend |
| AI APIs | Anthropic / OpenAI REST | Direct fetch from background service worker |

---

## 3. File Structure

```
timeline-extension/
├── manifest.json          # Extension config, permissions, content scripts
├── background.js          # Service worker: tab events, API calls (REVISE_PROMPT)
├── content.js             # Injected into ChatGPT/Claude: DOM parse, button injection
└── panel/
    ├── sidepanel.html     # Side panel UI structure
    ├── sidepanel.css      # Side panel styles + theme variables
    └── sidepanel.js       # Rendering, Prompt Library, settings logic
```

---

## 4. Architecture

### 4.1 Data Flow

```
ChatGPT / Claude DOM
  └─ content.js (MutationObserver + SITE_ADAPTERS)
       └─ chrome.runtime.sendMessage → TIMELINE_UPDATE
            └─ sidepanel.js → renderTimeline()
```

### 4.2 Scroll / Jump Flow

```
sidepanel.js click
  └─ chrome.tabs.sendMessage → SCROLL_TO_ANCHOR
       └─ content.js → element.scrollIntoView()
```

### 4.3 Prompt Revise Flow

Two entry points share the same API call path:

**A. Per-message Revise button** (injected into user message bubbles):
```
content.js (✨ Revise click on message bubble)
  └─ handleReviseClick(text, btn)
       ├─ reviseMode === null? → showSetupModal() → user picks mode
       ├─ reviseMode === "free" (ChatGPT only)
       │    └─ revisePromptViaChatGPT() → DOM automation (type + send + extract)
       └─ reviseMode === "pro"
            └─ reviseViaAnthropicAPI(text, apiKey, model)
                 └─ chrome.runtime.sendMessage → REVISE_VIA_API
                      └─ background.js → fetch api.anthropic.com
                           └─ { ok: true, text: "..." } → showRevisionModal()
```

**B. Draft Revise floating button** (hovers above composer):
```
content.js (✨ Revise click above composer)
  └─ handleDraftReviseClick(btn)        [ChatGPT]
  └─ handleDraftReviseClickClaude(btn)  [Claude.ai]
       ├─ reviseMode !== "pro" or no apiKey? → showToast(error)
       └─ reviseViaAnthropicAPI(draftText, apiKey, model)
            └─ REVISE_VIA_API → background.js → Anthropic API
                 └─ showRevisionModal(revised)
```

### 4.4 Message Protocol

| Type | Direction | Payload |
|------|-----------|---------|
| `TIMELINE_UPDATE` | content → sidepanel | `TimelineTurn[]` |
| `TIMELINE_CLEAR` | content → sidepanel | — |
| `SCROLL_TO_ANCHOR` | sidepanel → content | `{ anchorId: string }` |
| `ANCHOR_VISIBLE` | content → sidepanel | `{ anchorId: string }` |
| `REPARSE_NOW` | sidepanel / background → content | — |
| `ADD_PROMPT_FROM_CONTENT` | content → background → sidepanel | `{ title, text }` |
| `REVISE_VIA_API` | content → background | `{ prompt, apiKey, model }` → `{ ok, text }` or `{ ok: false, error, code }` |

---

## 5. Data Structures

### TimelineTurn
```typescript
interface TimelineTurn {
  id: string;                  // DOM id of user message element
  userText: string;            // Truncated (≤50 chars)
  assistantAnchors: Anchor[];
}

interface Anchor {
  id: string;   // tl-anchor-{n} or tl-user-{n}
  label: string; // heading text or truncated paragraph
}
```

### Prompt
```typescript
interface Prompt {
  id: string;         // generateId()
  title: string;
  text: string;
  category: string;   // Writing | Coding | Analysis | Brainstorm | Documentation | Other
  tags: string[];
  createdAt: string;  // ISO 8601
}
```

### Revise Config (chrome.storage.local keys)
```typescript
interface ReviseConfig {
  reviseMode: "free" | "pro" | null;  // null = first-run, shows setup modal
  anthropicApiKey: string;             // sk-ant-... key for API Key Mode
  anthropicModel: string;              // e.g. "claude-haiku-4-5" | "claude-sonnet-4-6"
}
```

---

## 6. Site Adapters

Two parsing strategies:

**ChatGPT** — Uses `SITE_ADAPTERS["chatgpt.com"]`:
- Turn selector: `section[data-testid^="conversation-turn"]`
- User text: `.whitespace-pre-wrap` inside `[data-turn="user"]`
- Assistant headings: `h1, h2, h3` (excluding `pre` descendants)
- Fallback: first `<p>` with >10 chars

**Claude.ai** — Custom `parseClaude()` (no unified turn container):
- User: `div[data-testid="user-message"]`
- Assistant: `div.font-claude-response`
- Sorted by DOM order via `compareDocumentPosition`
- Headings from `.standard-markdown h1/h2/h3`

---

## 7. Key Modules

### content.js

**Timeline parsing**

| Function | Responsibility |
|----------|----------------|
| `main()` | Entry point; resets state, routes to ChatGPT or Claude path |
| `parseConversation(adapter)` | Iterates turn elements via SITE_ADAPTERS |
| `parseClaude()` | Claude-specific parser (merges user + assistant by DOM order) |
| `buildTimelineData(turns)` | Converts flat list → user-as-parent tree |
| `startObserver(adapter)` | MutationObserver for ChatGPT |
| `startClaudeObserver()` | MutationObserver for Claude |
| `startAnchorObserver()` | IntersectionObserver for active highlight + scroll direction |

**Per-message Revise (user message bubbles)**

| Function | Responsibility |
|----------|----------------|
| `injectSaveButtons()` | Appends "Save to Prompt Library" + "✨ Revise" to user message bubbles |
| `handleReviseClick(text, btn)` | Routes to free/pro mode; shows setup modal on first run |
| `revisePromptViaChatGPT(prompt)` | Chat Mode — DOM automation: type → send → extract response |
| `reviseViaAnthropicAPI(prompt, key, model)` | API Key Mode — sends REVISE_VIA_API to background.js |
| `showRevisionModal(revisedText)` | Modal with revised text; Copy + "Use in Composer" buttons |
| `showSetupModal(onComplete)` | First-run mode picker (Chat Mode vs API Key Mode) |

**Draft Revise floating button (above composer)**

| Function | Responsibility |
|----------|----------------|
| `injectDraftReviseButton()` | ChatGPT: injects `.tl-revise-draft-wrapper` into `<form>` |
| `updateDraftButtonState(btn)` | Reads `#prompt-textarea.innerText`, updates disabled + tooltip |
| `attachComposerInputListener()` | One-time `input` listener on ChatGPT composer |
| `handleDraftReviseClick(btn)` | ChatGPT click handler → API Key Mode only |
| `startDraftReviseObserver()` | MutationObserver to re-inject on React re-render (ChatGPT) |
| `findClaudeComposer()` | Returns `[data-testid="chat-input"]` or `.ProseMirror` |
| `findClaudeComposerContainer()` | Walks up DOM to find `rounded-` ancestor card |
| `injectClaudeDraftReviseButton()` | Claude.ai: injects `.tl-revise-draft-wrapper-claude` into card |
| `injectClaudeDraftReviseExtraCSS()` | CSS for `.tl-revise-draft-wrapper-claude` positioning |
| `updateClaudeDraftButtonState(btn)` | Reads ProseMirror `innerText`, updates state + tooltip |
| `attachClaudeComposerInputListener()` | One-time `input` listener on Claude.ai ProseMirror div |
| `handleDraftReviseClickClaude(btn)` | Claude.ai click handler → API Key Mode only |
| `startClaudeDraftReviseObserver()` | MutationObserver 5 levels up from composer (Claude.ai) |

### background.js

| Function | Responsibility |
|----------|----------------|
| `REVISE_VIA_API` handler | Receives `{ prompt, apiKey, model }` from content.js; calls Anthropic API; returns `{ ok, text }` or `{ ok: false, error, code: "INVALID_KEY" }` |

Model default: `claude-haiku-4-5` (configurable by user in setup modal)

### sidepanel.js

| Function | Responsibility |
|----------|----------------|
| `renderTimeline(data)` | Main render loop |
| `renderTurn(turn)` | User anchor + assistant anchor rows |
| `togglePin(id, label, userText)` | Pin/unpin with `chrome.storage.local` persistence |
| `loadPromptLibrary() / savePromptLibrary()` | CRUD for prompt list |
| `loadApiKeys() / saveApiKeys()` | Read/write API keys in settings |
| `applyTheme(theme)` | light / dark / system theme switching |

---

## 8. Permissions

| Permission | Why |
|-----------|-----|
| `sidePanel` | Open side panel on icon click |
| `tabs` | Query active tab URL, send messages to content scripts |
| `activeTab` | Access tab info |
| `storage` | Persist pins, prompts, settings, revise config |
| `host_permissions: api.anthropic.com` | Revise via Anthropic API (both per-message and Draft Revise) |

---

## 9. Feature Roadmap

### Shipped
- [x] ChatGPT DOM parsing (SITE_ADAPTERS)
- [x] Claude.ai DOM parsing (custom `parseClaude`)
- [x] Multi-heading anchor extraction (h1–h3, excluding `<pre>`)
- [x] MutationObserver real-time updates (ChatGPT + Claude.ai)
- [x] Click-to-scroll (user turns + assistant headings)
- [x] IntersectionObserver active highlight + scroll direction
- [x] URL change detection (SPA re-parse)
- [x] Pin anchors (per-conversation persistence)
- [x] Prompt Library (CRUD, categories, tags, search, in-place edit, copy)
- [x] Save to Prompt Library button injected into user messages
- [x] Light / dark / system theme
- [x] **Revise prompt** (per-message bubble) — API Key Mode (Anthropic) + Chat Mode (ChatGPT DOM automation)
- [x] **Draft Revise floating button** (above composer) — ChatGPT + Claude.ai, API Key Mode only

### Planned
- [ ] Draft Revise "Use in Composer" on Claude.ai (requires ProseMirror synthetic event injection)
- [ ] Bookmark (cross-platform conversation saving)
- [ ] Enter key handling (newline vs. submit toggle)
- [ ] Copy LaTeX

---

## 10. Revise Feature — Detailed Design

Two separate Revise surfaces exist side by side.

---

### 10.1 Per-message Revise (message bubble button)

Appears as a `✨ Revise` button injected below each user message bubble.

**UI States**

```
[default]    ✨ Revise
[loading]    ⏳ Revising...  (disabled)
[success]    ✨ Revise  →  Revision modal appears (floating overlay)
[error]      toast: red error message (auto-dismisses)
```

**Revision Modal**

```
┌── ✨ Revised Prompt ─────────────────── [✕] ──┐
│                                                │
│  <revised text>                                │
│                                                │
├────────────────────────────────────────────────┤
│              [Copy]  [Use in Composer]         │
└────────────────────────────────────────────────┘
```

- **Copy**: copies revised text to clipboard
- **Use in Composer**: inserts into ChatGPT composer (ChatGPT only — uses `execCommand('insertText')` which ChatGPT's React layer handles; does NOT work on Claude.ai's ProseMirror editor)

**Modes**

| Mode | Trigger | How it works |
|------|---------|--------------|
| Chat Mode (`free`) | First click → setup modal → pick Chat Mode | Programmatically types a revision request into ChatGPT's composer, submits, extracts the response. ChatGPT only. |
| API Key Mode (`pro`) | First click → setup modal → pick API Key Mode | Calls `api.anthropic.com/v1/messages` directly via background.js. Works on both ChatGPT and Claude.ai. |

**First-run Setup Modal**

Shown when `reviseMode === null`. User picks:
- **Chat Mode** (ChatGPT only, disabled on Claude.ai)
- **API Key Mode** → sub-view: enter `sk-ant-...` key + pick model → stored as `reviseMode: "pro"`, `anthropicApiKey`, `anthropicModel`

---

### 10.2 Draft Revise Floating Button (above composer)

A `✨ Revise` pill button that floats above the active composer before the user sends their message.

**Positioning**

| Platform | Container | CSS class | Anchor |
|----------|-----------|-----------|--------|
| ChatGPT | `<form>` wrapping `#prompt-textarea` | `.tl-revise-draft-wrapper` | `position:absolute; top:-36px; right:12px` |
| Claude.ai | Rounded card (first ancestor with `rounded-` in className) | `.tl-revise-draft-wrapper-claude` | `position:absolute; top:-36px; right:12px` |

**Button States**

```
[composer empty]          ✨ Revise  (disabled, grey)
                          tooltip: "Type something to revise"

[composer < 5 chars]      ✨ Revise  (enabled)
                          tooltip: "Draft too short — type more"

[composer ≥ 5 chars]      ✨ Revise  (enabled, purple)
                          tooltip: "Revise draft with AI"

[API call in flight]      ⏳ Revising...  (disabled)

[success]                 Revision modal opens
```

**Constraints**

- API Key Mode only (no Chat Mode for Draft Revise)
- "Use in Composer" in the modal works on ChatGPT; **does not work on Claude.ai** (ProseMirror ignores `execCommand`)
- The MutationObserver re-injects the button if React or Claude's SPA destroys the DOM subtree

---

### 10.3 Security Notes
- API key stored in `chrome.storage.local` (device-local, not synced)
- Key is never sent to any server other than `api.anthropic.com`
- API call is made from the background service worker (bypasses content page CSP)
- HTTPS enforced by the API endpoint
