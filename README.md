# AI Chat Timeline Extension

A Chrome Extension (Manifest V3) that adds a structured, navigable **timeline sidebar** to ChatGPT and Claude.ai — and surfaces AI-powered prompt revision tools directly in the chat UI.

---

## Features

### Timeline Navigation
- **Sidebar panel** lists every conversation turn in order
- Click any user question or assistant heading to jump there instantly
- Headings (`h1`–`h3`) inside assistant replies become individual jump targets
- **Active highlight**: the currently visible turn is highlighted as you scroll
- **Pin anchors**: pin important turns so they stay accessible across scrolls

### Prompt Utilities (injected into user message bubbles)
- **Save to Prompt Library**: one-click save of any user message to a personal prompt library
- **✨ Revise**: AI-powered revision of any sent prompt (see Revise section below)

### Prompt Library
- Full CRUD: add, edit, delete, copy prompts
- Categories, tags, and search
- Accessible from the sidebar Settings panel

### Draft Revise (floating button above composer)
- A `✨ Revise` pill button floats above the composer *before* you send
- Revises your in-progress draft via Anthropic API, then shows a modal
- Works on both **ChatGPT** and **Claude.ai**
- API Key Mode only (requires your Anthropic API key)

---

## Installation

1. Clone or download this repo
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Navigate to chatgpt.com or claude.ai — the sidebar icon appears in your toolbar

---

## Revise Modes

First time you click **✨ Revise**, a setup modal lets you choose:

| Mode | How it works | Platforms |
|------|-------------|-----------|
| **Chat Mode** | Types a revision request into ChatGPT's composer and extracts the response. No API key needed, but adds 2 messages to your chat. | ChatGPT only |
| **API Key Mode** | Calls `api.anthropic.com` directly via your own key. Silent — nothing added to your chat. | ChatGPT + Claude.ai |

To switch modes or update your key: open the sidebar → **Settings** → **Revise Settings**.

### Known limitation: "Use in Composer" on Claude.ai
The revision modal has a **Use in Composer** button that inserts the revised text into the input box. This works on ChatGPT (React's `execCommand` path), but **does not work on Claude.ai** because Claude's ProseMirror editor requires synthetic events that `execCommand` cannot produce. Use the **Copy** button instead and paste manually.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Extension API | Chrome MV3 |
| UI | Vanilla JS — no framework, no build step |
| Persistence | `chrome.storage.local` |
| AI | Anthropic API (`claude-haiku-4-5` default, configurable) |

---

## File Structure

```
├── manifest.json          # Extension config + permissions
├── background.js          # Service worker: tab events, Anthropic API proxy
├── content.js             # Injected into ChatGPT/Claude: DOM parsing, button injection
└── panel/
    ├── sidepanel.html     # Sidebar UI
    ├── sidepanel.css      # Styles + light/dark/system theme
    └── sidepanel.js       # Timeline render, Prompt Library, Settings
```

---

## Roadmap

- [ ] "Use in Composer" support on Claude.ai (ProseMirror event injection)
- [ ] Bookmark — save and revisit conversations across platforms
- [ ] Enter key toggle (newline vs. submit)
- [ ] Copy LaTeX from assistant replies
