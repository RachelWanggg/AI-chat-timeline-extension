export function isReverseScrollContainer(container) {
  if (!container) return false;
  const direct = container.flexDirection || container.style?.flexDirection || "";
  if (direct) return direct === "column-reverse";
  try {
    return globalThis.getComputedStyle?.(container)?.flexDirection === "column-reverse";
  } catch {
    return false;
  }
}

export function getElementScrollBounds(container) {
  const extent = Math.max(
    0,
    Number(container?.scrollHeight || 0) - Number(container?.clientHeight || 0)
  );
  return isReverseScrollContainer(container)
    ? { min: -extent, max: 0 }
    : { min: 0, max: extent };
}

export function clampScrollTop(top, { min, max }) {
  return Math.max(min, Math.min(Number(top || 0), max));
}
