import { createLogger } from "../utils/logger.js";
import { MESSAGE_TYPES } from "../utils/constants.js";

/**
 * Revise service: all background/API messaging for revision.
 * Does NOT own button state and does NOT parse DOM.
 */
export function createReviseService() {
  const logger = createLogger("ReviseService");

  function reviseViaBackground({ prompt, apiKey, model }) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: MESSAGE_TYPES.REVISE_VIA_API, prompt, apiKey, model },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.ok) {
            resolve(response.text);
            return;
          }
          const error = new Error(response?.error || "Revision failed");
          error.code = response?.code || null;
          reject(error);
        }
      );
    });
  }

  function addPromptToLibrary({ title, text }) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: MESSAGE_TYPES.ADD_PROMPT_FROM_CONTENT, title, text },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.ok) {
            resolve(true);
            return;
          }
          reject(new Error(response?.error || "Save prompt failed"));
        }
      );
    });
  }

  logger.debug("service initialized");

  return {
    reviseViaBackground,
    addPromptToLibrary,
  };
}
