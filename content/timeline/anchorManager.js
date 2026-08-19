import { createLogger } from "../utils/logger.js";

/**
 * Anchor resolver: turn an anchorId into the DOM node that is live right now.
 * It does not scroll, does not mount virtualized content, and does not decide the active
 * state -- scrolling and virtualization mounting belong to scrollEngine.
 *
 * Core rule: re-query every time. Never return a cached node that has been detached from the
 * document by virtualization or by a re-render.
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

  // An anchorId looks like `tl-anchor-<uuid>-h3` or `tl-anchor-<uuid>-p0`.
  // The uuid contains hyphens itself, but the `-h\d+` / `-p\d+` suffix is unambiguous
  // and can be stripped safely.
  function deriveMessageId(anchorId) {
    const meta = fallbackMap.get(anchorId);
    if (meta?.sectionId) return meta.sectionId;
    const m = String(anchorId || "").match(/^tl-anchor-(.+)-(?:h\d+|p\d+)$/);
    if (m) return m[1];
    // For a user-message anchor the id is already the message id (a UUID), so return it as is.
    return anchorId || null;
  }

  function findSection(sectionId) {
    // getElementById fails when React re-renders because it resets our dynamically-set id.
    // Try data-tl-message-id first (set by upsertUserFromDom / upsertAssistantFromDom),
    // then data-turn-id (ChatGPT's own JSX attr, kept even on virtualized placeholders), then data-message-id.
    return (
      document.getElementById(sectionId) ||
      document.querySelector(`[data-tl-message-id="${CSS.escape(sectionId)}"]`) ||
      document.querySelector(`[data-turn-id="${CSS.escape(sectionId)}"]`) ||
      document.querySelector(`[data-message-id="${CSS.escape(sectionId)}"]`)
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
    // Prefer text-based match: positional index drifts when React re-renders mid-stream.
    // When the text does not match (a half-streamed reply), fall back to the index; the settle
    // phase in scrollEngine re-locates the target once the text is complete.
    let heading = null;
    if (fallback.headingText) {
      heading = headings.find((h) => h.textContent.trim() === fallback.headingText);
    }
    if (!heading) heading = headings[fallback.headingIndex || 0];
    if (!heading) return null;
    anchorMap.set(anchorId, heading);
    heading.dataset.tlAnchorId = anchorId;
    return heading;
  }

  // Always re-query: never return a cached node detached by virtualization.
  // Resolution order: text-based fallback (most robust, since ChatGPT drops the ids we inject)
  // -> data-tl-anchor-id -> injected id/section -> still-connected cache.
  function getElement(anchorId) {
    // 1) Re-resolve via the text/structure fallback (most reliable after a re-render)
    const byFallback = resolveFromFallback(anchorId);
    if (byFallback?.isConnected) return byFallback;

    // 2) The attribute we injected (hits while the frame has not been re-rendered yet)
    const byAttr = document.querySelector(`[data-tl-anchor-id="${CSS.escape(anchorId)}"]`);
    if (byAttr?.isConnected) return byAttr;

    // 3) anchorId happens to equal the injected heading id, or degrade to the section
    const directSection = findSection(anchorId);
    if (directSection?.isConnected) {
      anchorMap.set(anchorId, directSection);
      directSection.dataset.tlAnchorId = anchorId;
      return directSection;
    }

    // 4) Use the cache only while it is still connected
    const cached = anchorMap.get(anchorId);
    if (cached?.isConnected) return cached;

    return null;
  }

  function debugSize() {
    logger.debug("anchor count:", anchorMap.size, "fallback count:", fallbackMap.size);
  }

  return {
    register,
    registerFallback,
    unregister,
    clear,
    getElement,
    deriveMessageId,
    debugSize,
  };
}
