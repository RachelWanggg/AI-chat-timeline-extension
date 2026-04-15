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

```
content.js (Revise button click)
  └─ chrome.runtime.sendMessage → REVISE_PROMPT { text, platform }
       └─ background.js
            ├─ chrome.storage.local.get("apiKeys")
            ├─ no key? → { success: false, error: "no_api_key" }
            └─ has key? → fetch Anthropic / OpenAI API
                 └─ sendResponse { success: true, revised: "..." }
                      └─ content.js → showRevisedUI()
```

### 4.4 Message Protocol

| Type | Direction | Payload |
|------|-----------|---------|
| `TIMELINE_UPDATE` | content → sidepanel | `TimelineTurn[]` |
| `TIMELINE_CLEAR` | content / background → sidepanel | — |
| `SCROLL_TO_ANCHOR` | sidepanel → content | `{ anchorId: string }` |
| `ANCHOR_VISIBLE` | content → sidepanel | `{ anchorId: string }` |
| `REPARSE_NOW` | sidepanel / background → content | — |
| `ADD_PROMPT_FROM_CONTENT` | content → background → sidepanel | `{ title, text }` |
| `REVISE_PROMPT` | content → background | `{ text, platform: "claude" \| "openai" }` |

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

### API Keys (chrome.storage.local key: `"apiKeys"`)
```typescript
interface ApiKeys {
  anthropic?: string;   // Anthropic API key (for Claude)
  openai?: string;      // OpenAI API key (for ChatGPT)
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

| Function | Responsibility |
|----------|----------------|
| `main()` | Entry point; resets state, routes to ChatGPT or Claude path |
| `parseConversation(adapter)` | Iterates turn elements via adapter |
| `parseClaude()` | Claude-specific parser (no turnSelector) |
| `buildTimelineData(turns)` | Converts flat list → user-as-parent tree |
| `injectSaveButtons()` | Appends Save + Revise buttons to user messages |
| `handleReviseClick(msg, btn, platform)` | Calls REVISE_PROMPT, manages button states |
| `showApiKeyWarning(btn)` | Fixed-position popup when no API key |
| `showRevisedUI(msg, original, revised, platform)` | Inline revised prompt with Unrevise / Regenerate / Save |
| `startObserver(adapter)` | MutationObserver for ChatGPT |
| `startClaudeObserver()` | MutationObserver for Claude |
| `startAnchorObserver()` | IntersectionObserver for active highlight |

### background.js

| Function | Responsibility |
|----------|----------------|
| `handleRevisePrompt(text, platform)` | Reads API key, dispatches to correct API |
| `callClaudeAPI(apiKey, text)` | `POST api.anthropic.com/v1/messages` |
| `callOpenAIAPI(apiKey, text)` | `POST api.openai.com/v1/chat/completions` |

Models used:
- Claude: `claude-haiku-4-5-20251001` (fast, low cost)
- OpenAI: `gpt-4o-mini` (fast, low cost)

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
| `storage` | Persist pins, prompts, settings, API keys |
| `host_permissions: api.anthropic.com` | Revise via Claude API |
| `host_permissions: api.openai.com` | Revise via OpenAI API |

---

## 9. Feature Roadmap

### Shipped
- [x] ChatGPT DOM parsing (SITE_ADAPTERS)
- [x] Claude.ai DOM parsing (custom `parseClaude`)
- [x] Multi-heading anchor extraction (h1–h3, excluding `<pre>`)
- [x] MutationObserver real-time updates
- [x] Click-to-scroll (user turns + assistant headings)
- [x] IntersectionObserver active highlight + scroll direction
- [x] URL change detection (SPA re-parse)
- [x] Pin anchors (per-conversation persistence)
- [x] Prompt Library (CRUD, categories, tags, search, in-place edit, copy)
- [x] Save to Prompt Library button injected into user messages
- [x] Light / dark / system theme
- [x] **Prompt Revise** — AI-powered revision via user's own API key

### Planned
- [ ] Bookmark (cross-platform conversation saving)
- [ ] Enter key handling (newline vs. submit toggle)
- [ ] Copy LaTeX
- [ ] Prompt Library export / import

---

## 10. Revise Feature — Detailed Design

### UI States (button in chat)

```
[default]        ✨ Revise
[loading]        ⏳ Revising...   (disabled)
[no api key]     ✨ Revise  +  ⚠️ popup: "Open Timeline → Settings to add your API key"
[api error]      ❌ Failed        (reverts after 2.5s)
[success]        ✨ Revise  +  inline revised block appears below
```

### Revised Block

```
┌─ purple left border ──────────────────────────┐
│ ✨ Revised prompt:                              │
│                                               │
│  <revised text displayed here>                │
│                                               │
│  [↩ Unrevise]  [🔄 Regenerate]  [💾 Save to Library] │
└───────────────────────────────────────────────┘
```

- **Unrevise**: removes the revised block, restores default view
- **Regenerate**: re-calls the API with the *original* text, replaces revised text
- **Save to Library**: saves the current revised text to Prompt Library

### API Key Setup Flow

1. User clicks **⚙️ Settings** in the panel header
2. Enters Anthropic API Key and/or OpenAI API Key
3. Clicks **Save API Keys** → stored in `chrome.storage.local` under `"apiKeys"`
4. Keys are loaded on sidepanel open and pre-filled (masked as password fields)

### Security Notes
- API keys stored in `chrome.storage.local` (device-local, not synced)
- Keys are never sent to any server other than the respective AI API
- HTTPS enforced by the API endpoints themselves
