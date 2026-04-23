export const MESSAGE_TYPES = {
  TIMELINE_UPDATE: "TIMELINE_UPDATE",
  TIMELINE_CLEAR: "TIMELINE_CLEAR",
  SCROLL_TO_ANCHOR: "SCROLL_TO_ANCHOR",
  ANCHOR_VISIBLE: "ANCHOR_VISIBLE",
  REPARSE_NOW: "REPARSE_NOW",
  ADD_PROMPT_FROM_CONTENT: "ADD_PROMPT_FROM_CONTENT",
  REVISE_VIA_API: "REVISE_VIA_API",
};

export const STORAGE_KEYS = {
  REVISE_MODE: "reviseMode",
  ANTHROPIC_API_KEY: "anthropicApiKey",
  ANTHROPIC_MODEL: "anthropicModel",
  PROMPT_LIBRARY: "promptLibrary",
  SETTINGS: "settings",
};

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];

const g = globalThis;
const defaultByDebugFlag = g.DEBUG ? "debug" : "info";
const rawLogLevel = typeof g.__TL_LOG_LEVEL === "string" ? g.__TL_LOG_LEVEL : defaultByDebugFlag;
export const DEFAULT_LOG_LEVEL = rawLogLevel.toLowerCase();
