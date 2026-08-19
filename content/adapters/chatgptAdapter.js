import { createLogger } from "../utils/logger.js";

const logger = createLogger("Adapter.ChatGPT");

function normalizeText(text) {
  return String(text || "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveUserNode(el) {
  if (!el) return null;
  if (el.matches?.('[data-message-author-role="user"]')) return el;
  return el.querySelector?.('[data-message-author-role="user"]') || el;
}

function resolveAssistantNode(el) {
  if (!el) return null;
  if (el.matches?.('[data-message-author-role="assistant"]')) return el;
  return el.querySelector?.('[data-message-author-role="assistant"]') || el;
}

function resolveTurnSection(el) {
  if (!el) return null;
  if (el.matches?.('section[data-testid^="conversation-turn"]')) return el;
  return el.closest?.('section[data-testid^="conversation-turn"]') || el;
}

function resolveMessageId(el, role) {
  if (!el) return null;
  const roleSelector = role
    ? `[data-message-id][data-message-author-role="${role}"]`
    : "[data-message-id]";
  if (el.matches?.(roleSelector)) return el.getAttribute?.("data-message-id") || null;
  const node = el.querySelector?.(roleSelector) || el.querySelector?.("[data-message-id]");
  return node?.getAttribute?.("data-message-id") || null;
}

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
    const turnSection = resolveTurnSection(el);
    return (
      turnSection?.getAttribute("data-turn") === "user" ||
      Boolean(turnSection?.querySelector?.('[data-message-author-role="user"]'))
    );
  },

  extractUserText(el) {
    const turnSection = resolveTurnSection(el);
    const userNode = resolveUserNode(turnSection);
    if (!turnSection || !userNode) return null;

    const node = userNode.querySelector?.(".whitespace-pre-wrap") || 
                 userNode.querySelector?.('[data-testid="collapsible-user-message-content"]') || 
                 userNode;
    let text = normalizeText(node.textContent || node.innerText || "");
    if (!text) {
      text = normalizeText(userNode.textContent || userNode.innerText || "");
    }
    if (!text) return null;

    // Always key off data-message-id as the unique identifier.
    const messageId = resolveMessageId(userNode, "user") || resolveMessageId(turnSection, "user");
    return { text, domId: messageId || null };
  },

  extractAssistantAnchors(el, index) {
    const turnSection = resolveTurnSection(el);
    const assistantNode = resolveAssistantNode(turnSection);
    if (!turnSection || !assistantNode) return [];

    const container = assistantNode.querySelector?.(".standard-markdown") || assistantNode;

    // Always key off data-message-id as the unique identifier.
    const messageId =
      resolveMessageId(assistantNode, "assistant") ||
      resolveMessageId(turnSection, "assistant");
    if (!messageId) return [];

    const headings = Array.from(container.querySelectorAll("h1, h2, h3")).filter(
      (h) => !h.closest("pre")
    );

    if (headings.length > 0) {
      return headings.map((h, idx) => {
        const stableId = `tl-anchor-${messageId}-h${idx}`;
        if (h.id !== stableId) h.id = stableId;
        const label = h.textContent.trim();
        return {
          id: stableId,
          label,
          element: h,
          fallback: {
            sectionId: messageId,
            headingIndex: idx,
            headingText: label,
            isParagraph: false,
            containerSelector: '[data-message-author-role="assistant"]',
          },
        };
      });
    }

    const paragraphs = container.querySelectorAll("p");
    for (const p of paragraphs) {
      const text = normalizeText(p.textContent || p.innerText || "");
      if (text.length > 10) {
        const stableId = `tl-anchor-${messageId}-p0`;
        if (p.id !== stableId) p.id = stableId;

        // While a reply streams in, paragraph text keeps changing. Letting the label follow it
        // would re-render the side panel on every tick, so freeze the label after the first read.
        const frozenLabel =
          p.dataset.tlAnchorLabel || smartTruncate(text, 40);
        if (!p.dataset.tlAnchorLabel) p.dataset.tlAnchorLabel = frozenLabel;

        return [{
          id: stableId,
          label: frozenLabel,
          element: p,
          fallback: {
            sectionId: messageId,
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
