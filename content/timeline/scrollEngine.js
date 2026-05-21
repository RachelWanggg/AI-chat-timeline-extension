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
 * - 两阶段：远距离 / 离屏先 instant 预定位（触发虚拟化挂载，不在白屏区跑动画），
 *   进入 ~1 屏内再 smooth 收尾（短距离平滑，不会"追逐"移动的目标）。
 * - rAF 校准：每帧重新 resolve 目标、测误差、判布局是否静止；streaming 涨高时把锚点钉住。
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
  const SMOOTH_DISTANCE_FACTOR = 1.0;  // 距离 ≤ 1 屏才 smooth；更远先 instant 预定位
  const SETTLE_TOLERANCE_PX = 4;       // 落点误差容差
  const SETTLE_STABLE_FRAMES = 4;      // 连续 N 帧达标且布局静止才算 settle
  const SETTLE_DEADLINE_MS = 1500;     // 校准上限（streaming 仍在涨时兜底退出）
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

  /**
   * 确保目标已挂载并可解析。
   * 目标被虚拟化卸载时：取其占位 turn，用算术 instant 滚入视口触发挂载，轮询直到 resolve 成功。
   */
  async function ensureResolved(anchorId, token) {
    let el = resolveElement(anchorId);
    if (el?.isConnected) return el;

    const deadline = performance.now() + MOUNT_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (token !== activeToken) return null;
      const placeholder =
        typeof locatePlaceholder === "function" ? locatePlaceholder(anchorId) : null;
      if (placeholder?.isConnected) {
        const container = findScrollableAncestor(placeholder);
        setScrollTop(container, computeTargetTop(container, placeholder, offset()), "auto");
      }
      await delay(MOUNT_POLL_MS);
      el = resolveElement(anchorId);
      if (el?.isConnected) return el;
    }
    return resolveElement(anchorId);
  }

  /**
   * rAF 校准循环：
   * - 每帧重新 resolve（可能已 remount）、重算目标、测误差。
   * - 布局静止（目标 top 帧间不变）且误差达标，连续 N 帧 → settle。
   * - 布局未静止（streaming/remount 导致目标移动）→ instant 把锚点钉到新位置。
   * - smooth 收尾动画进行中：目标恒定、误差递减，此时只等待、绝不打断。
   */
  function settle({ token, anchorId, container, off, initialTarget }) {
    return new Promise((resolve) => {
      const deadline = performance.now() + SETTLE_DEADLINE_MS;
      let stableFrames = 0;
      let lastTarget = initialTarget; // 用 Phase 2 的目标做种，避免首帧误判为"漂移"

      const tick = (now) => {
        if (token !== activeToken) return resolve(false); // 被新跳转作废

        const el = resolveElement(anchorId);
        if (!el?.isConnected) {
          if (now < deadline) return requestAnimationFrame(tick);
          return resolve(true);
        }

        const target = computeTargetTop(container, el, off);
        const err = Math.abs(target - getScrollTop(container));
        const layoutStable = Number.isFinite(lastTarget) && Math.abs(target - lastTarget) < 1;
        lastTarget = target;

        if (err <= SETTLE_TOLERANCE_PX && layoutStable) {
          if (++stableFrames >= SETTLE_STABLE_FRAMES) {
            logger.debug("settled:", anchorId, "err", Math.round(err));
            return resolve(true);
          }
        } else {
          stableFrames = 0;
          // 目标移动了（streaming 涨高 / 节点 remount）→ instant 重新钉住；
          // 若布局静止只是 smooth 动画还在跑，则不动它。
          if (!layoutStable) setScrollTop(container, target, "auto");
        }

        if (now < deadline) requestAnimationFrame(tick);
        else {
          logger.debug("settle deadline reached:", anchorId, "err", Math.round(err));
          resolve(true);
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

    let el = await ensureResolved(anchorId, token);
    if (token !== activeToken) return false;
    if (!el?.isConnected) {
      logger.warn("scrollToAnchor: element unresolved", anchorId);
      return false;
    }

    const container = findScrollableAncestor(el);

    // Phase 1：远距离 / 离屏 → instant 预定位（触发挂载，不在白屏区跑平滑动画）。
    let target = computeTargetTop(container, el, off);
    if (Math.abs(target - getScrollTop(container)) > viewportHeight(container) * SMOOTH_DISTANCE_FACTOR) {
      setScrollTop(container, target, "auto");
      await raf();
      await raf();
      if (token !== activeToken) return false;
      el = resolveElement(anchorId) || el; // 可能在挂载中被替换
      if (!el?.isConnected) return false;
      target = computeTargetTop(container, el, off);
    }

    // Phase 2：smooth 收尾（短距离、上方已稳定 → 平滑且不追逐）。
    setScrollTop(container, target, "smooth");

    // rAF 校准 + streaming 重钉。
    return settle({ token, anchorId, container, off, initialTarget: target });
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
