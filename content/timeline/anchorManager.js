import { createLogger } from "../utils/logger.js";

/**
 * Anchor manager: map anchor ids to DOM nodes and perform scrolling.
 * Does NOT parse turns and does NOT decide active state policy.
 */
export function createAnchorManager() {
  const logger = createLogger("AnchorManager");
  const anchorMap = new Map();
  const fallbackMap = new Map();

  function register(anchorId, element) {
    if (!anchorId || !element) return;
    anchorMap.set(anchorId, element);
    element.dataset.tlAnchorId = anchorId;
  }

  function unregister(anchorId) {
    anchorMap.delete(anchorId);
    fallbackMap.delete(anchorId);
  }

  function clear() {
    anchorMap.clear();
    fallbackMap.clear();
  }

  function registerFallback(anchorId, fallbackMeta) {
    if (!anchorId || !fallbackMeta?.sectionId) return;
    fallbackMap.set(anchorId, fallbackMeta);
  }

  function findSection(sectionId) {
    // getElementById fails when React re-renders because it resets our dynamically-set id.
    // data-turn-id is in ChatGPT's own JSX and survives re-renders, so try it as backup.
    return (
      document.getElementById(sectionId) ||
      document.querySelector(`[data-turn-id="${CSS.escape(sectionId)}"]`)
    );
  }

  function resolveFromFallback(anchorId) {
    const fallback = fallbackMap.get(anchorId);
    if (!fallback?.sectionId) return null;

    const section = findSection(fallback.sectionId);
    if (!section) return null;

    // Scope to a sub-container if specified (e.g. ChatGPT's assistant bubble).
    const root = fallback.containerSelector
      ? section.querySelector(fallback.containerSelector) || section
      : section;

    if (fallback.isParagraph) {
      // Re-find the first paragraph with meaningful content, matching the original parse logic.
      const paragraphs = Array.from(root.querySelectorAll("p"));
      const paragraph = paragraphs.filter((p) => p.textContent.trim().length > 10)[
        fallback.headingIndex || 0
      ];
      if (!paragraph) return null;
      anchorMap.set(anchorId, paragraph);
      paragraph.dataset.tlAnchorId = anchorId;
      return paragraph;
    }

    const headings = Array.from(root.querySelectorAll("h1, h2, h3")).filter(
      (h) => !h.closest("pre")
    );
    const heading = headings[fallback.headingIndex || 0];
    if (!heading) return null;
    anchorMap.set(anchorId, heading);
    heading.dataset.tlAnchorId = anchorId;
    return heading;
  }

  function getElement(anchorId) {
    // Check isConnected: React re-renders replace DOM nodes, leaving stale refs in the map.
    const cached = anchorMap.get(anchorId);
    if (cached?.isConnected) return cached;

    const byAttr = document.querySelector(`[data-tl-anchor-id="${anchorId}"]`);
    if (byAttr) return byAttr;

    return resolveFromFallback(anchorId);
  }

  function scrollTo(anchorId) {
    const el = getElement(anchorId);
    if (!el) {
      logger.warn("anchor not found:", anchorId);
      return false;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  function debugSize() {
    logger.debug("anchor count:", anchorMap.size);
  }

  return {
    register,
    registerFallback,
    unregister,
    clear,
    getElement,
    scrollTo,
    debugSize,
  };
}
