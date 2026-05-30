const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9+/=_-]{32,}\b/g;

function getTextLength(value) {
  return String(value || "").length;
}

function countMatches(text, re) {
  const matches = String(text || "").match(re);
  return matches ? matches.join("").length : 0;
}

function estimateDenseTokens(text) {
  const value = String(text || "");
  const urlChars = countMatches(value, URL_RE);
  const longTokenChars = countMatches(value, LONG_TOKEN_RE);
  return Math.ceil((urlChars + longTokenChars) / 1.8);
}

function classifyPlainText(text) {
  const value = String(text || "");
  const length = value.length;
  if (!length) return "empty";

  const cjkChars = countMatches(value, CJK_RE);
  const punctuationChars = countMatches(value, /[{}\[\]();,:|=<>]/g);
  const lineCount = value.split("\n").length;
  const hasStructuredShape =
    punctuationChars / length > 0.12 ||
    /(^|\n)\s*[-*+]\s+\S/.test(value) ||
    /(^|\n)\s*\d+\.\s+\S/.test(value) ||
    /(^|\n)\s*(ERROR|WARN|INFO|DEBUG|Traceback|Exception|at\s+\S+)/.test(value);

  if (hasStructuredShape || lineCount > 12) return "structured";
  if (cjkChars / length > 0.35) return "cjk-heavy";
  return "normal";
}

function estimatePlainTextTokens(text) {
  const value = String(text || "");
  if (!value) return 0;

  const cjkChars = countMatches(value, CJK_RE);
  const denseTokens = estimateDenseTokens(value);
  const denseChars = Math.min(
    value.length,
    countMatches(value, URL_RE) + countMatches(value, LONG_TOKEN_RE)
  );
  const remainingChars = Math.max(0, value.length - cjkChars - denseChars);
  const density = classifyPlainText(value);
  const latinDivisor = density === "structured" ? 2.7 : 4;

  return Math.ceil(cjkChars * 1.05 + remainingChars / latinDivisor + denseTokens);
}

function estimateCodeTokens(text) {
  const value = String(text || "");
  if (!value) return 0;

  const cjkChars = countMatches(value, CJK_RE);
  const remainingChars = Math.max(0, value.length - cjkChars);
  return Math.ceil(cjkChars + remainingChars / 2.35);
}

function getMessageTextParts(el) {
  const codeNodes = Array.from(el.querySelectorAll("pre"));
  const codeText = codeNodes.map((node) => node.textContent || "").join("\n");

  if (codeNodes.length === 0) {
    return {
      plainText: el.textContent || "",
      codeText: "",
    };
  }

  const clone = el.cloneNode(true);
  clone.querySelectorAll("pre").forEach((node) => node.remove());
  return {
    plainText: clone.textContent || "",
    codeText,
  };
}

function inferRole(el) {
  const role = el.getAttribute?.("data-message-author-role");
  if (role === "user" || role === "assistant") return role;
  if (el.matches?.('div[data-testid="user-message"]')) return "user";
  if (el.matches?.("div.font-claude-response")) return "assistant";
  return "message";
}

function resolveConversationDensity(messageStats) {
  if (messageStats.length === 0) return "normal";
  const codeTokens = messageStats.reduce((sum, item) => sum + item.codeTokens, 0);
  const totalTokens = messageStats.reduce((sum, item) => sum + item.tokens, 0);
  const cjkHeavyCount = messageStats.filter((item) => item.density === "cjk-heavy").length;
  const structuredCount = messageStats.filter((item) => item.density === "structured").length;

  if (totalTokens > 0 && codeTokens / totalTokens > 0.22) return "code-heavy";
  if (structuredCount / messageStats.length >= 0.35) return "structured";
  if (cjkHeavyCount / messageStats.length >= 0.45) return "cjk-heavy";
  return "normal";
}

function getSafetyMultiplier(density) {
  if (density === "code-heavy" || density === "structured") return 1.25;
  if (density === "cjk-heavy") return 1.2;
  return 1.15;
}

export function estimateMessageTokens(el) {
  const role = inferRole(el);
  const { plainText, codeText } = getMessageTextParts(el);
  const plainTokens = estimatePlainTextTokens(plainText);
  const codeTokens = estimateCodeTokens(codeText);
  const overhead = role === "assistant" ? 16 : role === "user" ? 12 : 10;
  const text = `${plainText}\n${codeText}`.trim();
  const density = codeText ? "code-heavy" : classifyPlainText(text);

  return {
    role,
    chars: getTextLength(text),
    tokens: plainTokens + codeTokens + overhead,
    plainTokens,
    codeTokens,
    density,
  };
}

export function estimateContextStats(messageEls, platform) {
  const messages = Array.from(messageEls || []).filter(Boolean);
  const messageStats = messages.map((el) => estimateMessageTokens(el));
  const rawTokens = messageStats.reduce((sum, item) => sum + item.tokens, 0);
  const estimatedChars = messageStats.reduce((sum, item) => sum + item.chars, 0);
  const density = resolveConversationDensity(messageStats);
  const safetyMultiplier = getSafetyMultiplier(density);
  const estimatedTokens = Math.ceil(rawTokens * safetyMultiplier);
  const largestMessageTokens = messageStats.reduce(
    (max, item) => Math.max(max, Math.ceil(item.tokens * safetyMultiplier)),
    0
  );

  return {
    estimatedChars,
    estimatedTokens,
    platform,
    messageCount: messageStats.length,
    largestMessageTokens,
    density,
    estimated: true,
    algorithm: "heuristic-v2",
  };
}
