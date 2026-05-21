import { createLogger } from "../utils/logger.js";

/**
 * Anchor resolver: 把 anchorId 解析成当前活的 DOM 节点。
 * 不滚动、不挂载、不决定 active 状态 —— 滚动与虚拟化挂载由 scrollEngine 负责。
 *
 * 核心原则：每次都重新查询，永不返回已脱离文档（虚拟化卸载 / 重渲染替换）的缓存节点。
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

  // anchorId 形如 `tl-anchor-<uuid>-h3` / `tl-anchor-<uuid>-p0`。
  // uuid 本身含连字符，但后缀 `-h\d+` / `-p\d+` 是无歧义的，可安全剥离。
  function deriveMessageId(anchorId) {
    const meta = fallbackMap.get(anchorId);
    if (meta?.sectionId) return meta.sectionId;
    const m = String(anchorId || "").match(/^tl-anchor-(.+)-(?:h\d+|p\d+)$/);
    if (m) return m[1];
    // 用户消息 anchor 的 id 本身就是 message id（UUID），直接返回。
    return anchorId || null;
  }

  function findSection(sectionId) {
    // getElementById fails when React re-renders because it resets our dynamically-set id.
    // Try data-tl-message-id first (set by upsertUserFromDom / upsertAssistantFromDom),
    // then data-turn-id (ChatGPT's own JSX attr，虚拟化占位也保留), then data-message-id.
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
    // 文本对不上（流式半截）时退回 index 兜底；scrollEngine 的 settle 会在文本补全后重定位。
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

  // 始终重新查询：永不返回已脱离文档（虚拟化卸载）的缓存节点。
  // 解析顺序：text-based fallback（最稳） → data-tl-anchor-id → 注入的 id/section → 已连接缓存。
  function getElement(anchorId) {
    // 1) 文本/结构 fallback 重查（重渲染后最可靠，因为 ChatGPT 会丢掉我们注入的 id）
    const byFallback = resolveFromFallback(anchorId);
    if (byFallback?.isConnected) return byFallback;

    // 2) 我们注入的属性（同一帧内尚未被重渲染清除时命中）
    const byAttr = document.querySelector(`[data-tl-anchor-id="${CSS.escape(anchorId)}"]`);
    if (byAttr?.isConnected) return byAttr;

    // 3) anchorId 恰好等于注入的 heading id；或退化到 section
    const directSection = findSection(anchorId);
    if (directSection?.isConnected) {
      anchorMap.set(anchorId, directSection);
      directSection.dataset.tlAnchorId = anchorId;
      return directSection;
    }

    // 4) 仅当仍连接时才用缓存
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
