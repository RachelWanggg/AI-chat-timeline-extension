import test from "node:test";
import assert from "node:assert/strict";

import { buildTimelineFromParsed } from "../content/timeline/parser.js";

const userTurn = (id, text) => ({ id, role: "user", text });
const assistantTurn = (anchors) => ({ role: "assistant", anchors });

test("groups assistant anchors under the preceding user turn", () => {
  const timeline = buildTimelineFromParsed([
    userTurn("u1", "What is a binary search?"),
    assistantTurn([
      { id: "a1", label: "Concept" },
      { id: "a2", label: "Complexity" },
    ]),
    userTurn("u2", "Show me the code"),
    assistantTurn([{ id: "a3", label: "Python" }]),
  ]);

  assert.deepEqual(timeline, [
    {
      id: "u1",
      userText: "What is a binary search?",
      assistantAnchors: [
        { id: "a1", label: "Concept" },
        { id: "a2", label: "Complexity" },
      ],
    },
    {
      id: "u2",
      userText: "Show me the code",
      assistantAnchors: [{ id: "a3", label: "Python" }],
    },
  ]);
});

test("accumulates anchors from consecutive assistant messages into one turn", () => {
  const timeline = buildTimelineFromParsed([
    userTurn("u1", "Question"),
    assistantTurn([{ id: "a1", label: "First" }]),
    assistantTurn([{ id: "a2", label: "Second" }]),
  ]);

  assert.equal(timeline.length, 1);
  assert.deepEqual(
    timeline[0].assistantAnchors.map((a) => a.id),
    ["a1", "a2"]
  );
});

test("drops assistant messages that appear before any user turn", () => {
  const timeline = buildTimelineFromParsed([
    assistantTurn([{ id: "orphan", label: "No turn yet" }]),
    userTurn("u1", "Question"),
  ]);

  assert.equal(timeline.length, 1);
  assert.deepEqual(timeline[0].assistantAnchors, []);
});

test("skips user messages without an id", () => {
  const timeline = buildTimelineFromParsed([
    { role: "user", text: "no id" },
    assistantTurn([{ id: "a1", label: "Attached to nothing" }]),
  ]);

  assert.deepEqual(timeline, []);
});

test("skips anchors without an id", () => {
  const timeline = buildTimelineFromParsed([
    userTurn("u1", "Question"),
    assistantTurn([{ label: "missing id" }, { id: "a1", label: "kept" }]),
  ]);

  assert.deepEqual(timeline[0].assistantAnchors, [{ id: "a1", label: "kept" }]);
});

test("truncates user text to 50 characters with an ellipsis", () => {
  const long = "x".repeat(80);
  const [turn] = buildTimelineFromParsed([userTurn("u1", long)]);

  assert.equal(turn.userText.length, 50);
  assert.ok(turn.userText.endsWith("…"));
});

test("leaves text at exactly the limit untouched", () => {
  const exact = "y".repeat(50);
  const [turn] = buildTimelineFromParsed([userTurn("u1", exact)]);

  assert.equal(turn.userText, exact);
});

test("trims surrounding whitespace from user text", () => {
  const [turn] = buildTimelineFromParsed([userTurn("u1", "  spaced out  ")]);

  assert.equal(turn.userText, "spaced out");
});

test("returns an empty timeline for empty, null, and undefined input", () => {
  assert.deepEqual(buildTimelineFromParsed([]), []);
  assert.deepEqual(buildTimelineFromParsed(null), []);
  assert.deepEqual(buildTimelineFromParsed(undefined), []);
});

test("ignores null entries and unknown roles", () => {
  const timeline = buildTimelineFromParsed([
    null,
    userTurn("u1", "Question"),
    { role: "system", text: "ignored" },
  ]);

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].id, "u1");
});

test("handles a user turn with no text", () => {
  const [turn] = buildTimelineFromParsed([{ id: "u1", role: "user" }]);

  assert.equal(turn.userText, "");
});
