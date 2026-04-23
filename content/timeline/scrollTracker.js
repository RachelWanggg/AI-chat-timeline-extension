import { createLogger } from "../utils/logger.js";

/**
 * Scroll tracker: detect which anchor is visible.
 * Does NOT parse conversation data and does NOT perform network/storage I/O.
 */
export function createScrollTracker({ onAnchorVisible, root = null, threshold = 0.5 } = {}) {
  const logger = createLogger("ScrollTracker");
  let observer = null;
  let tracked = [];

  function start(elements) {
    stop();
    tracked = Array.isArray(elements) ? elements.filter(Boolean) : [];
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const anchorId = entry.target.dataset.tlAnchorId;
          if (anchorId && typeof onAnchorVisible === "function") {
            onAnchorVisible(anchorId);
          }
        });
      },
      { root, threshold }
    );
    tracked.forEach((el) => observer.observe(el));
    logger.debug("tracking elements:", tracked.length);
  }

  function stop() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    tracked = [];
  }

  return { start, stop };
}
