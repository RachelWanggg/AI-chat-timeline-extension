import { createLogger } from "../utils/logger.js";

/**
 * Draft revise button UI: composer-level floating button only.
 * Does NOT implement revise API flow and does NOT parse timeline.
 */
export function mountDraftReviseButton({ adapter, onReviseDraft }) {
  const logger = createLogger("UI.DraftRevise");
  let observer = null;
  const isClaude = adapter?.id === "claude";
  const wrapperClass = isClaude ? "tl-revise-draft-wrapper-claude" : "tl-revise-draft-wrapper";
  const styleId = isClaude
    ? "tl-draft-revise-tooltip-style-claude"
    : "tl-draft-revise-tooltip-style-chatgpt";
  const listenerKey = isClaude ? "tlClaudeDraftListenerAttached" : "tlChatgptDraftListenerAttached";

  function injectDraftReviseTooltipCSS() {
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .${wrapperClass} {
        position: absolute;
        top: -36px;
        right: 12px;
        z-index: 999999;
        display: inline-flex;
        align-items: center;
      }

      .${wrapperClass} .tl-revise-draft-btn {
        background: #7c4dff;
        color: white;
        border: none;
        border-radius: 16px;
        padding: 6px 12px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        opacity: 0.9;
        transition: opacity 0.2s, transform 0.1s;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .${wrapperClass} .tl-revise-draft-btn:hover:not(:disabled) {
        opacity: 1;
        transform: translateY(-1px);
      }
      .${wrapperClass} .tl-revise-draft-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .${wrapperClass}::after {
        content: attr(data-tooltip);
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        background: rgba(40, 40, 40, 0.95);
        color: #fff;
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 4px;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.1s ease-out;
        z-index: 9999999;
      }
      .${wrapperClass}:hover::after {
        opacity: 1;
      }
      .${wrapperClass}[data-tooltip=""]:hover::after {
        opacity: 0;
      }
    `;
    document.head.appendChild(style);
  }

  function getDraftText(composer) {
    if (!composer) return "";
    if (typeof composer.value === "string") return composer.value.trim();
    return (composer.innerText || composer.textContent || "").trim();
  }

  function findMountContainer(composer) {
    if (!composer) return null;

    if (isClaude) {
      let parent = composer.parentElement;
      while (parent && parent !== document.body) {
        const cls = typeof parent.className === "string" ? parent.className : "";
        if (cls.includes("rounded-")) return parent;
        parent = parent.parentElement;
      }
      return composer.parentElement?.parentElement || composer.parentElement || composer;
    }

    const form = composer.closest("form");
    if (form) return form;

    let parent = composer.parentElement;
    while (parent && parent !== document.body) {
      const cls = typeof parent.className === "string" ? parent.className : "";
      if (cls.includes("rounded")) return parent;
      parent = parent.parentElement;
    }
    return composer.parentElement || composer;
  }

  function getWrapper(container) {
    if (container) return container.querySelector(`.${wrapperClass}`);
    return document.querySelector(`.${wrapperClass}`);
  }

  function getButton(container) {
    return getWrapper(container)?.querySelector(".tl-revise-draft-btn") || null;
  }

  function updateButtonState({ composer, button, container } = {}) {
    const currentComposer = composer || adapter.getComposer?.();
    const btn = button || getButton(container);
    const wrapper = btn?.closest(`.${wrapperClass}`) || getWrapper(container);
    if (!currentComposer || !btn) return;

    const text = getDraftText(currentComposer);
    if (!text) {
      btn.disabled = true;
      if (wrapper) wrapper.setAttribute("data-tooltip", "Type something to revise");
    } else if (text.length < 5) {
      btn.disabled = false;
      if (wrapper) wrapper.setAttribute("data-tooltip", "Draft too short — type more");
    } else {
      btn.disabled = false;
      if (wrapper) wrapper.setAttribute("data-tooltip", "Revise draft with AI");
    }
    btn.removeAttribute("title");
  }

  function attachComposerListeners(composer, container) {
    if (!composer) return;
    if (composer.dataset[listenerKey] === "true") return;
    const handler = () => updateButtonState({ composer, container });
    composer.addEventListener("input", handler);
    composer.addEventListener("keyup", handler);
    composer.dataset[listenerKey] = "true";
  }

  function removeStaleWrappers(activeContainer) {
    document.querySelectorAll(`.${wrapperClass}`).forEach((el) => {
      if (activeContainer?.contains(el)) return;
      el.remove();
    });
  }

  async function handleDraftReviseClick(button) {
    const composer = adapter.getComposer?.();
    if (!composer) return;

    const draftText = getDraftText(composer);
    if (!draftText) return;
    if (draftText.length < 5) {
      updateButtonState({ composer, button });
      return;
    }

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "⏳ Revising...";
    try {
      await onReviseDraft?.(draftText);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
      updateButtonState({ composer, button });
    }
  }

  function ensureButton() {
    const composer = adapter.getComposer?.();
    if (!composer) return;
    const container = findMountContainer(composer);
    if (!container) return;

    injectDraftReviseTooltipCSS();
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    removeStaleWrappers(container);
    attachComposerListeners(composer, container);

    let wrapper = getWrapper(container);
    if (!wrapper) {
      wrapper = document.createElement("span");
      wrapper.className = wrapperClass;
      wrapper.setAttribute("data-tooltip", "Type something to revise");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tl-revise-draft-btn";
      btn.textContent = "✨ Revise";
      btn.addEventListener("click", () => handleDraftReviseClick(btn));

      wrapper.appendChild(btn);
      container.appendChild(wrapper);
    }
    updateButtonState({ composer, container });
  }

  function start() {
    ensureButton();
    observer = new MutationObserver(ensureButton);
    observer.observe(document.body, { childList: true, subtree: true });
    logger.info("mounted");
  }

  function stop() {
    observer?.disconnect();
    observer = null;
  }

  start();
  return { start, stop };
}
