/**
 * Prompt builder: generate revision prompt text only.
 * Does NOT call runtime messaging and does NOT show UI.
 */
export function buildRevisionPrompt(originalText, options = {}) {
  const tone = options.tone || "clear, concise, and specific";
  const extra = options.extraInstruction
    ? `\nExtra instruction: ${options.extraInstruction}`
    : "";
  return [
    "Please revise and improve the following prompt.",
    `Target style: ${tone}.`,
    "Return only the revised prompt, no explanation.",
    extra,
    "",
    "Original prompt:",
    "---",
    (originalText || "").trim(),
    "---",
  ].join("\n");
}
