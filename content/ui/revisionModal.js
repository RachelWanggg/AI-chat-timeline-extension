import { createLogger } from "../utils/logger.js";

/**
 * Revision modal UI only.
 * Does NOT call background APIs and does NOT read platform-specific DOM selectors.
 */
export function createRevisionModal() {
  const logger = createLogger("UI.RevisionModal");
  const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  function ensureModalStyles() {
    if (document.getElementById("tl-modal-styles")) return;
    const style = document.createElement("style");
    style.id = "tl-modal-styles";
    style.textContent = `
      .tl-modal-backdrop[data-theme="dark"] {
        --modal-overlay: rgba(0,0,0,0.6);
        --modal-bg: #1a1a1a;
        --modal-bg-header: #242424;
        --modal-border: #333333;
        --modal-text: #e8e8e8;
        --modal-input-border: #444444;
        --modal-close-hover: rgba(128,128,128,0.2);
        --modal-back-hover: rgba(128,128,128,0.15);
        --modal-secondary-border: #444444;
        --modal-secondary-color: #e8e8e8;
      }
      .tl-modal-backdrop[data-theme="light"] {
        --modal-overlay: rgba(0,0,0,0.4);
        --modal-bg: #ffffff;
        --modal-bg-header: #f5f5f5;
        --modal-border: #dddddd;
        --modal-text: #333333;
        --modal-input-border: #cccccc;
        --modal-close-hover: rgba(0,0,0,0.08);
        --modal-back-hover: rgba(0,0,0,0.08);
        --modal-secondary-border: #cccccc;
        --modal-secondary-color: #333333;
      }
    `;
    document.head.appendChild(style);
  }

  async function getResolvedTheme() {
    const result = await chrome.storage.local.get("settings");
    const theme = result.settings?.theme ?? "system";
    if (theme === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return theme;
  }

  async function open({ text, onUseInComposer }) {
    document.getElementById("tl-revision-backdrop")?.remove();
    ensureModalStyles();
    const theme = await getResolvedTheme();

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.id = "tl-revision-backdrop";
    backdrop.className = "tl-modal-backdrop";
    backdrop.setAttribute("data-theme", theme);
    backdrop.style.cssText =
      "position:fixed;inset:0;background:var(--modal-overlay);z-index:999998;" +
      "display:flex;align-items:center;justify-content:center;" +
      `font-family:${FONT};`;
    backdrop.addEventListener("click", closeModal);

    // Card
    const card = document.createElement("div");
    card.style.cssText =
      "background:var(--modal-bg);border:1px solid var(--modal-border);border-radius:12px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,0.4);" +
      "width:min(560px,92vw);max-height:70vh;" +
      "display:flex;flex-direction:column;overflow:hidden;";
    card.addEventListener("click", (e) => e.stopPropagation());

    // Header
    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;" +
      "padding:14px 16px;background:var(--modal-bg-header);" +
      "border-bottom:1px solid var(--modal-border);flex-shrink:0;";

    const title = document.createElement("span");
    title.textContent = "✨ Revised Prompt";
    title.style.cssText = "font-size:14px;font-weight:600;color:var(--modal-text);";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText =
      "background:none;border:none;cursor:pointer;font-size:14px;color:var(--modal-text);" +
      "padding:4px 8px;border-radius:4px;line-height:1;transition:background 0.2s;";
    closeBtn.onmouseover = () => closeBtn.style.setProperty("background", "var(--modal-close-hover)");
    closeBtn.onmouseout = () => (closeBtn.style.background = "none");
    closeBtn.onclick = closeModal;

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body (scrollable)
    const body = document.createElement("div");
    body.style.cssText =
      "flex:1;overflow-y:auto;padding:16px;" +
      "scrollbar-width:thin;scrollbar-color:var(--modal-input-border) transparent;";

    const textEl = document.createElement("div");
    textEl.textContent = text || "";
    textEl.style.cssText =
      "font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:var(--modal-text);";
    body.appendChild(textEl);

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText =
      "display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;" +
      "background:var(--modal-bg-header);border-top:1px solid var(--modal-border);flex-shrink:0;";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.style.cssText =
      "padding:8px 14px;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;" +
      "border:1px solid var(--modal-secondary-border);background:transparent;" +
      "color:var(--modal-secondary-color);transition:background 0.2s;";
    copyBtn.onmouseover = () => copyBtn.style.setProperty("background", "var(--modal-back-hover)");
    copyBtn.onmouseout = () => (copyBtn.style.background = "transparent");
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text || "");
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      } catch {
        logger.warn("clipboard write failed");
      }
    };

    const useBtn = document.createElement("button");
    useBtn.textContent = "Use in Composer";
    useBtn.style.cssText =
      "padding:8px 14px;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;" +
      "border:none;background:#5b9cf6;color:#fff;transition:background 0.2s;";
    useBtn.onmouseover = () => (useBtn.style.background = "#7aacff");
    useBtn.onmouseout = () => (useBtn.style.background = "#5b9cf6");
    useBtn.onclick = () => {
      onUseInComposer?.();
      closeModal();
    };

    footer.appendChild(copyBtn);
    footer.appendChild(useBtn);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(footer);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    function onKeyDown(e) {
      if (e.key === "Escape") closeModal();
    }
    document.addEventListener("keydown", onKeyDown);

    function closeModal() {
      backdrop.remove();
      document.removeEventListener("keydown", onKeyDown);
    }

    logger.info("opened");
  }

  return { open };
}
