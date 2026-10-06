import test from "node:test";
import assert from "node:assert/strict";

import { chatgptAdapter } from "../content/adapters/chatgptAdapter.js";
import { withDocument } from "./helpers/dom.js";

function inDocument(html, fn) {
  const ctx = withDocument(html);
  try {
    return fn(ctx);
  } finally {
    ctx.restore();
  }
}

const currentUserMessage = (turn, text) =>
  `<div data-content-search-unit-key="fallback-turn-${turn}:0:user">` +
  `<div data-user-message-bubble="true">${text}</div></div>`;

const currentAssistantMessage = (turn, id, inner) =>
  `<div data-content-search-unit-key="fallback-turn-${turn}:1:assistant" ` +
  `data-chatgpt-search-message-ids="${id} ${id}">` +
  `<h4 class="sr-only" data-conversation-role="assistant">ChatGPT said:</h4>` +
  `<div>${inner}</div></div>`;

test("parses current ChatGPT search-unit messages and assistant headings", () => {
  inDocument(
    currentUserMessage(4, "Why is the timeline blank?") +
      currentAssistantMessage(
        4,
        "assistant-1",
        "<h2>Root cause</h2><p>The DOM changed.</p>"
      ),
    () => {
      const turns = Array.from(document.querySelectorAll(chatgptAdapter.turnSelector));

      assert.equal(turns.length, 2);
      assert.equal(chatgptAdapter.isUserTurn(turns[0]), true);
      assert.equal(chatgptAdapter.isUserTurn(turns[1]), false);
      assert.deepEqual(chatgptAdapter.extractUserText(turns[0]), {
        text: "Why is the timeline blank?",
        domId: "tl-chatgpt-fallback-turn-4-0-user",
      });
      assert.equal(chatgptAdapter.getPairedAssistantMessageId(turns[0]), "assistant-1");
      assert.equal(chatgptAdapter.getMessageId(turns[1]), "assistant-1");
      assert.deepEqual(
        chatgptAdapter.extractAssistantAnchors(turns[1], 1).map(({ id, label }) => ({ id, label })),
        [{ id: "tl-anchor-assistant-1-h0", label: "Root cause" }]
      );
    }
  );
});

test("keeps parsing the legacy ChatGPT conversation-turn DOM", () => {
  inDocument(
    '<section data-testid="conversation-turn-1" data-turn="user">' +
      '<div data-message-id="user-1" data-message-author-role="user">' +
      '<div class="whitespace-pre-wrap">Legacy question</div></div></section>' +
      '<section data-testid="conversation-turn-2">' +
      '<div data-message-id="assistant-1" data-message-author-role="assistant">' +
      '<div class="standard-markdown"><h2>Legacy answer</h2></div></div></section>',
    () => {
      const turns = Array.from(document.querySelectorAll(chatgptAdapter.turnSelector));

      assert.equal(turns.length, 2);
      assert.deepEqual(chatgptAdapter.extractUserText(turns[0]), {
        text: "Legacy question",
        domId: "user-1",
      });
      assert.equal(chatgptAdapter.getMessageId(turns[1]), "assistant-1");
      assert.deepEqual(
        chatgptAdapter.extractAssistantAnchors(turns[1], 1).map(({ label }) => label),
        ["Legacy answer"]
      );
    }
  );
});
