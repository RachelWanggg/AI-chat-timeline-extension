import { createLogger } from "../utils/logger.js";

const logger = createLogger("Adapter.Claude");

function smartTruncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.6) return truncated.slice(0, lastSpace) + "…";
  return truncated + "…";
}

export const claudeAdapter = {
  id: "claude",
  turnSelector: null,
  containerSelector: null,
  messageSelectors: ['div[data-testid="user-message"]', "div.font-claude-response"],
  isUserTurn: () => null,
  extractUserText: () => null,
  extractAssistantAnchors: () => [],

  getComposer() {
    return (
      document.querySelector('[data-testid="chat-input"]') ||
      document.querySelector(".ProseMirror")
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
    return Array.from(document.querySelectorAll('div[data-testid="user-message"]'));
  },
};

export function parseClaude() {
  const userEls = Array.from(document.querySelectorAll('div[data-testid="user-message"]'));
  const assistantEls = Array.from(document.querySelectorAll("div.font-claude-response"));

  const allEls = [...userEls, ...assistantEls].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const result = [];
  let userIdx = 0;
  let assistantIdx = 0;

  allEls.forEach((el) => {
    const isUser = el.matches('div[data-testid="user-message"]');

    if (isUser) {
      const node = el.querySelector(".whitespace-pre-wrap");
      if (!node) return;
      // 用 DOM 顺序位置生成稳定 ID，避免 SPA 导航后 counter 漂移
      const stableId = `tl-user-${userIdx++}`;
      el.id = stableId;
      result.push({ id: stableId, role: "user", text: node.textContent.trim(), element: el });
    } else {
      const headings = Array.from(
        el.querySelectorAll(".standard-markdown h1, .standard-markdown h2, .standard-markdown h3")
      ).filter((h) => !h.closest("pre"));

      const aIdx = assistantIdx++;
      let anchors = [];

      if (headings.length > 0) {
        anchors = headings.map((h, hIdx) => {
          const stableId = `tl-anchor-a${aIdx}-h${hIdx}`;
          h.id = stableId;
          return { id: stableId, label: h.textContent.trim(), element: h };
        });
      } else {
        const paragraphs = el.querySelectorAll("p");
        for (const p of paragraphs) {
          const text = p.textContent.trim();
          if (text.length > 10) {
            const stableId = `tl-anchor-a${aIdx}-p0`;
            p.id = stableId;
            anchors = [{ id: stableId, label: smartTruncate(text, 40), element: p }];
            break;
          }
        }
      }

      if (anchors.length === 0) return;

      result.push({
        id: `tl-assistant-${aIdx}`,
        role: "assistant",
        anchors,
      });
    }
  });

  return result;
}
