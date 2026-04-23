(() => {
  /**
   * Text utilities.
   * Does NOT query DOM or call background APIs.
   */
  const ns = (window.TLContent = window.TLContent || {});
  ns.utils = ns.utils || {};

  function truncate(text, max = 50) {
    if (typeof text !== "string") return "";
    const value = text.trim();
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}…`;
  }

  function safeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  ns.utils.text = { truncate, safeText };
})();

