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
