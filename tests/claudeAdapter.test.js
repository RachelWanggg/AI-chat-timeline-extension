import test from "node:test";
import assert from "node:assert/strict";

import { parseClaude, claudeAdapter } from "../content/adapters/claudeAdapter.js";
import { withDocument } from "./helpers/dom.js";

const userMessage = (text) =>
  `<div data-testid="user-message"><p class="whitespace-pre-wrap">${text}</p></div>`;

const assistantMessage = (inner) =>
  `<div class="font-claude-response"><div class="standard-markdown">${inner}</div></div>`;

/** Run `fn` against a document built from `html`, then restore the globals. */
function inDocument(html, fn) {
  const ctx = withDocument(html);
  try {
    return fn(ctx);
  } finally {
    ctx.restore();
  }
}

test("returns user and assistant entries in DOM order", () => {
  inDocument(
    userMessage("What is a binary search?") +
      assistantMessage("<h2>Concept</h2><h2>Complexity</h2>") +
      userMessage("Show me the code"),
    () => {
      const parsed = parseClaude();

      assert.deepEqual(
        parsed.map((item) => item.role),
        ["user", "assistant", "user"]
      );
      assert.equal(parsed[0].text, "What is a binary search?");
      assert.equal(parsed[2].text, "Show me the code");
    }
  );
});

test("extracts h1-h3 headings as assistant anchors", () => {
  inDocument(
    userMessage("Question") +
      assistantMessage("<h1>Overview</h1><h2>Details</h2><h3>Caveats</h3>"),
    () => {
      const [, assistant] = parseClaude();

      assert.deepEqual(
        assistant.anchors.map((a) => a.label),
        ["Overview", "Details", "Caveats"]
      );
    }
  );
});

test("ignores headings inside a code block", () => {
  inDocument(
    userMessage("Question") +
      assistantMessage("<h2>Real heading</h2><pre><h2># not a heading</h2></pre>"),
    () => {
      const [, assistant] = parseClaude();

      assert.deepEqual(
        assistant.anchors.map((a) => a.label),
        ["Real heading"]
      );
    }
  );
});

test("falls back to the first substantial paragraph when there are no headings", () => {
  inDocument(
    userMessage("Question") +
      assistantMessage("<p>ok</p><p>A binary search halves the range each step.</p>"),
    () => {
      const [, assistant] = parseClaude();

      assert.equal(assistant.anchors.length, 1);
      assert.match(assistant.anchors[0].label, /^A binary search halves/);
    }
  );
});

test("truncates a long paragraph fallback label", () => {
  const long = "This sentence is deliberately much longer than the forty character label budget.";
  inDocument(userMessage("Question") + assistantMessage(`<p>${long}</p>`), () => {
    const [, assistant] = parseClaude();

    assert.ok(assistant.anchors[0].label.length <= 41);
    assert.ok(assistant.anchors[0].label.endsWith("…"));
  });
});

test("drops assistant messages that yield no anchors", () => {
  inDocument(userMessage("Question") + assistantMessage("<p>ok</p>"), () => {
    assert.deepEqual(
      parseClaude().map((item) => item.role),
      ["user"]
    );
  });
});

test("skips empty user messages", () => {
  inDocument(userMessage("   ") + userMessage("Real question"), () => {
    const parsed = parseClaude();

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].text, "Real question");
  });
});

test("falls back to the full node text when a user message has no wrapper", () => {
  inDocument('<div data-testid="user-message"><pre>npm test</pre></div>', () => {
    assert.equal(parseClaude()[0].text, "npm test");
  });
});

test("assigns stable ids derived from position, not a running counter", () => {
  const html = userMessage("One") + assistantMessage("<h2>A</h2>") + userMessage("Two");

  const first = inDocument(html, () => parseClaude().map((item) => item.id));
  const second = inDocument(html, () => parseClaude().map((item) => item.id));

  assert.deepEqual(first, ["tl-user-0", "tl-assistant-0", "tl-user-1"]);
  assert.deepEqual(second, first, "ids must not drift across re-parses");
});

test("writes the generated ids back onto the DOM nodes", () => {
  inDocument(userMessage("Question") + assistantMessage("<h2>Heading</h2>"), ({ document }) => {
    const [, assistant] = parseClaude();

    assert.equal(document.querySelector('[data-testid="user-message"]').id, "tl-user-0");
    assert.equal(document.getElementById(assistant.anchors[0].id).textContent, "Heading");
  });
});

test("returns an empty result for a page with no conversation", () => {
  inDocument("<main><p>Nothing here</p></main>", () => {
    assert.deepEqual(parseClaude(), []);
  });
});

test("getComposer finds the chat input, then the ProseMirror editor", () => {
  inDocument('<div data-testid="chat-input"></div><div class="ProseMirror"></div>', () => {
    assert.equal(claudeAdapter.getComposer().dataset.testid, "chat-input");
  });

  inDocument('<div class="ProseMirror"></div>', () => {
    assert.ok(claudeAdapter.getComposer().classList.contains("ProseMirror"));
  });

  inDocument("<div></div>", () => {
    assert.equal(claudeAdapter.getComposer(), null);
  });
});
