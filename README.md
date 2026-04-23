# AI Chat Timeline Extension

A Chrome Extension (Manifest V3) that adds a structured **timeline side panel** to ChatGPT and Claude.ai, with prompt utilities built into the chat UI.

---

## Features

### Timeline Navigation
- Parse conversation turns in real time and render them in side panel order
- Jump to any user turn or assistant heading (`h1`–`h3`) with one click
- Active anchor highlight while scrolling
- **Per-turn collapse**: toggle assistant anchors with `▾ / ▸`
- **Global collapse**: `⊟ Fold All / ⊞ Unfold All`
- Pin important assistant anchors to a top pinned area

### Prompt Utilities
- **Save to Prompt Library** button injected into user message bubbles
- **✨ Revise** button injected into user message bubbles (Anthropic API)
- **✨ Draft Revise** floating button above composer (ChatGPT + Claude.ai)

### Prompt Library
- CRUD (add/edit/delete/copy)
- Category + tags + keyword search
- Open from side panel header (`Prompt Library 📚`)

### Theme
- Light / Dark / System mode

---

## Installation

1. Clone or download this repo.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this project folder.
5. Open `chatgpt.com` or `claude.ai`, then click the extension icon to open side panel.

---

## Revise (Current Behavior)

- Revise is **API Key Mode only** (`reviseMode: "pro"`).
- API request is proxied through `background.js` to `https://api.anthropic.com/v1/messages`.
- Configure key/model in side panel: **Settings → Revise Settings**.

### Known limitation on Claude.ai

`Use in Composer` in revision modal does not work on Claude.ai ProseMirror editor. Use **Copy** and paste manually.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Extension API | Chrome MV3 |
| UI | Vanilla JS (no framework, no build step) |
| Persistence | `chrome.storage.local` |
| AI | Anthropic API |

---

## File Structure

```
├── manifest.json          # Extension config + permissions
├── background.js          # Service worker: side panel open, tab events, API proxy
├── content.js             # DOM parsing + anchor injection + revise/save actions
└── panel/
    ├── sidepanel.html     # Side panel markup
    ├── sidepanel.css      # Side panel styles
    └── sidepanel.js       # Timeline rendering, collapse/pin, settings, prompt library
```

---

## Roadmap

- [ ] Bookmark (cross-platform conversation saving)
- [ ] Enter key handling (newline vs submit toggle)
- [ ] Copy LaTeX
- [ ] Draft Revise `Use in Composer` support on Claude.ai
