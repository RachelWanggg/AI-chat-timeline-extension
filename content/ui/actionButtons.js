import { createLogger } from "../utils/logger.js";

/**
 * Action buttons UI: inject Save/Revise buttons into user messages.
 * Does NOT call APIs directly and does NOT own revise business rules.
 */
export function mountActionButtons({ adapter, onSavePrompt, onRevisePrompt }) {
  const logger = createLogger("UI.ActionButtons");
  let observer = null;
  let ownerCounter = 0;
  const STYLE_VERSION = "v2";
  const TL_BTN_STYLE =
    "color:white;border:none;padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer;opacity:0.7;transition:opacity 0.2s;white-space:nowrap;";

  function createButton(label, className) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.className = className;
    return btn;
  }

  function styleActionRow(row, isClaude) {
    row.style.cssText = isClaude
      ? "display:flex;gap:6px;padding:2px 0;margin-top:2px;"
      : "display:flex;gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap;align-self:flex-end;";
  }

  function styleActionButton(button, background) {
    button.style.cssText = `${TL_BTN_STYLE}background:${background};`;
    button.onmouseover = () => {
      button.style.opacity = "1";
    };
    button.onmouseout = () => {
      button.style.opacity = "0.7";
    };
  }

  function getMountAnchor(messageEl) {
    if (!messageEl) return null;
    if (adapter?.id === "claude") {
      return messageEl.parentElement?.parentElement?.parentElement || messageEl.parentElement || messageEl;
    }
    return messageEl;
  }

  function ensureOwnerId(messageEl) {
    if (!messageEl.dataset.tlActionOwner) {
      ownerCounter += 1;
      messageEl.dataset.tlActionOwner = `tl-action-owner-${ownerCounter}`;
    }
    return messageEl.dataset.tlActionOwner;
  }

  function inject() {
    const isClaude = adapter?.id === "claude";
    const userMessages = adapter.getUserMessageNodes?.() || [];
    userMessages.forEach((messageEl) => {
      const mountAnchor = getMountAnchor(messageEl);
      if (!mountAnchor) return;

      const ownerId = ensureOwnerId(messageEl);
      const existingInside = messageEl.querySelector(".tl-msg-actions");
      if (existingInside && existingInside.dataset.tlStyleVersion !== STYLE_VERSION) {
        existingInside.remove();
      }

      const existing = document.querySelector(`.tl-msg-actions[data-tl-action-owner="${ownerId}"]`);
      if (existing) {
        if (existing.dataset.tlStyleVersion !== STYLE_VERSION) {
          existing.remove();
        } else {
          styleActionRow(existing, isClaude);
          if (mountAnchor.nextElementSibling !== existing) {
            mountAnchor.insertAdjacentElement("afterend", existing);
          }
          return;
        }
      }

      if (existingInside && existingInside.dataset.tlStyleVersion === STYLE_VERSION) {
        styleActionRow(existingInside, isClaude);
        if (mountAnchor.nextElementSibling !== existingInside) {
          mountAnchor.insertAdjacentElement("afterend", existingInside);
        }
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = isClaude ? "tl-msg-actions tl-action-row" : "tl-msg-actions tl-btn-row";
      wrap.dataset.tlActionOwner = ownerId;
      wrap.dataset.tlStyleVersion = STYLE_VERSION;
      styleActionRow(wrap, isClaude);

      const saveBtn = createButton("📚 Save to Prompt Library", "tl-action-btn tl-save-prompt-btn");
      const reviseBtn = createButton("✨ Revise", "tl-action-btn tl-revise-btn");
      styleActionButton(saveBtn, "#5b9cf6");
      styleActionButton(reviseBtn, "#7c4dff");

      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const text = (messageEl.innerText || "").trim();
        if (!text) return;

        const defaultLabel = "📚 Save to Prompt Library";
        saveBtn.disabled = true;
        try {
          const title = `Saved from ${window.location.host} at ${new Date().toLocaleTimeString()}`;
          await onSavePrompt?.({ title, text });
          saveBtn.textContent = "✅ Saved!";
          setTimeout(() => {
            saveBtn.textContent = defaultLabel;
          }, 2000);
        } catch (error) {
          logger.warn("save prompt failed:", error);
          saveBtn.textContent = "❌ Save failed";
          setTimeout(() => {
            saveBtn.textContent = defaultLabel;
          }, 2000);
        } finally {
          saveBtn.disabled = false;
        }
      });

      reviseBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const text = (messageEl.innerText || "").trim();
        if (!text) return;

        const originalLabel = reviseBtn.textContent;
        reviseBtn.disabled = true;
        reviseBtn.textContent = "⏳ Revising...";
        try {
          await onRevisePrompt?.({ text });
        } finally {
          reviseBtn.disabled = false;
          reviseBtn.textContent = originalLabel;
        }
      });

      wrap.appendChild(saveBtn);
      wrap.appendChild(reviseBtn);
      mountAnchor.insertAdjacentElement("afterend", wrap);
    });
  }

  function start() {
    inject();
    observer = new MutationObserver(inject);
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
