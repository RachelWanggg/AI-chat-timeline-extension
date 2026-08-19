import test from "node:test";
import assert from "node:assert/strict";

import { estimateMessageTokens, estimateContextStats } from "../content/timeline/tokenEstimator.js";
import { makeElement } from "./helpers/dom.js";

test("infers the role from ChatGPT's author-role attribute", () => {
  const user = makeElement('<div data-message-author-role="user">hello</div>');
  const assistant = makeElement('<div data-message-author-role="assistant">hello</div>');

  assert.equal(estimateMessageTokens(user).role, "user");
  assert.equal(estimateMessageTokens(assistant).role, "assistant");
});

test("infers the role from the Claude selectors", () => {
  const user = makeElement('<div data-testid="user-message">hello</div>');
  const assistant = makeElement('<div class="font-claude-response">hello</div>');

  assert.equal(estimateMessageTokens(user).role, "user");
  assert.equal(estimateMessageTokens(assistant).role, "assistant");
});

test("falls back to a generic role for an unrecognised element", () => {
  assert.equal(estimateMessageTokens(makeElement("<div>hello</div>")).role, "message");
});

test("counts <pre> content as code and excludes it from plain text", () => {
  const el = makeElement(
    '<div data-message-author-role="assistant">' +
      "<p>Here is the fix</p><pre>const x = compute(value);</pre>" +
      "</div>"
  );
  const stats = estimateMessageTokens(el);

  assert.ok(stats.codeTokens > 0, "expected code tokens to be counted");
  assert.equal(stats.density, "code-heavy");
});

test("reports no code tokens for a message without <pre>", () => {
  const el = makeElement('<div data-message-author-role="assistant"><p>Plain answer</p></div>');

  assert.equal(estimateMessageTokens(el).codeTokens, 0);
});

test("charges CJK text more tokens per character than Latin text", () => {
  const latin = makeElement(`<div>${"a".repeat(100)}</div>`);
  const cjk = makeElement(`<div>${"中".repeat(100)}</div>`);

  assert.ok(
    estimateMessageTokens(cjk).tokens > estimateMessageTokens(latin).tokens,
    "CJK should cost more tokens for the same character count"
  );
});

test("adds only role overhead for an empty message", () => {
  const el = makeElement('<div data-message-author-role="user"></div>');
  const stats = estimateMessageTokens(el);

  assert.equal(stats.chars, 0);
  assert.equal(stats.plainTokens, 0);
  assert.equal(stats.codeTokens, 0);
  assert.equal(stats.tokens, 12); // user overhead
});

test("estimateContextStats sums messages and applies a safety multiplier", () => {
  const messages = [
    makeElement('<div data-message-author-role="user"><p>What is a binary search?</p></div>'),
    makeElement('<div data-message-author-role="assistant"><p>It halves the range.</p></div>'),
  ];
  const stats = estimateContextStats(messages, "chatgpt");
  const rawTokens = messages.reduce((sum, el) => sum + estimateMessageTokens(el).tokens, 0);

  assert.equal(stats.messageCount, 2);
  assert.equal(stats.platform, "chatgpt");
  assert.equal(stats.estimated, true);
  assert.equal(stats.algorithm, "heuristic-v2");
  assert.ok(stats.estimatedTokens > rawTokens, "safety multiplier should inflate the raw sum");
});

test("estimateContextStats reports the largest single message", () => {
  const short = makeElement("<div><p>Hi</p></div>");
  const long = makeElement(`<div><p>${"word ".repeat(200)}</p></div>`);
  const stats = estimateContextStats([short, long], "claude");

  assert.ok(stats.largestMessageTokens > estimateMessageTokens(short).tokens);
  assert.ok(stats.largestMessageTokens <= stats.estimatedTokens);
});

test("estimateContextStats classifies a code-heavy conversation", () => {
  const messages = [
    makeElement("<div><pre>" + "const value = compute(input);\n".repeat(40) + "</pre></div>"),
    makeElement("<div><p>ok</p></div>"),
  ];

  assert.equal(estimateContextStats(messages, "chatgpt").density, "code-heavy");
});

test("estimateContextStats tolerates empty and nullish input", () => {
  for (const input of [[], null, undefined, [null, undefined]]) {
    const stats = estimateContextStats(input, "chatgpt");
    assert.equal(stats.estimatedTokens, 0);
    assert.equal(stats.messageCount, 0);
    assert.equal(stats.density, "normal");
  }
});
