import { clampScrollTop, getElementScrollBounds } from "./scrollGeometry.js";

/**
 * ChatGPT 虚拟列表导航：把稳定的消息 id 映射到当前挂载的 turn，
 * 或在目标未挂载时驱动真实滚动容器向目标移动。
 */
export function createChatgptVirtualization({
  getOrder,
  getTurns,
  getMessageId,
  getTurnPosition,
  isSearchUnit,
  getScrollContainer,
} = {}) {
  function findMounted(messageId) {
    return getTurns().find((turn) => getMessageId(turn) === messageId) || null;
  }

  function locatePlaceholder(messageId) {
    const mounted = findMounted(messageId);
    if (mounted) return mounted;

    const order = getOrder();
    const targetIndex = order.indexOf(messageId);
    if (targetIndex < 0) return null;

    const turns = getTurns();
    // 新版 ChatGPT 会把屏幕外的 search unit 整行卸载；当前可见行不是旧消息的
    // placeholder，按数组下标回退会把点击错误地跳到另一条消息。
    if (turns.some((turn) => isSearchUnit(turn))) return null;

    return (
      turns.find((turn) => getTurnPosition(turn) === targetIndex + 1) ||
      turns[targetIndex] ||
      null
    );
  }

  function seekMessage(messageId) {
    const order = getOrder();
    const targetIndex = order.indexOf(messageId);
    if (targetIndex < 0) return false;

    const mounted = getTurns()
      .map((turn) => ({ turn, index: order.indexOf(getMessageId(turn)) }))
      .filter(({ index }) => index >= 0)
      .sort((a, b) => a.index - b.index);
    if (mounted.length === 0) return false;

    const first = mounted[0];
    const last = mounted[mounted.length - 1];
    const container = getScrollContainer(first.turn);
    if (!container) return false;

    let direction;
    if (targetIndex < first.index) direction = -1;
    else if (targetIndex > last.index) direction = 1;
    else direction = targetIndex < (first.index + last.index) / 2 ? -1 : 1;

    const step = Math.max(Number(container.clientHeight || 0) * 0.85, 400);
    const currentTop = Number(container.scrollTop || 0);
    container.scrollTop = clampScrollTop(
      currentTop + direction * step,
      getElementScrollBounds(container)
    );
    return true;
  }

  return { findMounted, locatePlaceholder, seekMessage };
}
