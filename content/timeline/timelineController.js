import { createLogger } from "../utils/logger.js";
import { MESSAGE_TYPES } from "../utils/constants.js";
import { buildTimelineFromParsed } from "./parser.js";
import { parseClaude } from "../adapters/claudeAdapter.js";
import { createAnchorManager } from "./anchorManager.js";
import { createScrollTracker } from "./scrollTracker.js";
import { createScrollEngine } from "./scrollEngine.js";

/**
 * Timeline controller: orchestrate adapter + parser + anchor/scroll modules.
 * Does NOT contain platform-specific selectors and does NOT render side panel UI.
 */
export function createTimelineController({ adapter, store }) {
  const logger = createLogger("Timeline");

  // anchorManager：纯解析器，anchorId → 当前活节点。
  const anchorManager = createAnchorManager();

  // scrollEngine：唯一的滚动权威 —— 通用容器检测 + 算术定位 + 两阶段 + rAF 校准 + streaming 重钉。
  // resolveElement 每次重查活节点；locatePlaceholder 在目标被虚拟化时返回占位 turn 供滚入挂载。
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
    let totalChars = 0;
    if (adapter.id === "claude") {
      document
        .querySelectorAll('div[data-testid="user-message"], div.font-claude-response')
        .forEach((el) => { totalChars += el.textContent.length; });
    } else {
      document
        .querySelectorAll("[data-message-author-role]")
        .forEach((el) => { totalChars += el.textContent.length; });
    }
    return { estimatedChars: totalChars, platform: adapter.id };
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
      return state.order.length > 0 ? state.order : state.domOrder;
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
  // 跳转闸：side panel 点击触发的程序化跳转期间，挂载/卸载会狂刷 MutationObserver，
  // 若此时跑 reparse（重建 IntersectionObserver、重抽所有标题）会把工作砸在
  // 页面正吃力挂载重型 turn 的同一刻，加重卡顿。跳转中暂停 reparse，落定后只解析一次。
  let suppressReparse = false;
  let lastSeenPathname = window.location.pathname;
  const scrollLoadOrderMap = new Map();

  function resetConversationState(nextKey, currentNodeId = null) {
    scrollEngine.cancel(); // 作废上一对话里仍在进行的跳转
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

  // 真实滚动容器：从一条代表性消息向上 walk-up 找第一个真正可滚的祖先。
  // ChatGPT/Claude 通用（实测分别命中 [scrollbar-gutter] 与 [scrollbar-gutter:stable] 的 div，
  // 都不是 window），不再靠 class 名猜，也自动避开 sidebar 等无关嵌套滚动容器。
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
    // fetch 拦截已经拿到全量数据时，scroll-load 仅作为兜底，无需再跑。
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

    mainEl.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 200));

    // fetch 拦截在 scroll-load 进行中到达：立即让位并放弃本次扫描。
    // 否则 scroll-load 会继续写 DOM 缓存，覆盖 fetch 刚填好的顺序与锚点。
    const bailIfFetched = () => {
      if (!messageStore.hasFetchOrder()) return false;
      mainEl.scrollTop = savedTop;
      isScrolling = false;
      logger.debug("scroll-load aborted: fetch data arrived mid-scroll");
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
      if (bailIfFetched()) return;
      captureScrollLoadSnapshot();
      mainEl.scrollTop += step;
      await new Promise((r) => setTimeout(r, 100));
      safety++;
    }
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
    if (fp && fp === lastEmittedFingerprint) return;
    lastEmittedFingerprint = fp;

    safeSendRuntimeMessage({
      type: MESSAGE_TYPES.TIMELINE_UPDATE,
      payload: timelineData,
      url: window.location.href,
      contextStats: computeContextStats(),
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

  // 按稳定的 message id 定位它所属的 turn <section>。
  // ChatGPT 会卸载离屏 turn 的内容（高度归零）但保留 section 占位节点，
  // 所以即使消息被虚拟化，这里仍能返回占位 section 供 anchorManager 滚入触发挂载。
  function locateSectionByMessageId(messageId) {
    if (!messageId) return null;
    if (adapter.id !== "chatgpt") {
      // 其它平台：直接按已挂载的 message 节点找最近的 turn 容器。
      const mounted = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      return mounted?.closest?.(adapter.turnSelector || "*") || mounted || null;
    }

    // 1) 已挂载：用真实 message 节点回溯到 section（最准）。
    const mounted = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (mounted) return mounted.closest(adapter.turnSelector) || mounted;

    // 2) 被虚拟化：用会话顺序里的下标映射到 conversation-turn-{n}（testid 连续且 1-based）。
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

    // 优先按 testid 数字精确匹配（顺序下标 + 1）；否则退化到按 DOM 顺序取第 idx 个。
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

  // 接收 fetch 拦截送来的全量消息，重建以 message id 为 key 的缓存并重新解析。
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

  // turn 元素内 [data-message-id] 节点的 id —— 与 API 的 node id 同一套。
  function getTurnMessageId(turn) {
    const node = turn?.querySelector?.(
      '[data-message-id][data-message-author-role="user"], ' +
      '[data-message-id][data-message-author-role="assistant"], ' +
      "[data-message-id]"
    );
    return node?.getAttribute?.("data-message-id") || null;
  }

  // 从助手回复的 markdown 文本里抽取 h1~h3 标题（跳过 ``` 代码块）。
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

  // 无标题时，取第一段有意义的文字作为单个 anchor 的 label（与 DOM adapter 行为一致）。
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

    // IntersectionObserver 以真实滚动容器为 root（而非 layout viewport），高亮判定才准确。
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
      // 程序化跳转进行中：忽略跳转自身引发的挂载/卸载 mutation，避免边滚边重解析。
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
      // scrollEngine 自身已处理：虚拟化挂载 + 重渲染重查 + settle 纠偏，无需外部重试。
      // 跳转期间：
      // - suppressReparse 升闸，避免挂载 mutation 触发的 reparse 与页面挂载抢同一帧；
      // - scrollTracker.lock()，避免途经的 anchor 被 IntersectionObserver 误判为 active 而闪烁。
      // 落定后清闸、只解析一次、用目标 id 解锁高亮。
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
      // 监听 MAIN world 拦截器送来的全量对话。
      window.addEventListener("chatgpt-conversation-fetched", onConversationFetched);
      // 拦截器在 document_start 就跑了，可能早于此监听器；主动请求一次补发首屏数据。
      try {
        window.dispatchEvent(new CustomEvent("chatgpt-conversation-request"));
      } catch (err) {}

      // scroll-load 作为兜底，页面就绪前会自行 bail；已有 fetch 顺序时直接跳过。
      scrollLoadAllSections();
      setTimeout(scrollLoadAllSections, 900);
      setTimeout(scrollLoadAllSections, 2200);
      setTimeout(scrollLoadAllSections, 5200);
    }

    if (adapter.id === "claude") {
      // Claude React 渲染可能晚于 document_idle，初始 parse 可能扑空。
      // 延迟重解析兜底，确保对话内容出现后能及时更新 timeline。
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
