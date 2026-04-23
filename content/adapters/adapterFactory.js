import { createLogger } from "../utils/logger.js";
import { chatgptAdapter } from "./chatgptAdapter.js";
import { claudeAdapter } from "./claudeAdapter.js";

/**
 * Adapter factory: map hostname -> platform adapter.
 * Does NOT parse timeline, call APIs, or mutate global app state.
 */
export function createAdapter(hostname) {
  const logger = createLogger("Adapter");

  if (typeof hostname !== "string") return null;

  if (hostname.includes("chatgpt.com") || hostname.includes("chat.openai.com")) {
    logger.debug("resolved chatgpt adapter");
    return chatgptAdapter;
  }
  if (hostname.includes("claude.ai")) {
    logger.debug("resolved claude adapter");
    return claudeAdapter;
  }
  logger.warn("unsupported hostname:", hostname);
  return null;
}
