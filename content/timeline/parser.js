/**
 * Timeline parser (pure): convert parsed turns -> TimelineTurn[].
 * Does NOT query DOM, send messages, or attach event listeners.
 */
function truncate(text, max = 50) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * @param {Array<{id?:string, role:'user'|'assistant', text?:string, anchors?:Array<{id:string,label:string}>}>} parsed
 * @returns {Array<{id:string, userText:string, assistantAnchors:Array<{id:string,label:string}>}>}
 */
export function buildTimelineFromParsed(parsed) {
  const result = [];
  let currentTurn = null;

  (parsed || []).forEach((item) => {
    if (!item) return;
    if (item.role === "user") {
      if (!item.id) return;
      currentTurn = {
        id: item.id,
        userText: truncate(item.text),
        assistantAnchors: [],
      };
      result.push(currentTurn);
      return;
    }
    if (!currentTurn || item.role !== "assistant") return;
    (item.anchors || []).forEach((anchor) => {
      if (anchor?.id) {
        currentTurn.assistantAnchors.push({ id: anchor.id, label: anchor.label });
      }
    });
  });

  return result;
}

const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Strip inline markdown so a heading parsed from raw text matches the rendered heading's
 * textContent: **bold**, _em_, `code`, [link](url), and ~~strike~~.
 */
export function stripInlineMarkdown(text) {
  return String(text || "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/** Extract h1-h3 heading labels from markdown text, skipping fenced code blocks. */
export function extractHeadingsFromMarkdown(text) {
  const headings = [];
  let inFence = false;
  String(text || "").split("\n").forEach((line) => {
    if (FENCE_RE.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) headings.push(stripInlineMarkdown(m[2]));
  });
  return headings.filter(Boolean);
}

/** With no headings, the first meaningful line becomes the label of a single anchor. */
export function firstParagraphLabel(text) {
  let inFence = false;
  for (const line of String(text || "").split("\n")) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const t = stripInlineMarkdown(line).replace(/[#>*_`~-]/g, " ").replace(/\s+/g, " ").trim();
    if (t.length > 10) return t.length > 40 ? t.slice(0, 39) + "…" : t;
  }
  return "";
}
