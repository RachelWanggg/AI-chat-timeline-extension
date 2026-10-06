import test from "node:test";
import assert from "node:assert/strict";

import { parseClaude, claudeAdapter } from "../content/adapters/claudeAdapter.js";
import { withDocument } from "./helpers/dom.js";

const userMessage = (text) =>
  `<div data-testid="user-message"><p class="whitespace-pre-wrap">${text}</p></div>`;

const assistantMessage = (inner) =>
  `<div data-testid="assistant-message">` +
  `<h2 class="sr-only">Claude responded: summary</h2>` +
  `<div class="standard-markdown">${inner}</div></div>`;

const row = (index, inner) =>
  `<div data-testid="transcript-row" data-index="${index}">${inner}</div>`;

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

  assert.deepEqual(first, ["tl-claude-0", "tl-claude-1", "tl-claude-2"]);
  assert.deepEqual(second, first, "ids must not drift across re-parses");
});

test("keys virtualized rows by data-index plus the paging offset", () => {
  inDocument(
    row(4, userMessage("Later question")) + row(5, assistantMessage("<h2>Answer</h2>")),
    () => {
      const parsed = parseClaude({ indexOffset: 10 });

      assert.deepEqual(parsed.map((item) => item.id), ["tl-claude-14", "tl-claude-15"]);
      assert.equal(parsed[1].anchors[0].id, "tl-anchor-tl-claude-15-h0");
      assert.equal(parsed[1].anchors[0].fallback.sectionId, "tl-claude-15");
    }
  );
});

test("skips the visually hidden 'Claude responded' heading", () => {
  inDocument(userMessage("Question") + assistantMessage("<p>Just a plain paragraph answer.</p>"), () => {
    const [, assistant] = parseClaude();

    assert.equal(assistant.anchors.length, 1);
    assert.match(assistant.anchors[0].label, /^Just a plain paragraph/);
  });
});

test("still recognises the legacy .font-claude-response wrapper", () => {
  inDocument(
    userMessage("Question") +
      '<div class="font-claude-response"><div class="standard-markdown"><h2>Old</h2></div></div>',
    () => {
      assert.deepEqual(parseClaude()[1].anchors.map((a) => a.label), ["Old"]);
    }
  );
});

test("joins every paragraph of a user message and ignores injected buttons", () => {
  inDocument(
    '<div data-testid="user-message"><p class="whitespace-pre-wrap">Line one</p>' +
      '<p class="whitespace-pre-wrap">Line two</p>' +
      '<div class="tl-msg-actions"><span class="whitespace-pre-wrap">Save</span></div></div>',
    () => {
      assert.equal(parseClaude()[0].text, "Line one\nLine two");
    }
  );
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
