import { createLogger } from "../utils/logger.js";

/**
 * Scroll tracker: detect which anchor is currently being read.
 * Does NOT parse conversation data and does NOT perform network/storage I/O.
 *
 * - root 接真实滚动容器（而非 layout viewport），rootMargin 顶部留 sticky header + offset，
 *   让"active"反映用户真正在读的那一行，而不是恰好 intersect viewport 的任意元素。
 * - jump lock：程序化跳转期间 lock()，观察器停发，避免途经的 anchor 被误判为 active 而闪烁；
 *   落定后 unlock() 交还观测权。
 */
export function createScrollTracker({ onAnchorVisible } = {}) {
  const logger = createLogger("ScrollTracker");
  let observer = null;
  let tracked = [];
  let locked = false;

  // 用可见集合 + 稳定延迟，避免同一帧内多次触发导致 side panel 高亮闪烁
  const visibleEls = new Set();
  let lastEmittedId = null;
  let stabilityTimer = null;
  const STABILITY_DELAY = 250; // 元素在读取带内停留 250ms 以上才算真正可见
  const DEFAULT_ROOT_MARGIN = "-80px 0px -55% 0px"; // 顶部让位 header/offset，只认顶部读取带

  function pickBestVisible() {
    const els = Array.from(visibleEls).filter((el) => el?.isConnected);
    if (els.length === 0) return null;
    // 视口内最靠上的那个最稳定（不会因多个 entry 同时 intersect 而来回跳）
    els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const preferred = els.find((el) => el.getBoundingClientRect().top >= -8);
    return preferred || els[0];
  }

  function emitIfStable() {
    if (locked) return;
    const best = pickBestVisible();
    const anchorId = best?.dataset?.tlAnchorId;
    if (!anchorId) return;
    if (anchorId === lastEmittedId) return;
    lastEmittedId = anchorId;
    if (typeof onAnchorVisible === "function") onAnchorVisible(anchorId);
  }

  function scheduleEmit() {
    clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(emitIfStable, STABILITY_DELAY);
  }

  /**
   * @param {HTMLElement[]} elements 要追踪的锚点元素
   * @param {{ root?: Element|null, rootMargin?: string }} [opts]
   */
  function start(elements, opts = {}) {
    stop();
    tracked = Array.isArray(elements) ? elements.filter(Boolean) : [];

    const root = opts.root || null;
    const rootMargin = opts.rootMargin || DEFAULT_ROOT_MARGIN;

    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry?.target) return;
          if (entry.isIntersecting) visibleEls.add(entry.target);
          else visibleEls.delete(entry.target);
        });
        if (!locked) scheduleEmit();
      },
      { root, rootMargin, threshold: 0 }
    );

    tracked.forEach((el) => observer.observe(el));
    logger.debug("tracking elements:", tracked.length, "rooted:", Boolean(root));
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    tracked = [];
    visibleEls.clear();
    lastEmittedId = null;
    clearTimeout(stabilityTimer);
    stabilityTimer = null;
  }

  // 程序化跳转开始时锁住：途中不发 active，由 side panel 的乐观高亮接管。
  function lock() {
    locked = true;
    clearTimeout(stabilityTimer);
  }

  // 跳转落定后解锁：交还观测权；用目标 id 作为新基线，避免落定瞬间回弹到旧 active。
  function unlock(settledAnchorId = null) {
    locked = false;
    if (settledAnchorId) lastEmittedId = settledAnchorId;
  }

  return { start, stop, lock, unlock };
}
