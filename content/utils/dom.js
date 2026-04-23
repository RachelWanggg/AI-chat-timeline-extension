(() => {
  /**
   * DOM utilities.
   * Does NOT contain feature-specific business logic.
   */
  const ns = (window.TLContent = window.TLContent || {});
  ns.utils = ns.utils || {};

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function waitForElement(selector, { timeout = 5000, interval = 100 } = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(timer);
          resolve(el);
          return;
        }
        if (Date.now() - startedAt > timeout) {
          clearInterval(timer);
          reject(new Error(`Element not found: ${selector}`));
        }
      }, interval);
    });
  }

  ns.utils.dom = { $, $all, waitForElement };
})();

