import test from "node:test";
import assert from "node:assert/strict";

import { createChatgptVirtualization } from "../content/timeline/chatgptVirtualization.js";

test("an unmounted older ChatGPT search unit seeks upward instead of hijacking a visible row", () => {
  const container = {
    scrollTop: 0,
    clientHeight: 600,
    scrollHeight: 3000,
    flexDirection: "column-reverse",
  };
  const turns = [
    { kind: "search", messageId: "user-8", position: 8 },
    { kind: "search", messageId: "assistant-9", position: 9 },
  ];
  const virtualization = createChatgptVirtualization({
    getOrder: () => ["user-0", "assistant-1", "user-8", "assistant-9"],
    getTurns: () => turns,
    getMessageId: (turn) => turn.messageId,
    getTurnPosition: (turn) => turn.position,
    isSearchUnit: (turn) => turn.kind === "search",
    getScrollContainer: () => container,
  });

  assert.equal(virtualization.locatePlaceholder("user-0"), null);
  assert.equal(virtualization.seekMessage("user-0"), true);
  assert.equal(container.scrollTop, -510);
});

test("a legacy ChatGPT turn keeps using its retained placeholder", () => {
  const first = { kind: "legacy", messageId: null, position: 1 };
  const second = { kind: "legacy", messageId: "assistant-1", position: 2 };
  const virtualization = createChatgptVirtualization({
    getOrder: () => ["user-0", "assistant-1"],
    getTurns: () => [first, second],
    getMessageId: (turn) => turn.messageId,
    getTurnPosition: (turn) => turn.position,
    isSearchUnit: (turn) => turn.kind === "search",
    getScrollContainer: () => null,
  });

  assert.equal(virtualization.locatePlaceholder("user-0"), first);
  assert.equal(virtualization.findMounted("assistant-1"), second);
});

test("a newly mounted search unit becomes resolvable by its stable message id", () => {
  let turns = [{ kind: "search", messageId: "assistant-9", position: 9 }];
  const virtualization = createChatgptVirtualization({
    getOrder: () => ["assistant-1", "assistant-9"],
    getTurns: () => turns,
    getMessageId: (turn) => turn.messageId,
    getTurnPosition: (turn) => turn.position,
    isSearchUnit: (turn) => turn.kind === "search",
    getScrollContainer: () => null,
  });

  assert.equal(virtualization.findMounted("assistant-1"), null);
  const mounted = { kind: "search", messageId: "assistant-1", position: 1 };
  turns = [mounted];
  assert.equal(virtualization.findMounted("assistant-1"), mounted);
});
