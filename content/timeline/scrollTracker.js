import { createLogger } from "../utils/logger.js";

/**
 * Scroll tracker: detect which anchor is currently being read.
 * Does NOT parse conversation data and does NOT perform network/storage I/O.
 *
 * - The observer root is the real scroll container, not the layout viewport, and rootMargin
 *   reserves room for the sticky header so "active" reflects the line the user is actually
 *   reading rather than any element that happens to intersect the viewport.
 * - Jump lock: lock() during a programmatic jump stops the observer from emitting, so anchors
 *   scrolled past are not briefly reported as active. unlock() hands observation back once
 *   the scroll settles.
 */
export function createScrollTracker({ onAnchorVisible } = {}) {
  const logger = createLogger("ScrollTracker");
  let observer = null;
  let tracked = [];
  let locked = false;

  // Track a visible set with a stability delay so several hits in one frame do not make the
  // side panel highlight flicker.
  const visibleEls = new Set();
  let lastEmittedId = null;
  let stabilityTimer = null;
  const STABILITY_DELAY = 250; // Must stay in the reading band this long to count as visible
  const DEFAULT_ROOT_MARGIN = "-80px 0px -55% 0px"; // Reserve the header; only the top band counts

  function pickBestVisible() {
    const els = Array.from(visibleEls).filter((el) => el?.isConnected);
    if (els.length === 0) return null;
    // The topmost visible element is the most stable pick: it will not bounce around when
    // several entries intersect at once.
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
   * @param {HTMLElement[]} elements Anchor elements to track
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

  // Lock when a programmatic jump starts: emit nothing in flight and let the side panel
  // optimistic highlight take over.
  function lock() {
    locked = true;
    clearTimeout(stabilityTimer);
  }

  // Unlock once the jump settles. Seed the baseline with the target id so the highlight does
  // not snap back to the previous anchor on arrival.
  function unlock(settledAnchorId = null) {
    locked = false;
    if (settledAnchorId) lastEmittedId = settledAnchorId;
  }

  return { start, stop, lock, unlock };
}
