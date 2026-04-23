import { DEFAULT_LOG_LEVEL } from "./constants.js";

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let currentLevel = LEVEL_WEIGHT[DEFAULT_LOG_LEVEL] ? DEFAULT_LOG_LEVEL : "info";

function normalizeLevel(level) {
  const normalized = String(level || "").toLowerCase();
  return LEVEL_WEIGHT[normalized] ? normalized : "info";
}

export function setLogLevel(level) {
  currentLevel = normalizeLevel(level);
}

export function getLogLevel() {
  return currentLevel;
}

function shouldLog(level) {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLevel];
}

export function createLogger(moduleName) {
  const scope = moduleName || "App";
  const prefix = `[Timeline][${scope}]`;

  return {
    debug(...args) {
      if (!shouldLog("debug")) return;
      console.debug(prefix, ...args);
    },
    info(...args) {
      if (!shouldLog("info")) return;
      console.info(prefix, ...args);
    },
    warn(...args) {
      if (!shouldLog("warn")) return;
      console.warn(prefix, ...args);
    },
    error(...args) {
      if (!shouldLog("error")) return;
      console.error(prefix, ...args);
    },
  };
}
