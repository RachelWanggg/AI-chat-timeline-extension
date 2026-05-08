import { createLogger } from "../utils/logger.js";
import { MESSAGE_TYPES } from "../utils/constants.js";
import { buildTimelineFromParsed } from "./parser.js";
import { parseClaude } from "../adapters/claudeAdapter.js";
import { createAnchorManager } from "./anchorManager.js";
import { createScrollTracker } from "./scrollTracker.js";

/**
 * Timeline controller: orchestrate adapter + parser + anchor/scroll modules.
 * Does NOT contain platform-specific selectors and does NOT render side panel UI.
 */
export function createTimelineController({ adapter, store }) {
  const logger = createLogger("Timeline");
  const anchorManager = createAnchorManager();
  const scrollTracker = createScrollTracker({
    onAnchorVisible: (anchorId) => {
      store.setState({ activeAnchorId: anchorId });
      chrome.runtime
        .sendMessage({ type: MESSAGE_TYPES.ANCHOR_VISIBLE, anchorId })
        .catch(() => {});
    },
  });

  let observer = null;

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function emitTimelineUpdate(timelineData) {
    chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPES.TIMELINE_UPDATE,
        payload: timelineData,
        url: window.location.href,
      })
      .catch(() => {});
  }

  function parseConversation() {
    const scope = adapter.containerSelector
      ? document.querySelector(adapter.containerSelector) || document
      : document;
    const turnEls = Array.from(scope.querySelectorAll(adapter.turnSelector || ""));
    const parsed = [];

    turnEls.forEach((turn, index) => {
      if (adapter.isUserTurn(turn)) {
        const extracted = adapter.extractUserText(turn);
        if (!extracted) return;
        parsed.push({
          id: extracted.domId || `turn-${index}`,
          role: "user",
          text: extracted.text,
          element: turn,
        });
      } else {
        const anchors = adapter.extractAssistantAnchors(turn, index);
        if (anchors.length === 0) return;
        parsed.push({ role: "assistant", anchors });
      }
    });

    return parsed;
  }

  function reparseNow() {
    const parsed = adapter.id === "claude" ? parseClaude() : parseConversation();
    const timelineData = buildTimelineFromParsed(parsed);
    store.setState({ timelineData });

    anchorManager.clear();
    parsed.forEach((item) => {
      if (item.role === "user" && item.element) {
        anchorManager.register(item.id, item.element);
      } else if (item.role === "assistant") {
        (item.anchors || []).forEach((anchor) => {
          if (anchor.element) anchorManager.register(anchor.id, anchor.element);
          if (anchor.fallback) anchorManager.registerFallback(anchor.id, anchor.fallback);
        });
      }
    });

    emitTimelineUpdate(timelineData);
    scrollTracker.start(Array.from(document.querySelectorAll("[data-tl-anchor-id]")));
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

    observer = new MutationObserver((mutations) => {
      const relevantChange =
        selectors.length === 0 ? true : hasNewMessage(mutations, selectors);
      if (!relevantChange) return;
      debouncedParse();
    });

    observer.observe(target, { childList: true, subtree: true });
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
      anchorManager.scrollTo(message.anchorId);
    }

    if (message.type === MESSAGE_TYPES.REPARSE_NOW) {
      reparseNow();
    }
  }

  function start() {
    chrome.runtime.onMessage.addListener(onMessage);
    reparseNow();
    startMutationObserver();
    logger.info("timeline controller started");
  }

  function stop() {
    stopMutationObserver();
    scrollTracker.stop();
    logger.info("timeline controller stopped");
  }

  return {
    start,
    stop,
    reparseNow,
  };
}
