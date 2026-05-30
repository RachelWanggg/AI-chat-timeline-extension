import { createLogger } from "../utils/logger.js";

/**
 * Scroll engine: the single authority for moving the page to an anchor.
 *
 * 设计原则（经 chrome-devtools 在真实 ChatGPT / Claude 页面验证）：
 * - 永不使用 element.scrollIntoView()：嵌套滚动容器里它会去滚错祖先，且行为跨浏览器不一致。
 * - 永不使用 window.scroll：两个平台真正的滚动容器都不是 window
 *   （ChatGPT 是 [scrollbar-gutter] 的 overflow:auto div，Claude 是 [scrollbar-gutter:stable] 的 div）。
 * - 滚动容器靠"从目标向上 walk-up 找第一个真正可滚的祖先"推导，不靠 class 名猜。
 * - 用算术 scrollTop 精确定位：top = container.scrollTop + (elTop - containerTop) - offset，
 *   clamp 到 [0, scrollHeight - clientHeight]（杜绝 overscroll）。实测落点误差 0px。
 * - 两阶段：仅当目标被虚拟化卸载时先预定位触发挂载；目标已挂载时保持全程平滑滚动。
 * - rAF 自管 smooth：每帧重新 resolve 目标并推进 scrollTop，避免原生 smooth 被 ChatGPT 重排打断。
 *
 * 依赖注入：
 * - resolveElement(anchorId): 同步返回当前活的目标元素（每次重查，永不返回脱离文档的缓存）。
 * - locatePlaceholder(anchorId): 目标被虚拟化卸载时，返回它的占位 turn 容器（用于滚入触发挂载）。
 * - getDesiredOffset(): 目标落点距容器顶部的留白（让位 sticky header）。
 */
export function createScrollEngine({
  resolveElement,
  locatePlaceholder = null,
  getDesiredOffset = null,
} = {}) {
  const logger = createLogger("ScrollEngine");

  const DESIRED_OFFSET_PX = 80;        // 默认落点：容器顶部下方 80px（ChatGPT header 52 / Claude 48 + 留白）
  const SMOOTH_DISTANCE_FACTOR = 1.0;  // 虚拟化未挂载且距离 > 1 屏时，先预定位触发挂载
  const SETTLE_TOLERANCE_PX = 4;       // 落点误差容差
  const SETTLE_STABLE_FRAMES = 4;      // 连续 N 帧达标且布局静止才算 settle
  const SETTLE_DEADLINE_MS = 1500;     // 校准上限（streaming 仍在涨时兜底退出）
  const SMOOTH_MIN_MS = 420;           // 自管平滑滚动最短时长
  const SMOOTH_MAX_MS = 2200;          // 自管平滑滚动最长时长，避免超长对话拖太久
  const SMOOTH_PX_PER_MS = 3.6;        // 距离 → 时长换算，数值越大滚得越快
  const MOUNT_POLL_MS = 80;            // 等待虚拟化内容挂载的轮询间隔
  const MOUNT_TIMEOUT_MS = 1500;       // 等待挂载的最长时间

  // 单调递增的跳转令牌：新跳转令旧跳转的所有异步阶段立即作废，避免两个跳转互相打架。
  let activeToken = 0;

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function offset() {
    const v = typeof getDesiredOffset === "function" ? getDesiredOffset() : NaN;
    return Number.isFinite(v) ? v : DESIRED_OFFSET_PX;
  }

  // ── 滚动容器抽象：兼容"某个 overflow 容器"与"window 滚动"两种世界 ────────────
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
   * 从目标元素向上找真正的滚动容器：
   * 第一个 overflowY 为 auto/scroll 且 scrollHeight > clientHeight 的祖先即权威容器。
   * 当前内容不够长（短对话 / streaming 刚开始）时，退化到最近的 overflow:auto 祖先；
   * 都没有则退化到 document.scrollingElement。
   */
  function findScrollableAncestor(startEl) {
    let el = startEl;
    let softFallback = null;
    while (el && el !== document.documentElement && el !== document.body) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY)) {
        if (el.scrollHeight > el.clientHeight + 4) return el;   // 真正在滚的容器
        if (!softFallback) softFallback = el;                   // overflow:auto 但当前没溢出
      }
      el = el.parentElement;
    }
    return softFallback || document.scrollingElement || document.documentElement;
  }

  // 算术目标 scrollTop（已 clamp）：把元素顶部对齐到容器顶部下方 offset 处。
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
   * 确保目标已挂载并可解析。
   * 目标被虚拟化卸载时：取其占位 turn，用算术 instant 滚入视口触发挂载，轮询直到 resolve 成功。
   */
  // 返回 { el, wasVirtualized }：
  // - wasVirtualized=false：元素首次查询即已挂载，直接用 smooth scroll
  // - wasVirtualized=true：元素需要等待挂载（虚拟化），需要 Phase 1 instant 预定位
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
   * 自管平滑滚动：
   * 浏览器原生 smooth 在 ChatGPT 虚拟化列表中容易被重排中断，表现为"点一下只滚一段"。
   * 这里每帧重新 resolve 目标并用缓动曲线推进 scrollTop；目标 remount / streaming 位移时，
   * 下一帧自然追随新 target，仍然保持平滑，不做可见的 instant 跳跃。
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
        if (token !== activeToken) return resolve(false); // 被新跳转作废

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
   * 滚动到 anchor。返回是否成功（被新跳转作废算失败）。
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

    // Phase 1：仅对虚拟化内容（ensureResolved 首次查询未命中）做 instant 预定位，触发 React 挂载。
    // 已挂载内容直接进 Phase 2 smooth，避免用户感知到"瞬间跳"。
    let target = computeTargetTop(container, el, off);
    if (wasVirtualized && Math.abs(target - getScrollTop(container)) > viewportHeight(container) * SMOOTH_DISTANCE_FACTOR) {
      setScrollTop(container, target, "auto");
      await raf();
      await raf();
      if (token !== activeToken) return false;
      el = resolveElement(anchorId) || el; // 可能在挂载中被替换
      if (!el?.isConnected) return false;
      target = computeTargetTop(container, el, off);
    }

    // Phase 2：自管 smooth。全程平滑，同时持续追随 ChatGPT 虚拟化/重排后的真实目标。
    return smoothScrollToAnchor({ token, anchorId, container, off, initialTarget: target });
  }

  // 作废当前进行中的跳转（例如对话切换 / 重新解析时）。
  function cancel() {
    activeToken++;
  }

  return {
    scrollToAnchor,
    cancel,
    findScrollableAncestor,
  };
}
