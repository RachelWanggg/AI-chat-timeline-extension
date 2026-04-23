import { createLogger } from "../utils/logger.js";
import { STORAGE_KEYS } from "../utils/constants.js";

/**
 * Setup modal UI for revise config.
 * Does NOT execute revision requests and does NOT parse timeline data.
 */
function saveConfig({ reviseMode, anthropicApiKey, anthropicModel }) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [STORAGE_KEYS.REVISE_MODE]: reviseMode,
        [STORAGE_KEYS.ANTHROPIC_API_KEY]: anthropicApiKey,
        [STORAGE_KEYS.ANTHROPIC_MODEL]: anthropicModel,
      },
      () => resolve()
    );
  });
}

export function createSetupModal() {
  const logger = createLogger("UI.SetupModal");

  async function open() {
    document.getElementById("tl-setup-modal")?.remove();

    const root = document.createElement("div");
    root.id = "tl-setup-modal";
    root.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;" +
      "display:flex;align-items:center;justify-content:center;";

    const card = document.createElement("div");
    card.style.cssText =
      "width:min(460px,92vw);background:#1f1f1f;color:#fff;border:1px solid #333;" +
      "border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;";
    card.addEventListener("click", (e) => e.stopPropagation());

    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "sk-ant-...";

    const modelInput = document.createElement("input");
    modelInput.placeholder = "claude-haiku-4-5";
    modelInput.value = "claude-haiku-4-5";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      await saveConfig({
        reviseMode: "pro",
        anthropicApiKey: keyInput.value.trim(),
        anthropicModel: modelInput.value.trim() || "claude-haiku-4-5",
      });
      root.remove();
    });

    card.appendChild(keyInput);
    card.appendChild(modelInput);
    card.appendChild(saveBtn);
    root.appendChild(card);
    root.addEventListener("click", () => root.remove());
    document.body.appendChild(root);

    logger.info("opened");
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.getElementById("tl-setup-modal")) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  return { open };
}
