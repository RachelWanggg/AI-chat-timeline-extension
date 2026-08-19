import { createLogger } from "../utils/logger.js";

/**
 * Scroll engine: the single authority for moving the page to an anchor.
 *
 * Design rules, verified with chrome-devtools against live ChatGPT and Claude pages:
 * - Never use element.scrollIntoView(). With nested scroll containers it scrolls the wrong
 *   ancestor, and its behaviour is not consistent across browsers.
 * - Never use window.scroll. On neither platform is window the real scroll container
 *   (ChatGPT uses an overflow:auto div with [scrollbar-gutter], Claude a
 *   [scrollbar-gutter:stable] div).
 * - Derive the scroll container by walking up from the target to the first genuinely
 *   scrollable ancestor, rather than guessing from class names.
 * - Position arithmetically via scrollTop:
 *     top = container.scrollTop + (elTop - containerTop) - offset
 *   clamped to [0, scrollHeight - clientHeight] so overscroll is impossible. Measured
 *   landing error: 0px.
 * - Two phases, but only when needed: pre-position to force a mount if the target has been
 *   unmounted by virtualization; if it is already mounted, stay smooth the whole way.
 * - Self-driven smooth scrolling on rAF: re-resolve the target and advance scrollTop every
 *   frame, so native smooth scrolling cannot be interrupted by a ChatGPT reflow.
 *
 * Injected dependencies:
 * - resolveElement(anchorId): synchronously return the live target element (re-queried every
 *   time; never a cached node that has left the document).
 * - locatePlaceholder(anchorId): when the target is unmounted by virtualization, return its
 *   placeholder turn container, which can be scrolled into view to trigger the mount.
 * - getDesiredOffset(): gap between the container top and the landing position, leaving room
 *   for the sticky header.
 */
