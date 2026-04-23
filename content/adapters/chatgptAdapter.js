import { createLogger } from "../utils/logger.js";

const logger = createLogger("Adapter.ChatGPT");

function smartTruncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.6) return truncated.slice(0, lastSpace) + "…";
  return truncated + "…";
}

export const chatgptAdapter = {
  id: "chatgpt",
  turnSelector: 'section[data-testid^="conversation-turn"]',
  containerSelector: "main",
  messageSelectors: ['section[data-testid^="conversation-turn"]'],

  isUserTurn(el) {
    return el.getAttribute("data-turn") === "user";
  },

  extractUserText(el) {
    const node = el.querySelector(".whitespace-pre-wrap");
    if (!node) return null;
    const domId = el.getAttribute("data-turn-id");
    if (domId && !el.id) el.id = domId;
    return { text: node.textContent.trim(), domId: domId || null };
  },

  extractAssistantAnchors(el, index) {
    const container = el.querySelector('[data-message-author-role="assistant"]');
    if (!container) return [];
    if (!el.id) {
      const domId = el.getAttribute("data-turn-id");
      el.id = domId || `tl-assistant-turn-${index}`;
    }
    const turnId = el.id;

    const headings = Array.from(container.querySelectorAll("h1, h2, h3")).filter(
      (h) => !h.closest("pre")
    );

    if (headings.length > 0) {
      return headings.map((h, idx) => {
        const stableId = `tl-anchor-${turnId}-h${idx}`;
        if (h.id !== stableId) h.id = stableId;
        return {
          id: stableId,
          label: h.textContent.trim(),
          element: h,
          fallback: {
            sectionId: el.id,
            headingIndex: idx,
            isParagraph: false,
            containerSelector: '[data-message-author-role="assistant"]',
          },
        };
      });
    }

    const paragraphs = container.querySelectorAll("p");
    for (const p of paragraphs) {
      const text = p.textContent.trim();
      if (text.length > 10) {
        const stableId = `tl-anchor-${turnId}-p0`;
        if (p.id !== stableId) p.id = stableId;
        return [{
          id: stableId,
          label: smartTruncate(text, 40),
          element: p,
          fallback: {
            sectionId: el.id,
            headingIndex: 0,
            isParagraph: true,
            containerSelector: '[data-message-author-role="assistant"]',
          },
        }];
      }
    }

    return [];
  },

  getComposer() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('form div[contenteditable="true"]')
    );
  },

  insertText(composerEl, text) {
    if (!composerEl) return false;
    composerEl.focus();
    document.execCommand("selectAll");
    const ok = document.execCommand("insertText", false, text);
    if (!ok) logger.warn("insertText failed");
    return ok;
  },

  getUserMessageNodes() {
    const authorRoleNodes = Array.from(
      document.querySelectorAll('[data-message-author-role="user"]')
    );
    if (authorRoleNodes.length > 0) return authorRoleNodes;
    return Array.from(
      document.querySelectorAll(
        'section[data-testid^="conversation-turn"][data-turn="user"]'
      )
    );
  },
};
