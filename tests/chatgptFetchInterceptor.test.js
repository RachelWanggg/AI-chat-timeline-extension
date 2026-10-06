import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";

const interceptorSource = readFileSync(
  new URL("../content/chatgptFetchInterceptor.js", import.meta.url),
  "utf8"
);

test("normalizes the current top-level messages response", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://chatgpt.com/c/conversation-1",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.console.debug = () => {};

  const payload = {
    conversation_id: "conversation-1",
    current_node: "assistant-1",
    messages: [
      {
        id: "user-1",
        author: { role: "user" },
        content: { parts: ["Why is the timeline blank?"] },
      },
      {
        id: "assistant-1",
        author: { role: "assistant" },
        recipient: "all",
        content: { parts: ["## Root cause\n\nThe response schema changed."] },
      },
    ],
    page_info: { start_cursor: "user-1", has_previous_page: true },
  };

  window.fetch = () =>
    Promise.resolve({
      clone() {
        return { json: () => Promise.resolve(payload) };
      },
    });

  let detail = null;
  window.addEventListener("chatgpt-conversation-fetched", (event) => {
    detail = event.detail;
  });

  window.eval(interceptorSource);
  await window.fetch("/backend-api/conversations/conversation-1?num_turns=10");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(detail)), {
    conversationId: "conversation-1",
    currentNodeId: "assistant-1",
    messages: [
      { role: "user", id: "user-1", text: "Why is the timeline blank?" },
      {
        role: "assistant",
        id: "assistant-1",
        text: "## Root cause\n\nThe response schema changed.",
      },
    ],
  });

  dom.window.close();
});

test("loads and merges older pages from the current paginated endpoint", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://chatgpt.com/c/conversation-1",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.console.debug = () => {};

  const pages = {
    latest: {
      conversation_id: "conversation-1",
      current_node: "assistant-3",
      messages: [
        { id: "user-3", author: { role: "user" }, content: { parts: ["Question 3"] } },
        {
          id: "assistant-3",
          author: { role: "assistant" },
          recipient: "all",
          content: { parts: ["Answer 3"] },
        },
      ],
      page_info: { start_cursor: "user-3", has_previous_page: true },
    },
    "user-3": {
      conversation_id: "conversation-1",
      messages: [
        { id: "user-2", author: { role: "user" }, content: { parts: ["Question 2"] } },
        {
          id: "assistant-2",
          author: { role: "assistant" },
          recipient: "all",
          content: { parts: ["Answer 2"] },
        },
      ],
      page_info: { start_cursor: "user-2", has_previous_page: true },
    },
    "user-2": {
      conversation_id: "conversation-1",
      messages: [
        { id: "user-1", author: { role: "user" }, content: { parts: ["Question 1"] } },
        {
          id: "assistant-1",
          author: { role: "assistant" },
          recipient: "all",
          content: { parts: ["Answer 1"] },
        },
      ],
      page_info: { start_cursor: "user-1", has_previous_page: false },
    },
  };
  const requests = [];

  window.fetch = (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const cursor = new URL(url, window.location.origin).searchParams.get("before");
    const payload = cursor ? pages[cursor] : pages.latest;
    assert.ok(payload, `unexpected cursor in ${url}`);
    return Promise.resolve({
      clone() {
        return { json: () => Promise.resolve(payload) };
      },
      json() {
        return Promise.resolve(payload);
      },
    });
  };

  const received = [];
  window.addEventListener("chatgpt-conversation-fetched", (event) => {
    received.push(JSON.parse(JSON.stringify(event.detail)));
  });

  window.eval(interceptorSource);
  await window.fetch("/backend-api/conversations/conversation-1?num_turns=2", {
    headers: { "oai-device-id": "test-device" },
  });

  for (let attempt = 0; attempt < 10; attempt++) {
    if (received.at(-1)?.messages.length === 6) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(
    received.at(-1).messages.map((message) => message.id),
    ["user-1", "assistant-1", "user-2", "assistant-2", "user-3", "assistant-3"]
  );
  assert.deepEqual(
    requests.map((request) => new URL(request.url, window.location.origin).searchParams.get("before")),
    [null, "user-3", "user-2"]
  );
  assert.deepEqual(requests[1].init, { headers: { "oai-device-id": "test-device" } });

  dom.window.close();
});

test("emits the active ChatGPT branch for the current plural conversation endpoint", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://chatgpt.com/c/conversation-1",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.console.debug = () => {};

  const payload = {
    conversation_id: "conversation-1",
    current_node: "assistant-1",
    mapping: {
      root: { parent: null, message: null },
      "user-1": {
        parent: "root",
        message: {
          author: { role: "user" },
          content: { parts: ["Why is the timeline blank?"] },
        },
      },
      "assistant-1": {
        parent: "user-1",
        message: {
          author: { role: "assistant" },
          recipient: "all",
          content: { parts: ["## Root cause\n\nThe DOM changed."] },
        },
      },
    },
  };

  window.fetch = () =>
    Promise.resolve({
      clone() {
        return { json: () => Promise.resolve(payload) };
      },
    });

  let detail = null;
  window.addEventListener("chatgpt-conversation-fetched", (event) => {
    detail = event.detail;
  });

  window.eval(interceptorSource);
  await window.fetch("/backend-api/conversations/conversation-1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(detail)), {
    conversationId: "conversation-1",
    currentNodeId: "assistant-1",
    messages: [
      { role: "user", id: "user-1", text: "Why is the timeline blank?" },
      {
        role: "assistant",
        id: "assistant-1",
        text: "## Root cause\n\nThe DOM changed.",
      },
    ],
  });

  dom.window.close();
});

test("emits a changed branch even when the message count stays the same", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://chatgpt.com/c/conversation-1",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.console.debug = () => {};

  let assistantId = "assistant-1";
  window.fetch = () => {
    const currentAssistantId = assistantId;
    const payload = {
      conversation_id: "conversation-1",
      current_node: currentAssistantId,
      mapping: {
        "user-1": {
          parent: null,
          message: {
            author: { role: "user" },
            content: { parts: ["Question"] },
          },
        },
        [currentAssistantId]: {
          parent: "user-1",
          message: {
            author: { role: "assistant" },
            recipient: "all",
            content: { parts: [`Answer from ${currentAssistantId}`] },
          },
        },
      },
    };
    return Promise.resolve({
      clone() {
        return { json: () => Promise.resolve(payload) };
      },
    });
  };

  const received = [];
  window.addEventListener("chatgpt-conversation-fetched", (event) => {
    received.push(event.detail);
  });

  window.eval(interceptorSource);
  await window.fetch("/backend-api/conversations/conversation-1");
  await new Promise((resolve) => setImmediate(resolve));
  assistantId = "assistant-2";
  await window.fetch("/backend-api/conversations/conversation-1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.length, 2);
  assert.equal(received[1].currentNodeId, "assistant-2");
  assert.equal(received[1].messages.at(-1).id, "assistant-2");

  dom.window.close();
});