export function createScrollEngine({
  resolveElement,
  locatePlaceholder = null,
  getDesiredOffset = null,
} = {}) {
  const logger = createLogger("ScrollEngine");

  const DESIRED_OFFSET_PX = 80;        // Land 80px below the container top (ChatGPT header 52 / Claude 48, plus slack)
  const SMOOTH_DISTANCE_FACTOR = 1.0;  // Pre-position first when unmounted and more than one screen away
  const SETTLE_TOLERANCE_PX = 4;       // Acceptable landing error
  const SETTLE_STABLE_FRAMES = 4;      // Settled only after N consecutive on-target frames with a static layout
  const SETTLE_DEADLINE_MS = 1500;     // Calibration cap; bails out while a reply is still streaming
  const SMOOTH_MIN_MS = 420;           // Shortest self-driven smooth scroll
  const SMOOTH_MAX_MS = 2200;          // Longest self-driven smooth scroll, so long conversations do not drag
  const SMOOTH_PX_PER_MS = 3.6;        // Distance-to-duration ratio; higher scrolls faster
  const MOUNT_POLL_MS = 80;            // Poll interval while waiting for virtualized content to mount
  const MOUNT_TIMEOUT_MS = 1500;       // Longest wait for a mount

  // Monotonic jump token: a new jump immediately invalidates every async phase of the
  // previous one, so two jumps can never fight each other.
  let activeToken = 0;

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function offset() {
    const v = typeof getDesiredOffset === "function" ? getDesiredOffset() : NaN;
    return Number.isFinite(v) ? v : DESIRED_OFFSET_PX;
  }

  // ── Scroll-container abstraction, covering both an overflow container and window scrolling ──
  function isWindowScroller(c) {
    return c === document.scrollingElement || c === document.documentElement || c === document.body;
  }

  function getScrollTop(c) {
    return isWindowScroller(c) ? (window.scrollY || document.documentElement.scrollTop || 0) : c.scrollTop;
  }

  function containerViewportTop(c) {
    return isWindowScroller(c) ? 0 : c.getBoundingClientRect().top;
  }

  function viewportHeight(c) {
    return isWindowScroller(c) ? window.innerHeight : c.clientHeight;
  }

  function maxScrollTop(c) {
    return isWindowScroller(c)
      ? Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      : Math.max(0, c.scrollHeight - c.clientHeight);
  }

  function setScrollTop(c, top, behavior) {
    if (isWindowScroller(c)) window.scrollTo({ top, behavior });
    else c.scrollTo({ top, behavior });
  }

  /**
   * Walk up from the target element to find the real scroll container.
   * The authoritative container is the first ancestor whose overflowY is auto or scroll and
   * whose scrollHeight exceeds its clientHeight. When the content is not tall enough yet
   * (a short conversation, or a reply that just started streaming), fall back to the nearest
   * overflow:auto ancestor, and finally to document.scrollingElement.
   */
  function findScrollableAncestor(startEl) {
    let el = startEl;
    let softFallback = null;
    while (el && el !== document.documentElement && el !== document.body) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY)) {
        if (el.scrollHeight > el.clientHeight + 4) return el;   // Genuinely scrolling
        if (!softFallback) softFallback = el;                   // overflow:auto but not overflowing yet
      }
      el = el.parentElement;
    }
    return softFallback || document.scrollingElement || document.documentElement;
  }

  // Arithmetic target scrollTop (already clamped): align the element top to `offset` below
  // the container top.
  function computeTargetTop(container, el, off) {
    const elTop = el.getBoundingClientRect().top;
    const raw = getScrollTop(container) + (elTop - containerViewportTop(container)) - off;
    return Math.max(0, Math.min(raw, maxScrollTop(container)));
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function smoothDuration(distance) {
    return Math.max(
      SMOOTH_MIN_MS,
      Math.min(SMOOTH_MAX_MS, Math.abs(distance) / SMOOTH_PX_PER_MS)
    );
  }

  /**
   * Ensure the target is mounted and resolvable.
   * If virtualization unmounted it, take its placeholder turn, scroll it into view with an
   * arithmetic instant jump to trigger the mount, and poll until resolution succeeds.
   */
  // Returns { el, wasVirtualized }:
  // - wasVirtualized=false: already mounted on the first query, so go straight to smooth scroll
  // - wasVirtualized=true: had to wait for a mount, so Phase 1 instant pre-positioning ran
  async function ensureResolved(anchorId, token) {
    let el = resolveElement(anchorId);
    if (el?.isConnected) return { el, wasVirtualized: false };

    const deadline = performance.now() + MOUNT_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (token !== activeToken) return { el: null, wasVirtualized: true };
      const placeholder =
        typeof locatePlaceholder === "function" ? locatePlaceholder(anchorId) : null;
      if (placeholder?.isConnected) {
        const container = findScrollableAncestor(placeholder);
        setScrollTop(container, computeTargetTop(container, placeholder, offset()), "auto");
      }
      await delay(MOUNT_POLL_MS);
      el = resolveElement(anchorId);
      if (el?.isConnected) return { el, wasVirtualized: true };
    }
    return { el: resolveElement(anchorId), wasVirtualized: true };
  }

  /**
   * Self-driven smooth scrolling.
   * Native smooth scrolling is easily interrupted by reflows in ChatGPT's virtualized list,
   * which shows up as "one click only scrolls part of the way". Instead, re-resolve the
   * target every frame and advance scrollTop along an easing curve. When the target remounts
   * or shifts mid-stream, the next frame simply follows the new target -- still smooth, with
   * no visible instant jump.
   */
  function smoothScrollToAnchor({ token, anchorId, container, off, initialTarget }) {
    return new Promise((resolve) => {
      const startTop = getScrollTop(container);
      const startedAt = performance.now();
      const deadline = startedAt + SMOOTH_MAX_MS + SETTLE_DEADLINE_MS;
      let stableFrames = 0;
      let lastTarget = initialTarget;
      let lastLiveTarget = initialTarget;
      let segmentStartTop = startTop;
      let segmentTarget = initialTarget;
      let segmentStartedAt = startedAt;
      let segmentDuration = smoothDuration(segmentTarget - segmentStartTop);

      const tick = (now) => {
        if (token !== activeToken) return resolve(false); // Superseded by a newer jump

        const el =
          resolveElement(anchorId) ||
          (typeof locatePlaceholder === "function" ? locatePlaceholder(anchorId) : null);
        if (!el?.isConnected) {
          if (now < deadline) return requestAnimationFrame(tick);
          return resolve(false);
        }

        const target = computeTargetTop(container, el, off);
        lastLiveTarget = target;
        const layoutStable = Number.isFinite(lastTarget) && Math.abs(target - lastTarget) < 1;
        lastTarget = target;

        if (Math.abs(target - segmentTarget) > SETTLE_TOLERANCE_PX) {
          segmentStartTop = getScrollTop(container);
          segmentTarget = target;
          segmentStartedAt = now;
          segmentDuration = smoothDuration(segmentTarget - segmentStartTop);
        }

        const elapsed = Math.max(0, now - segmentStartedAt);
        const progress = Math.min(1, elapsed / segmentDuration);
        const nextTop = segmentStartTop + (segmentTarget - segmentStartTop) * easeInOutCubic(progress);
        setScrollTop(container, nextTop, "auto");

        const nextErr = Math.abs(lastLiveTarget - getScrollTop(container));
        if (progress >= 1 && nextErr <= SETTLE_TOLERANCE_PX && layoutStable) {
          if (++stableFrames >= SETTLE_STABLE_FRAMES) {
            logger.debug("smooth settled:", anchorId, "err", Math.round(nextErr));
            return resolve(true);
          }
        } else {
          stableFrames = 0;
        }

        if (now < deadline) requestAnimationFrame(tick);
        else {
          logger.debug("smooth deadline reached:", anchorId, "err", Math.round(nextErr));
          resolve(nextErr <= viewportHeight(container) * 0.1);
        }
      };

      requestAnimationFrame(tick);
    });
  }

  /**
   * Scroll to an anchor. Returns whether it succeeded; being superseded counts as a failure.
   */
  async function scrollToAnchor(anchorId) {
    if (!anchorId) return false;
    const token = ++activeToken;
    const off = offset();

    const { el: resolvedEl, wasVirtualized } = await ensureResolved(anchorId, token);
    if (token !== activeToken) return false;
    if (!resolvedEl?.isConnected) {
      logger.warn("scrollToAnchor: element unresolved", anchorId);
      return false;
    }

    let el = resolvedEl;
    const container = findScrollableAncestor(el);

    // Phase 1: instant pre-positioning only for virtualized content that ensureResolved
    // missed on its first query, to trigger the React mount. Already-mounted content goes
    // straight to the Phase 2 smooth scroll so the user never sees a jump.
    let target = computeTargetTop(container, el, off);
    if (wasVirtualized && Math.abs(target - getScrollTop(container)) > viewportHeight(container) * SMOOTH_DISTANCE_FACTOR) {
      setScrollTop(container, target, "auto");
      await raf();
      await raf();
      if (token !== activeToken) return false;
      el = resolveElement(anchorId) || el; // May have been replaced while mounting
      if (!el?.isConnected) return false;
      target = computeTargetTop(container, el, off);
    }

    // Phase 2: self-driven smooth scrolling. Smooth throughout, while continuously following
    // the real target across ChatGPT's virtualization and reflows.
    return smoothScrollToAnchor({ token, anchorId, container, off, initialTarget: target });
  }

  // Invalidate the jump in flight, e.g. when the conversation changes or we re-parse.
  function cancel() {
    activeToken++;
  }

  return {
    scrollToAnchor,
    cancel,
    findScrollableAncestor,
  };
}
