import { createLogger } from "../utils/logger.js";

const logger = createLogger("Adapter.Claude");

/**
 * Claude.ai DOM contract, verified against the live page (2026-10):
 * - Every message lives in a virtualized `transcript-row`; `data-index` is the message's
 *   position in the current branch (0-based, counting both roles). Offscreen rows are removed
 *   from the DOM and replaced by a `transcript-spacer`, so only a handful are mounted at once.
 * - Human rows carry `[data-turn-key]` equal to the message uuid from the conversation API.
 * - Assistant replies are `[data-testid="assistant-message"]` (the old `.font-claude-response`
 *   class is kept as a fallback). Each one starts with a visually hidden
 *   "Claude responded: …" <h2>, so headings are only taken from inside `.standard-markdown`.
 */
export const CLAUDE_SELECTORS = {
  row: '[data-testid="transcript-row"]',
  user: '[data-testid="user-message"]',
  assistant: '[data-testid="assistant-message"], .font-claude-response',
  heading: ".standard-markdown h1, .standard-markdown h2, .standard-markdown h3",
  turnKey: "[data-turn-key]",
};

const SECTION_PREFIX = "tl-claude-";

function smartTruncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.6) return truncated.slice(0, lastSpace) + "…";
  return truncated + "…";
}

/** Section id for the message at branch position `pos`; also the user anchor's id. */
export function claudeSectionId(pos) {
  return `${SECTION_PREFIX}${pos}`;
}

/** Inverse of claudeSectionId; returns null for ids from other platforms. */
export function parseClaudeSectionPos(sectionId) {
  const m = String(sectionId || "").match(/^tl-claude-(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Mounted transcript rows, keyed by their data-index. */
export function getClaudeRows() {
  const rows = new Map();
  document.querySelectorAll(CLAUDE_SELECTORS.row).forEach((row) => {
    const idx = Number(row.dataset.index);
    if (Number.isInteger(idx)) rows.set(idx, row);
  });
  return rows;
}

/** The human message uuid of a row, or null for assistant rows. */
export function getClaudeRowUserUuid(row) {
  if (!row?.querySelector?.(CLAUDE_SELECTORS.user)) return null;
  return row.querySelector(CLAUDE_SELECTORS.turnKey)?.dataset.turnKey || null;
}

/**
 * User text without the buttons we inject into the bubble. Plain messages render one
 * .whitespace-pre-wrap per paragraph; code-only messages have none.
 */
export function extractClaudeUserText(el) {
  const parts = Array.from(el.querySelectorAll(".whitespace-pre-wrap"))
    .filter((node) => !node.closest(".tl-msg-actions"))
    .map((node) => node.textContent.trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join("\n");
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".tl-msg-actions").forEach((node) => node.remove());
  return clone.textContent.trim();
}

/** Headings of a rendered assistant reply, or its first meaningful paragraph. */
export function extractClaudeAssistantAnchors(el) {
  const headings = Array.from(el.querySelectorAll(CLAUDE_SELECTORS.heading)).filter(
    (h) => !h.closest("pre")
  );
  if (headings.length > 0) {
    return headings.map((h, headingIndex) => ({
      label: h.textContent.trim(),
      headingIndex,
      isParagraph: false,
      element: h,
    }));
  }
  for (const p of el.querySelectorAll("p")) {
    const text = p.textContent.trim();
    if (text.length > 10) {
      return [{ label: smartTruncate(text, 40), headingIndex: 0, isParagraph: true, element: p }];
    }
  }
  return [];
}

/** Anchor id for the n-th heading (or the paragraph fallback) of the message at `sectionId`. */
export function claudeAnchorId(sectionId, anchor) {
  return `tl-anchor-${sectionId}-${anchor.isParagraph ? "p0" : `h${anchor.headingIndex}`}`;
}

export const claudeAdapter = {
  id: "claude",
  turnSelector: null,
  containerSelector: null,
  // A row mounting, or a heading appearing in a streaming reply, triggers a reparse.
  messageSelectors: [
    CLAUDE_SELECTORS.row,
    CLAUDE_SELECTORS.user,
    CLAUDE_SELECTORS.assistant,
    CLAUDE_SELECTORS.heading,
  ],
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
    return Array.from(document.querySelectorAll(CLAUDE_SELECTORS.user));
  },
};

/**
 * Parse the mounted messages only. Used on its own when the conversation API is unavailable,
 * and for messages newer than the last API fetch (e.g. a reply that is still streaming).
 *
 * Each message is keyed by its branch position: the row's data-index plus `indexOffset`
 * (non-zero while Claude has only paged in the tail of a long conversation). Outside a
 * transcript row the DOM order is used instead.
 */
export function parseClaude({ indexOffset = 0 } = {}) {
  const messageEls = Array.from(
    document.querySelectorAll(`${CLAUDE_SELECTORS.user}, ${CLAUDE_SELECTORS.assistant}`)
  ).filter((el) => !el.parentElement?.closest(CLAUDE_SELECTORS.assistant));

  const result = [];
  messageEls.forEach((el, ordinal) => {
    const row = el.closest(CLAUDE_SELECTORS.row);
    const rowIndex = Number(row?.dataset.index);
    const pos = Number.isInteger(rowIndex) ? rowIndex + indexOffset : ordinal;
    const sectionId = claudeSectionId(pos);

    if (el.matches(CLAUDE_SELECTORS.user)) {
      const text = extractClaudeUserText(el);
      if (!text) return;
      result.push({ id: sectionId, pos, role: "user", text, element: el });
      return;
    }

    const anchors = extractClaudeAssistantAnchors(el).map((anchor) => ({
      id: claudeAnchorId(sectionId, anchor),
      label: anchor.label,
      element: anchor.element,
      fallback: {
        sectionId,
        headingIndex: anchor.headingIndex,
        headingText: anchor.isParagraph ? null : anchor.label,
        isParagraph: anchor.isParagraph,
        headingSelector: CLAUDE_SELECTORS.heading,
      },
    }));
    if (anchors.length === 0) return;
    result.push({ id: sectionId, pos, role: "assistant", anchors });
  });

  return result;
}
