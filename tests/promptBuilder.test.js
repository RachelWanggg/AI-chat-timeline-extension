import test from "node:test";
import assert from "node:assert/strict";

import { buildRevisionPrompt } from "../content/revise/promptBuilder.js";

test("wraps the original prompt in delimiters", () => {
  const out = buildRevisionPrompt("Write me a haiku");

  assert.match(out, /Original prompt:\n---\nWrite me a haiku\n---$/);
});

test("applies the default target style", () => {
  const out = buildRevisionPrompt("anything");

  assert.match(out, /Target style: clear, concise, and specific\./);
});

test("uses a custom tone when given", () => {
  const out = buildRevisionPrompt("anything", { tone: "formal and terse" });

  assert.match(out, /Target style: formal and terse\./);
  assert.doesNotMatch(out, /clear, concise, and specific/);
});

test("appends an extra instruction when given", () => {
  const out = buildRevisionPrompt("anything", { extraInstruction: "Keep it under 20 words" });

  assert.match(out, /Extra instruction: Keep it under 20 words/);
});

test("omits the extra-instruction line by default", () => {
  const out = buildRevisionPrompt("anything");

  assert.doesNotMatch(out, /Extra instruction/);
});

test("always asks for the revised prompt only", () => {
  const out = buildRevisionPrompt("anything");

  assert.match(out, /Return only the revised prompt, no explanation\./);
});

test("trims whitespace around the original prompt", () => {
  const out = buildRevisionPrompt("\n  padded  \n");

  assert.match(out, /---\npadded\n---/);
});

test("does not throw on nullish input", () => {
  for (const input of [null, undefined, ""]) {
    const out = buildRevisionPrompt(input);
    assert.equal(typeof out, "string");
    assert.match(out, /---\n\n---$/);
  }
});
