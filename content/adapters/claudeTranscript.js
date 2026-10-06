import { createLogger } from "../utils/logger.js";
import { extractHeadingsFromMarkdown, firstParagraphLabel } from "../timeline/parser.js";
import {
  CLAUDE_SELECTORS,
  claudeAnchorId,
  claudeSectionId,
  getClaudeRowUserUuid,
  getClaudeRows,
  parseClaude,
  parseClaudeSectionPos,
} from "./claudeAdapter.js";
import { createClaudeConversationApi, getClaudeConversationId } from "./claudeConversationApi.js";

/**
 * Claude transcript model: the full conversation (from the API) mapped onto Claude's
 * virtualized transcript rows (in the DOM).
 *
 * Every message is identified by its branch position. A mounted row's position is its
 * data-index plus an offset, because while Claude has only paged in the tail of a long
 * conversation, data-index counts from the first loaded message rather than the first one.
 * Does NOT scroll on its own or render the side panel.
 */
export function createClaudeTranscript({ api = createClaudeConversationApi() } = {}) {
  const logger = createLogger("ClaudeTranscript");
  const REFRESH_MIN_INTERVAL_MS = 1500;

  let conversationId = null;
  let branch = null;           // [{ uuid, role, text }] from the API, or null
  let uuidToPos = new Map();
  let inFlight = null;
  let lastFetchAt = 0;
  let refreshTimer = null;

  function setBranch(next) {
    branch = Array.isArray(next) && next.length > 0 ? next : null;
    uuidToPos = new Map((branch || []).map((m, pos) => [m.uuid, pos]));
  }

  /** Switch conversations. Returns true when the conversation actually changed. */
  function syncConversation(pathname) {
    const nextId = getClaudeConversationId(pathname);
    if (nextId === conversationId) return false;
    conversationId = nextId;
    setBranch(null);
    clearTimeout(refreshTimer);
    lastFetchAt = 0;
    return true;
  }

  /** Fetch the current branch. Resolves to true when new data was stored. */
  function refresh() {
    if (!conversationId) return Promise.resolve(false);
    if (inFlight) return inFlight;
    const requestedId = conversationId;
    lastFetchAt = Date.now();
    inFlight = api
      .fetchBranch(requestedId)
      .then((next) => {
        if (requestedId !== conversationId || !next) return false;
        setBranch(next);
        logger.debug(`fetched ${next.length} messages`);
        return true;
      })
      .catch((err) => {
        logger.warn("conversation fetch failed, using mounted messages only", err);
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** Refetch soon, e.g. after a new message appeared or a reply finished streaming. */
  function scheduleRefresh(onRefreshed) {
    clearTimeout(refreshTimer);
    const wait = Math.max(0, lastFetchAt + REFRESH_MIN_INTERVAL_MS - Date.now());
    refreshTimer = setTimeout(() => {
      refresh().then((changed) => {
        if (changed) onRefreshed?.();
      });
    }, wait);
  }

  /**
   * data-index -> branch position offset. A mounted human row whose uuid the API knows is
   * exact; otherwise assume Claude paged in the tail, so the last row is the last message.
   */
  function getIndexOffset(rows = getClaudeRows()) {
    if (!branch || rows.size === 0) return 0;
    for (const [idx, row] of rows) {
      const pos = uuidToPos.get(getClaudeRowUserUuid(row));
      if (Number.isInteger(pos)) return pos - idx;
    }
    const lastIdx = Math.max(...rows.keys());
    return Math.max(0, branch.length - 1 - lastIdx);
  }

  function getRowForSection(sectionId, rows = getClaudeRows()) {
    const pos = parseClaudeSectionPos(sectionId);
    if (pos === null) return null;
    return rows.get(pos - getIndexOffset(rows)) || null;
  }

  /** The node a section id resolves to: the user bubble for human rows, else the row. */
  function findSection(sectionId) {
    const row = getRowForSection(sectionId);
    return row?.querySelector(CLAUDE_SELECTORS.user) || row;
  }

  function buildAnchorsFromMarkdown(sectionId, text) {
    const headings = extractHeadingsFromMarkdown(text);
    const raw = headings.length > 0
      ? headings.map((label, headingIndex) => ({ label, headingIndex, isParagraph: false }))
      : [{ label: firstParagraphLabel(text), headingIndex: 0, isParagraph: true }];
    return raw
      .filter((a) => a.label)
      .map((anchor) => ({
        id: claudeAnchorId(sectionId, anchor),
        label: anchor.label,
        fallback: {
          sectionId,
          headingIndex: anchor.headingIndex,
          headingText: anchor.isParagraph ? null : anchor.label,
          isParagraph: anchor.isParagraph,
          headingSelector: CLAUDE_SELECTORS.heading,
        },
      }));
  }

  /**
   * Parsed items for the whole conversation: API messages first, then any mounted message
   * newer than the last fetch. `stale` is true when such newer messages exist.
   */
  function buildParsed() {
    const mounted = parseClaude({ indexOffset: getIndexOffset() });
    if (!branch) return { parsed: mounted, stale: false };

    const parsed = [];
    branch.forEach((message, pos) => {
      const sectionId = claudeSectionId(pos);
      if (message.role === "user") {
        if (message.text) parsed.push({ id: sectionId, pos, role: "user", text: message.text });
        return;
      }
      const anchors = buildAnchorsFromMarkdown(sectionId, message.text);
      if (anchors.length > 0) parsed.push({ id: sectionId, pos, role: "assistant", anchors });
    });

    const newer = mounted.filter((item) => item.pos >= branch.length);
    return { parsed: [...parsed, ...newer], stale: newer.length > 0 };
  }

  /**
   * Move `container` toward the row of an unmounted section so Claude mounts it. Called
   * repeatedly by the scroll engine; each call re-measures from the nearest mounted row, so
   * the estimate converges even though row heights vary. Returns false if it cannot help.
   */
  function seekSection(sectionId, container) {
    const pos = parseClaudeSectionPos(sectionId);
    const rows = getClaudeRows();
    if (pos === null || rows.size === 0 || !container) return false;

    const target = pos - getIndexOffset(rows);
    if (target < 0) {
      // Older than anything paged in: scrolling to the top makes Claude load the previous page.
      container.scrollTop = 0;
      return true;
    }

    let nearestIdx = null;
    rows.forEach((_, idx) => {
      if (nearestIdx === null || Math.abs(idx - target) < Math.abs(nearestIdx - target)) {
        nearestIdx = idx;
      }
    });
    const lastIdx = Math.max(...rows.keys());
    const avgRowHeight = container.scrollHeight / (lastIdx + 1);
    const rect = rows.get(nearestIdx).getBoundingClientRect();
    const containerTop = container.getBoundingClientRect().top;
    const delta = target < nearestIdx
      ? rect.top - containerTop - (nearestIdx - target) * avgRowHeight
      : rect.bottom - containerTop + (target - nearestIdx - 1) * avgRowHeight;
    container.scrollTop += delta;
    return true;
  }

  return {
    syncConversation,
    refresh,
    scheduleRefresh,
    buildParsed,
    findSection,
    seekSection,
    hasBranch: () => Boolean(branch),
    getBranch: () => branch,
  };
}
