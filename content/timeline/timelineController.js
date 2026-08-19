import { createLogger } from "../utils/logger.js";
import { MESSAGE_TYPES } from "../utils/constants.js";
import { buildTimelineFromParsed } from "./parser.js";
import { parseClaude } from "../adapters/claudeAdapter.js";
import { createAnchorManager } from "./anchorManager.js";
import { createScrollTracker } from "./scrollTracker.js";
import { createScrollEngine } from "./scrollEngine.js";
import { estimateContextStats } from "./tokenEstimator.js";

/**
 * Timeline controller: orchestrate adapter + parser + anchor/scroll modules.
 * Does NOT contain platform-specific selectors and does NOT render side panel UI.
 */
export function createTimelineController({ adapter, store }) {
  const logger = createLogger("Timeline");

  // anchorManager: a pure resolver, anchorId -> the live node.
  const anchorManager = createAnchorManager();

  // scrollEngine: the single scrolling authority -- generic container detection, arithmetic
  // positioning, two-phase mounting, rAF calibration, and re-pinning while a reply streams.
  // resolveElement re-queries the live node every time; locatePlaceholder returns the
  // placeholder turn when the target has been virtualized, so it can be scrolled in to mount.
  const scrollEngine = createScrollEngine({
    resolveElement: (anchorId) => anchorManager.getElement(anchorId),
    locatePlaceholder: (anchorId) =>
      locateSectionByMessageId(anchorManager.deriveMessageId(anchorId)),
  });

  let observer = null;
  let extensionInvalidated = false;

  function isContextInvalidatedError(err) {
    const msg = String(err?.message || err || "");
    return msg.includes("Extension context invalidated");
  }

  function handleContextInvalidated(err) {
    if (extensionInvalidated) return;
    extensionInvalidated = true;
    logger.warn("Extension context invalidated, stopping timeline controller", err);
    scrollEngine.cancel();
    stopMutationObserver();
    scrollTracker.stop();
  }

  function safeSendRuntimeMessage(message) {
    if (extensionInvalidated) return;
    try {
      const runtime = chrome?.runtime;
      if (!runtime?.sendMessage) return;
      const p = runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        handleContextInvalidated(err);
        return;
      }
    }
  }

  const scrollTracker = createScrollTracker({
    onAnchorVisible: (anchorId) => {
      store.setState({ activeAnchorId: anchorId });
      safeSendRuntimeMessage({ type: MESSAGE_TYPES.ANCHOR_VISIBLE, anchorId });
    },
  });

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function computeContextStats() {
    const messageEls = adapter.id === "claude"
      ? document.querySelectorAll('div[data-testid="user-message"], div.font-claude-response')
      : document.querySelectorAll("[data-message-author-role]");
    return estimateContextStats(messageEls, adapter.id);
  }

  function createMessageStore() {
    const state = {
      conversationId: null,
      currentNodeId: null,
      messages: new Map(),
      order: [],
      domOrder: [],
      alias: new Map(),
      pending: new Set(),
    };

    function reset(conversationId = null, currentNodeId = null) {
      state.conversationId = conversationId || null;
      state.currentNodeId = currentNodeId || null;
      state.messages.clear();
      state.order = [];
      state.domOrder = [];
      state.alias.clear();
      state.pending.clear();
    }

    function setConversationId(conversationId) {
      state.conversationId = conversationId || null;
    }

    function setCurrentNodeId(currentNodeId) {
      state.currentNodeId = currentNodeId || null;
    }

    function upsertMessage(next) {
      if (!next?.id) return;
      const existing = state.messages.get(next.id);
      const merged = {
        id: next.id,
        role: next.role || existing?.role,
        text: next.text ?? existing?.text ?? "",
        anchors:
          Array.isArray(next.anchors) && next.anchors.length > 0
            ? next.anchors
            : existing?.anchors || [],
        element: next.element || existing?.element || null,
        parentId: next.parentId || existing?.parentId || null,
        status: next.status || existing?.status || null,
      };
      state.messages.set(next.id, merged);
    }

    function setOrder(order) {
      state.order = Array.isArray(order) ? order.slice() : [];
    }

    function setDomOrder(order) {
      state.domOrder = Array.isArray(order) ? order.slice() : [];
    }

    function getOrder() {
      if (state.order.length === 0) return state.domOrder;
      // The fetch order only covers history. Messages that appeared since then exist only in
      // domOrder, so append them at the end.
      if (state.domOrder.length === 0) return state.order;
      const inFetchOrder = new Set(state.order);
      const extras = state.domOrder.filter(id => !inFetchOrder.has(id));
      return extras.length > 0 ? [...state.order, ...extras] : state.order;
    }

    function hasFetchOrder() {
      return state.order.length > 0;
    }

    function getDomOrder() {
      return state.domOrder.slice();
    }

    return {
      state,
      reset,
      setConversationId,
      setCurrentNodeId,
      upsertMessage,
      setOrder,
      setDomOrder,
      getOrder,
      getDomOrder,
      hasFetchOrder,
    };
  }

  let lastEmittedFingerprint = null;

  const messageStore = createMessageStore();
  let scrollLoadComplete = false;
  let lastScrolledPath = null;
  let isScrolling = false;
  // Reparse gate. During a programmatic jump from a side-panel click, mounting and unmounting
  // floods the MutationObserver. Running a reparse then -- rebuilding the IntersectionObserver
  // and re-extracting every heading -- piles work onto the exact frames where the page is
  // already struggling to mount heavy turns, making the stutter worse. So suspend reparse
  // while jumping and parse exactly once after it settles.
  let suppressReparse = false;
  let lastSeenPathname = window.location.pathname;
  const scrollLoadOrderMap = new Map();

  function resetConversationState(nextKey, currentNodeId = null) {
    scrollEngine.cancel(); // Invalidate any jump still running in the previous conversation
    messageStore.reset(nextKey || null, currentNodeId || null);
    scrollLoadComplete = false;
    lastScrolledPath = null;
    scrollLoadOrderMap.clear();
    lastEmittedFingerprint = null;
    lastSeenPathname = window.location.pathname;
  }

  function ensureConversationByPath() {
    const currentPath = window.location.pathname;
    if (currentPath !== lastSeenPathname) {
      resetConversationState(currentPath);
      lastSeenPathname = currentPath;
    }
  }

  function getConversationKeyFromDetail(detail) {
    return detail?.conversationId || window.location.pathname;
  }

  function normalizeDomAnchors(messageId, anchors) {
    if (!messageId || !Array.isArray(anchors)) return anchors || [];
    return anchors.map((anchor, idx) => {
      const isParagraph = Boolean(anchor?.fallback?.isParagraph);
      const headingIndex = Number.isFinite(anchor?.fallback?.headingIndex)
        ? anchor.fallback.headingIndex
        : idx;
      // Preserve heading text for text-based re-lookup after rerenders.
      const headingText = anchor?.fallback?.headingText || anchor?.label || null;
      const suffix = isParagraph ? "p0" : `h${headingIndex}`;
      const id = `tl-anchor-${messageId}-${suffix}`;
      if (anchor?.element && anchor.element.id !== id) anchor.element.id = id;
      return {
        ...anchor,
        id,
        fallback: {
          ...anchor.fallback,
          sectionId: messageId,
          headingIndex,
          headingText,
          isParagraph,
        },
      };
    });
  }

  function mergeAnchorElements(messageId, anchors) {
    const existing = messageStore.state.messages.get(messageId);
    if (!existing?.anchors?.length || !Array.isArray(anchors)) return anchors || [];
    const byId = new Map(existing.anchors.map((anchor) => [anchor.id, anchor]));
    anchors.forEach((anchor) => {
      const target = byId.get(anchor.id);
      if (target && anchor.element) target.element = anchor.element;
    });
    return existing.anchors;
  }

  function upsertUserFromDom(turn) {
    const extracted = adapter.extractUserText(turn);
    const messageId = getTurnMessageId(turn);
    if (!messageId || !extracted?.text) return null;
    const existing = messageStore.state.messages.get(messageId);
    const text = existing?.text || extracted.text;
    turn.dataset.tlMessageId = messageId;
    messageStore.upsertMessage({
      id: messageId,
      role: "user",
      text,
      element: turn,
    });
    return messageId;
  }

  function upsertAssistantFromDom(turn, index) {
    const messageId = getTurnMessageId(turn);
    if (!messageId) return null;
    const rawAnchors = adapter.extractAssistantAnchors(turn, index);
    const anchors = mergeAnchorElements(
      messageId,
      normalizeDomAnchors(messageId, rawAnchors)
    );
    turn.dataset.tlMessageId = messageId;
    messageStore.upsertMessage({
      id: messageId,
      role: "assistant",
      anchors,
      element: turn,
    });
    return messageId;
  }

  function updateDomCache({ appendOnly = false } = {}) {
    const scope = adapter.containerSelector
      ? document.querySelector(adapter.containerSelector) || document
      : document;
    const turnEls = collectChatgptTurnElements(scope);
    const order = appendOnly ? messageStore.getDomOrder() : [];
    const seen = new Set(order);

    turnEls.forEach((turn, index) => {
      const messageId = getTurnMessageId(turn);
      if (!messageId) return;
      if (adapter.isUserTurn(turn)) {
        upsertUserFromDom(turn);
      } else {
        upsertAssistantFromDom(turn, index);
      }

      if (!seen.has(messageId)) {
        order.push(messageId);
        seen.add(messageId);
      }
    });

    messageStore.setDomOrder(order);
  }

  function buildParsedFromStore() {
    const parsed = [];
    const orderedIds = messageStore.getOrder();
    orderedIds.forEach((id) => {
      const msg = messageStore.state.messages.get(id);
      if (!msg?.role) return;
      if (msg.role === "user") {
        if (!msg.text) return;
        parsed.push({ id, role: "user", text: msg.text, element: msg.element || null });
      } else if (msg.role === "assistant") {
        if (!Array.isArray(msg.anchors) || msg.anchors.length === 0) return;
        parsed.push({ role: "assistant", anchors: msg.anchors });
      }
    });
    return parsed;
  }

  // The real scroll container: walk up from a representative message to the first genuinely
  // scrollable ancestor. This works on both platforms -- measured, ChatGPT resolves to a
  // [scrollbar-gutter] div and Claude to a [scrollbar-gutter:stable] div, neither of which is
  // window. It avoids guessing from class names and skips unrelated nested scroll containers
  // such as the sidebar.
  function getConversationScrollContainer() {
    const probe =
      document.querySelector('[data-message-author-role]') ||
      document.querySelector('div[data-testid="user-message"]') ||
      document.querySelector("div.font-claude-response");
    if (probe) return scrollEngine.findScrollableAncestor(probe);
    return document.scrollingElement || document.documentElement;
  }

  // Scroll from top to bottom to force ChatGPT to render every section,
  // snapshot caches at each position, then restore scroll and build the full timeline.
  async function scrollLoadAllSections() {
    if (isScrolling) return;
    if (suppressReparse) return;
    // Once the fetch interceptor has the full conversation, scroll-load is only a fallback.
    if (messageStore.hasFetchOrder()) return;
    ensureConversationByPath();
    const currentPath = window.location.pathname;
    if (currentPath === lastScrolledPath) return;

    const mainEl = getConversationScrollContainer();
    if (!mainEl || mainEl.scrollHeight <= mainEl.clientHeight + 100) {
      // Page not ready yet — don't mark done so retries can proceed
      return;
    }

    isScrolling = true;
    scrollLoadOrderMap.clear();
    messageStore.setDomOrder([]);
    scrollLoadComplete = false;

    const savedTop = mainEl.scrollTop;
    const step = Math.max(mainEl.clientHeight * 0.85, 400);

    if (suppressReparse) {
      isScrolling = false;
      return;
    }
    mainEl.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 200));

    // The fetch interceptor landed mid scroll-load: yield immediately and abandon this scan,
    // otherwise scroll-load keeps writing the DOM cache and overwrites the order and anchors
    // the fetch just populated.
    const bailIfFetched = () => {
      if (!messageStore.hasFetchOrder()) return false;
      mainEl.scrollTop = savedTop;
      isScrolling = false;
      logger.debug("scroll-load aborted: fetch data arrived mid-scroll");
      return true;
    };
    const bailIfProgrammaticJump = () => {
      if (!suppressReparse) return false;
      isScrolling = false;
      logger.debug("scroll-load aborted: programmatic jump in progress");
      return true;
    };

    const captureScrollLoadSnapshot = () => {
      const scope = document.querySelector(adapter.containerSelector) || document;
      collectChatgptTurnElements(scope).forEach((turn, idx) => {
        const messageId = getTurnMessageId(turn);
        if (!messageId) return;
        if (adapter.isUserTurn(turn)) {
          upsertUserFromDom(turn);
        } else {
          upsertAssistantFromDom(turn, idx);
        }

        const turnIndex = getChatgptTurnIndex(turn);
        if (Number.isFinite(turnIndex) && !scrollLoadOrderMap.has(turnIndex)) {
          scrollLoadOrderMap.set(turnIndex, messageId);
        }
      });
    };

    let safety = 0;
    while (
      mainEl.scrollTop + mainEl.clientHeight < mainEl.scrollHeight - 30 &&
      safety < 300
    ) {
      if (bailIfProgrammaticJump()) return;
      if (bailIfFetched()) return;
      captureScrollLoadSnapshot();
      mainEl.scrollTop += step;
      await new Promise((r) => setTimeout(r, 100));
      if (bailIfProgrammaticJump()) return;
      safety++;
    }
    if (bailIfProgrammaticJump()) return;
    if (bailIfFetched()) return;
    captureScrollLoadSnapshot();

    mainEl.scrollTop = savedTop;
    isScrolling = false;
    lastScrolledPath = currentPath;

    const ordered = Array.from(scrollLoadOrderMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
    if (ordered.length > 0) {
      messageStore.setDomOrder(ordered);
      updateDomCache({ appendOnly: true });
      scrollLoadComplete = true;
    } else {
      updateDomCache({ appendOnly: false });
      scrollLoadComplete = messageStore.getOrder().length > 0;
    }

    logger.debug(
      `scroll-load done: ${ordered.length} turns in order (${safety} steps)`
    );
    reparseNow();
  }

  function fingerprintTimeline(timelineData) {
    if (!Array.isArray(timelineData)) return "";
    return timelineData
      .map((t) => {
        const anchors = Array.isArray(t?.assistantAnchors) ? t.assistantAnchors : [];
        const a = anchors.map((x) => `${x?.id || ""}:${x?.label || ""}`).join("|");
        return `${t?.id || ""}::${t?.userText || ""}::${a}`;
      })
      .join("\n");
  }

  function emitTimelineUpdate(timelineData) {
    const fp = fingerprintTimeline(timelineData);
    const contextStats = computeContextStats();
    const contextFp = [
      contextStats.estimatedTokens || 0,
      contextStats.messageCount || 0,
      contextStats.largestMessageTokens || 0,
      contextStats.density || "",
    ].join(":");
    const combinedFp = `${fp}\nctx:${contextFp}`;
    if (combinedFp && combinedFp === lastEmittedFingerprint) return;
    lastEmittedFingerprint = combinedFp;

    safeSendRuntimeMessage({
      type: MESSAGE_TYPES.TIMELINE_UPDATE,
      payload: timelineData,
      url: window.location.href,
      contextStats,
    });
  }

  function compareDomOrder(a, b) {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function getChatgptTurnIndex(el) {
    const testid = el?.getAttribute?.("data-testid") || "";
    const match = testid.match(/conversation-turn-(\d+)/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  }

  function collectChatgptTurnElements(scope) {
    const turns = Array.from(scope.querySelectorAll(adapter.turnSelector || ""));
    turns.sort((a, b) => {
      const aIndex = getChatgptTurnIndex(a);
      const bIndex = getChatgptTurnIndex(b);
      if (Number.isFinite(aIndex) && Number.isFinite(bIndex) && aIndex !== bIndex) return aIndex - bIndex;
      if (Number.isFinite(aIndex) && !Number.isFinite(bIndex)) return -1;
      if (!Number.isFinite(aIndex) && Number.isFinite(bIndex)) return 1;
      return compareDomOrder(a, b);
    });
    return turns;
  }

  // Locate the turn <section> a message belongs to, keyed by its stable message id.
  // ChatGPT unmounts the contents of offscreen turns (their height drops to zero) but keeps
  // the section placeholder, so even a virtualized message still resolves to a placeholder
  // section that anchorManager can scroll into view to trigger the mount.
  function locateSectionByMessageId(messageId) {
    if (!messageId) return null;
    if (adapter.id !== "chatgpt") {
      // Other platforms: find the nearest turn container from the mounted message node.
      const mounted = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      return mounted?.closest?.(adapter.turnSelector || "*") || mounted || null;
    }

    // 1) Mounted: walk up from the real message node to its section (most accurate).
    const mounted = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (mounted) return mounted.closest(adapter.turnSelector) || mounted;

    // 2) Virtualized: map the conversation-order index onto conversation-turn-{n}
    //    (the testid is contiguous and 1-based).
    const order = messageStore.getOrder();
    const idx = order.indexOf(messageId);
    if (idx < 0) {
      logger.warn("locateSectionByMessageId: id not in order, cannot locate placeholder", messageId);
      return null;
    }

    const scope = adapter.containerSelector
      ? document.querySelector(adapter.containerSelector) || document
      : document;
    const turns = collectChatgptTurnElements(scope);

    // Prefer an exact testid match (index + 1); otherwise fall back to the idx-th in DOM order.
    const byTestid = turns.find((t) => getChatgptTurnIndex(t) === idx + 1);
    if (byTestid) return byTestid;

    if (turns[idx]) {
      logger.debug("locateSectionByMessageId: matched by positional index", idx, "for", messageId);
      return turns[idx];
    }

    logger.warn("locateSectionByMessageId: no section found for", messageId, "idx", idx);
    return null;
  }

  function getFallbackText(node) {
    if (!node?.textContent) return "";
    return node.textContent.replace(/\s+/g, " ").trim();
  }

  function buildAnchorsFromText(messageId, text) {
    const headings = extractHeadingsFromMarkdown(text);
    if (headings.length > 0) {
      return headings.map((label, idx) => ({
        id: `tl-anchor-${messageId}-h${idx}`,
        label,
        fallback: {
          sectionId: messageId,
          headingIndex: idx,
          headingText: label,
          isParagraph: false,
          containerSelector: '[data-message-author-role="assistant"]',
        },
      }));
    }

    const label = firstParagraphLabel(text);
    if (!label) return [];
    return [{
      id: `tl-anchor-${messageId}-p0`,
      label,
      fallback: {
        sectionId: messageId,
        headingIndex: 0,
        isParagraph: true,
        containerSelector: '[data-message-author-role="assistant"]',
      },
    }];
  }

  // Receive the full message list from the fetch interceptor, rebuild the message-id-keyed
  // cache, and re-parse.
  function ingestFetchedPayload(detail) {
    if (extensionInvalidated) return;
    const messages = detail?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    try {
      const conversationKey = getConversationKeyFromDetail(detail);
      const currentNodeId = detail?.currentNodeId || null;
      if (conversationKey && conversationKey !== messageStore.state.conversationId) {
        resetConversationState(conversationKey, currentNodeId);
        messageStore.setConversationId(conversationKey);
      } else if (currentNodeId && currentNodeId !== messageStore.state.currentNodeId) {
        messageStore.setCurrentNodeId(currentNodeId);
        lastEmittedFingerprint = null;
      }

      const order = [];
      messages.forEach((msg) => {
        if (!msg?.id || !msg.role) return;
        const text = String(msg.text || "").trim();
        if (!text) return;
        if (msg.role === "user") {
          messageStore.upsertMessage({
            id: msg.id,
            role: "user",
            text,
            parentId: msg.parentId || null,
          });
          order.push(msg.id);
          return;
        }
        if (msg.role === "assistant") {
          const anchors = buildAnchorsFromText(msg.id, text);
          messageStore.upsertMessage({
            id: msg.id,
            role: "assistant",
            text,
            anchors,
            parentId: msg.parentId || null,
          });
          order.push(msg.id);
        }
      });

      messageStore.setOrder(order);
      logger.debug(
        `[FetchInterceptor] ingested ${messages.length} messages ` +
        `(${order.length} turns in order)`
      );
      reparseNow();
    } catch (err) {
      logger.warn("ingestFetchedPayload failed, keeping DOM parse", err);
    }
  }

  // The id on a [data-message-id] node inside a turn -- the same identifier space as the API's node id.
  function getTurnMessageId(turn) {
    const node = turn?.querySelector?.(
      '[data-message-id][data-message-author-role="user"], ' +
      '[data-message-id][data-message-author-role="assistant"], ' +
      "[data-message-id]"
    );
    return node?.getAttribute?.("data-message-id") || null;
  }

  // Extract h1-h3 headings from an assistant reply's markdown text, skipping ``` code blocks.
  function extractHeadingsFromMarkdown(text) {
    const headings = [];
    let inFence = false;
    String(text || "").split("\n").forEach((line) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      const m = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
      if (m) headings.push(m[2].trim());
    });
    return headings;
  }

  // With no headings, use the first meaningful paragraph as the label of a single anchor,
  // matching the DOM adapter's behaviour.
  function firstParagraphLabel(text) {
    let inFence = false;
    const lines = String(text || "").split("\n");
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const t = line.replace(/[#>*_`~-]/g, " ").replace(/\s+/g, " ").trim();
      if (t.length > 10) return t.length > 40 ? t.slice(0, 39) + "…" : t;
    }
    return "";
  }


  function parseConversation() {
    ensureConversationByPath();
    const appendOnly = messageStore.hasFetchOrder() || scrollLoadComplete;
    updateDomCache({ appendOnly });
    return buildParsedFromStore();
  }

  function reparseNow() {
    if (extensionInvalidated) return;
    const parsed = adapter.id === "claude" ? parseClaude() : parseConversation();
    const timelineData = buildTimelineFromParsed(parsed);
    store.setState({ timelineData });

    anchorManager.clear();
    parsed.forEach((item) => {
      if (item.role === "user" && item.element) {
        if (item.id) item.element.dataset.tlMessageId = item.id;
        anchorManager.register(item.id, item.element);
      } else if (item.role === "assistant") {
        (item.anchors || []).forEach((anchor) => {
          if (anchor.element) anchorManager.register(anchor.id, anchor.element);
          if (anchor.fallback) anchorManager.registerFallback(anchor.id, anchor.fallback);
        });
      }
    });

    emitTimelineUpdate(timelineData);

    // The IntersectionObserver root must be the real scroll container, not the layout
    // viewport, for the active-anchor decision to be accurate.
    const trackedEls = Array.from(document.querySelectorAll("[data-tl-anchor-id]"));
    const container = trackedEls.length ? scrollEngine.findScrollableAncestor(trackedEls[0]) : null;
    const root =
      container && container !== document.scrollingElement && container !== document.documentElement
        ? container
        : null;
    scrollTracker.start(trackedEls, { root });
    logger.debug("timeline reparsed:", timelineData.length);
  }

  function hasRelevantAddedNode(node, selectors) {
    if (!node || node.nodeType !== 1) return false;
    return selectors.some(
      (selector) => node.matches?.(selector) || node.querySelector?.(selector)
    );
  }

  function hasNewMessage(mutations, selectors) {
    return mutations.some((mutation) =>
      Array.from(mutation.addedNodes || []).some((node) => hasRelevantAddedNode(node, selectors))
    );
  }

  function startMutationObserver() {
    const selectors =
      Array.isArray(adapter.messageSelectors) && adapter.messageSelectors.length > 0
        ? adapter.messageSelectors
        : [];
    const container = adapter.containerSelector
      ? document.querySelector(adapter.containerSelector)
      : null;
    if (adapter.containerSelector && !container) {
      logger.warn("container not found, falling back to body");
    }

    const target = adapter.id === "claude" ? document.body : container || document.body;
    const debouncedParse = debounce(reparseNow, 800);
    const isChatgpt = adapter.id === "chatgpt";

    observer = new MutationObserver((mutations) => {
      if (extensionInvalidated) return;
      // A programmatic jump is in flight: ignore the mount/unmount mutations it causes so we
      // do not re-parse while scrolling.
      if (suppressReparse) return;
      const relevantChange = isChatgpt
        ? true
        : selectors.length === 0
          ? true
          : hasNewMessage(mutations, selectors);
      if (!relevantChange) return;
      debouncedParse();
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: isChatgpt,
    });

    if (adapter.id === "claude") {
      logger.info("Claude MutationObserver started");
    } else {
      logger.info("MutationObserver started");
    }
  }

  function stopMutationObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function onMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === MESSAGE_TYPES.SCROLL_TO_ANCHOR) {
      // scrollEngine already handles virtualized mounting, re-querying after a re-render, and
      // settle correction, so no external retry is needed. While the jump runs:
      // - suppressReparse is raised, so a reparse triggered by mount mutations does not compete
      //   with the page's own mounting for the same frames;
      // - scrollTracker.lock() prevents anchors scrolled past from being reported as active.
      // Once settled: lower the gate, parse exactly once, and unlock with the target id.
      suppressReparse = true;
      scrollTracker.lock();
      scrollEngine
        .scrollToAnchor(message.anchorId)
        .then((ok) => {
          if (!ok) logger.warn("scroll-to-anchor failed:", message.anchorId);
        })
        .catch((err) => logger.warn("scroll-to-anchor error:", message.anchorId, err))
        .finally(() => {
          suppressReparse = false;
          reparseNow();
          scrollTracker.unlock(message.anchorId);
        });
    }

    if (message.type === MESSAGE_TYPES.REPARSE_NOW) {
      lastEmittedFingerprint = null;
      if (adapter.id === "chatgpt") {
        scrollLoadAllSections();
      }
      reparseNow();
    }
  }

  function onConversationFetched(e) {
    try {
      ingestFetchedPayload(e?.detail);
    } catch (err) {
      logger.warn("onConversationFetched failed", err);
    }
  }

  function start() {
    chrome.runtime.onMessage.addListener(onMessage);
    reparseNow();

    if (adapter.id === "chatgpt") {
      // Listen for the full conversation from the MAIN-world interceptor.
      window.addEventListener("chatgpt-conversation-fetched", onConversationFetched);
      // The interceptor runs at document_start, likely before this listener exists, so ask it
      // to replay the first screen.
      try {
        window.dispatchEvent(new CustomEvent("chatgpt-conversation-request"));
      } catch (err) {}

      // scroll-load is the fallback: it bails on its own before the page is ready, and is
      // skipped entirely once a fetch order exists.
      scrollLoadAllSections();
      setTimeout(scrollLoadAllSections, 900);
      setTimeout(scrollLoadAllSections, 2200);
      setTimeout(scrollLoadAllSections, 5200);
    }

    if (adapter.id === "claude") {
      // Claude's React render can finish after document_idle, so the initial parse may find
      // nothing. A delayed re-parse ensures the timeline updates once the conversation appears.
      setTimeout(reparseNow, 1000);
      setTimeout(reparseNow, 2500);
    }

    startMutationObserver();
    logger.info("timeline controller started");
  }

  function stop() {
    scrollEngine.cancel();
    stopMutationObserver();
    scrollTracker.stop();
    window.removeEventListener("chatgpt-conversation-fetched", onConversationFetched);
    logger.info("timeline controller stopped");
  }

  return {
    start,
    stop,
    reparseNow,
  };
}
