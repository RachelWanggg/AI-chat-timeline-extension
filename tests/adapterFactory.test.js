import test from "node:test";
import assert from "node:assert/strict";

import { createAdapter } from "../content/adapters/adapterFactory.js";
import { setLogLevel } from "../content/utils/logger.js";

// Unsupported hostnames are expected here; keep the warnings out of the test output.
setLogLevel("silent");

test("resolves the ChatGPT adapter for both ChatGPT hostnames", () => {
  assert.equal(createAdapter("chatgpt.com")?.id, "chatgpt");
  assert.equal(createAdapter("chat.openai.com")?.id, "chatgpt");
});

test("resolves the Claude adapter for claude.ai", () => {
  assert.equal(createAdapter("claude.ai")?.id, "claude");
});

test("matches subdomains of a supported host", () => {
  assert.equal(createAdapter("www.chatgpt.com")?.id, "chatgpt");
});

test("returns null for an unsupported hostname", () => {
  assert.equal(createAdapter("example.com"), null);
  assert.equal(createAdapter(""), null);
});

test("returns null for non-string input", () => {
  for (const input of [null, undefined, 42, {}, ["claude.ai"]]) {
    assert.equal(createAdapter(input), null);
  }
});

test("returns adapters exposing the interface the controller relies on", () => {
  for (const host of ["chatgpt.com", "claude.ai"]) {
    const adapter = createAdapter(host);
    assert.equal(typeof adapter.getComposer, "function");
    assert.equal(typeof adapter.insertText, "function");
    assert.equal(typeof adapter.getUserMessageNodes, "function");
  }
});
