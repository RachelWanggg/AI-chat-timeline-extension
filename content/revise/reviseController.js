import { createLogger } from "../utils/logger.js";
import { STORAGE_KEYS } from "../utils/constants.js";

/**
 * Revise controller: feature flow + state orchestration.
 * Does NOT perform raw DOM querying and does NOT own platform selectors.
 */
function loadReviseConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        STORAGE_KEYS.REVISE_MODE,
        STORAGE_KEYS.ANTHROPIC_API_KEY,
        STORAGE_KEYS.ANTHROPIC_MODEL,
      ],
      (r) => {
        resolve({
          reviseMode: r[STORAGE_KEYS.REVISE_MODE] ?? null,
          anthropicApiKey: r[STORAGE_KEYS.ANTHROPIC_API_KEY] ?? "",
          anthropicModel: r[STORAGE_KEYS.ANTHROPIC_MODEL] ?? "claude-haiku-4-5",
        });
      }
    );
  });
}

export function createReviseController({
  adapter,
  store,
  promptBuilder,
  reviseService,
  revisionModal,
}) {
  const logger = createLogger("Revise");
  let toastStyleInjected = false;

  function showToast(message, type = "info") {
    if (!message) return;

    if (!toastStyleInjected) {
      const style = document.createElement("style");
      style.id = "tl-revise-toast-style";
      style.textContent = `
        .tl-revise-toast {
          position: fixed;
          left: 50%;
          bottom: 24px;
          transform: translateX(-50%);
          z-index: 9999999;
          max-width: min(560px, 90vw);
          padding: 10px 14px;
          border-radius: 8px;
          color: #fff;
          font-size: 13px;
          line-height: 1.4;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          opacity: 0;
          transition: opacity 0.14s ease;
          pointer-events: none;
        }
        .tl-revise-toast.tl-show { opacity: 1; }
        .tl-revise-toast.tl-info { background: rgba(34, 34, 34, 0.94); }
        .tl-revise-toast.tl-success { background: rgba(30, 122, 77, 0.94); }
        .tl-revise-toast.tl-error { background: rgba(160, 45, 45, 0.95); }
      `;
      document.head.appendChild(style);
      toastStyleInjected = true;
    }

    const toast = document.createElement("div");
    toast.className = `tl-revise-toast tl-${type}`;
    toast.textContent = String(message);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("tl-show"));

    setTimeout(() => {
      toast.classList.remove("tl-show");
      setTimeout(() => toast.remove(), 160);
    }, 2400);
  }

  async function ensureConfigReady() {
    const config = await loadReviseConfig();
    store.setState({ reviseConfig: config });
    return config;
  }

  async function handleSavePrompt({ title, text }) {
    const fallbackTitle = (text || "").slice(0, 30) || "Untitled Prompt";
    await reviseService.addPromptToLibrary({
      title: (title || fallbackTitle).trim(),
      text: (text || "").trim(),
    });
    logger.info("prompt saved");
  }

  async function executeRevision(inputText) {
    const config = await ensureConfigReady();
    if (!config.anthropicApiKey) {
      showToast("No API key set. Open Settings -> Revise Settings.", "error");
      return null;
    }
    const prompt = promptBuilder(inputText);
    try {
      return await reviseService.reviseViaBackground({
        prompt,
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
      });
    } catch (err) {
      if (err?.code === "INVALID_KEY") {
        showToast("Invalid API key. Update it in Settings -> Revise Settings.", "error");
      } else {
        showToast(`Revise failed: ${err?.message || "Unknown error"}`, "error");
      }
      logger.error("revision failed:", err);
      return null;
    }
  }

  async function handleMessageRevise({ text }) {
    const revised = await executeRevision(text);
    if (!revised) return;
    revisionModal.open({
      text: revised,
      onUseInComposer: () => {
        const composer = adapter.getComposer();
        adapter.insertText(composer, revised);
      },
    });
  }

  async function handleDraftRevise({ draftText }) {
    const revised = await executeRevision(draftText);
    if (!revised) return;
    revisionModal.open({
      text: revised,
      onUseInComposer: () => {
        const composer = adapter.getComposer();
        adapter.insertText(composer, revised);
      },
    });
  }

  return {
    handleSavePrompt,
    handleMessageRevise,
    handleDraftRevise,
  };
}
