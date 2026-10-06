import test from "node:test";
import assert from "node:assert/strict";

import {
  getClaudeConversationId,
  walkCurrentBranch,
  createClaudeConversationApi,
} from "../content/adapters/claudeConversationApi.js";
import { createClaudeTranscript } from "../content/adapters/claudeTranscript.js";
import { withDocument } from "./helpers/dom.js";

const CONV = "4b5c30fe-cf01-4295-9e14-bdb102fda39d";

const msg = (uuid, sender, text, parent) => ({
  uuid,
  sender,
  text: "",
  content: [{ type: "text", text }],
  parent_message_uuid: parent,
});

test("getClaudeConversationId reads the uuid from a chat path", () => {
  assert.equal(getClaudeConversationId(`/chat/${CONV}`), CONV);
  assert.equal(getClaudeConversationId("/recents"), null);
});

test("walkCurrentBranch follows the leaf and drops other branches", () => {
  const conversation = {
    current_leaf_message_uuid: "a2",
    chat_messages: [
      msg("u1", "human", "first", "root"),
      msg("a1", "assistant", "## Old answer", "u1"),
      msg("a2", "assistant", "## Retried answer", "u1"),
    ],
  };

  assert.deepEqual(walkCurrentBranch(conversation), [
    { uuid: "u1", role: "user", text: "first" },
    { uuid: "a2", role: "assistant", text: "## Retried answer" },
  ]);
});

test("walkCurrentBranch keeps only text blocks of a tool-using reply", () => {
  const conversation = {
    current_leaf_message_uuid: "a1",
    chat_messages: [
      {
        uuid: "a1",
        sender: "assistant",
        content: [
          { type: "tool_use", input: {} },
          { type: "tool_result", content: [] },
          { type: "text", text: "## Result" },
        ],
      },
    ],
  };

  assert.equal(walkCurrentBranch(conversation)[0].text, "## Result");
});

test("fetchBranch skips organizations that cannot see the conversation", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "/api/organizations") {
      return {
        ok: true,
        json: async () => [
          { uuid: "api-org", capabilities: ["api"] },
          { uuid: "chat-org", capabilities: ["chat"] },
        ],
      };
    }
    if (url.includes("chat-org")) {
      return {
        ok: true,
        json: async () => ({
          current_leaf_message_uuid: "u1",
          chat_messages: [msg("u1", "human", "hi", "root")],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const branch = await createClaudeConversationApi({ fetchImpl }).fetchBranch(CONV);

  assert.equal(branch.length, 1);
  assert.ok(calls[1].includes("chat-org"), "chat-capable org is tried first");
});

const branchFixture = [
  { uuid: "u0", role: "user", text: "Question zero" },
  { uuid: "a1", role: "assistant", text: "## Intro\n```\n# not a heading\n```\n## **Bold** part" },
  { uuid: "u2", role: "user", text: "Question two" },
  { uuid: "a3", role: "assistant", text: "Plain answer without any headings at all." },
];

async function withTranscript(html, fn, branch = branchFixture) {
  const ctx = withDocument(html);
  try {
    const transcript = createClaudeTranscript({ api: { fetchBranch: async () => branch } });
    transcript.syncConversation(`/chat/${CONV}`);
    await transcript.refresh();
    return fn(transcript, ctx);
  } finally {
    ctx.restore();
  }
}

const userRow = (index, uuid, text) =>
  `<div data-testid="transcript-row" data-index="${index}"><div data-turn-key="${uuid}">` +
  `<div data-testid="user-message"><p class="whitespace-pre-wrap">${text}</p></div></div></div>`;
const assistantRow = (index, inner) =>
  `<div data-testid="transcript-row" data-index="${index}"><div data-turn-key="x">` +
  `<div data-testid="assistant-message"><div class="standard-markdown">${inner}</div></div></div></div>`;

test("buildParsed covers the whole conversation, not only mounted rows", async () => {
  await withTranscript(userRow(2, "u2", "Question two"), (transcript) => {
    const { parsed, stale } = transcript.buildParsed();

    assert.equal(stale, false);
    assert.deepEqual(parsed.map((p) => p.id), ["tl-claude-0", "tl-claude-1", "tl-claude-2", "tl-claude-3"]);
    assert.deepEqual(parsed[1].anchors.map((a) => a.label), ["Intro", "Bold part"]);
    assert.equal(parsed[3].anchors[0].fallback.isParagraph, true);
  });
});

test("maps positions onto rows while only the tail is paged in", async () => {
  // Claude loaded only the last two messages, so they are data-index 0 and 1.
  const html = userRow(0, "u2", "Question two") + assistantRow(1, "<p>Plain answer without any headings at all.</p>");
  await withTranscript(html, (transcript, { document }) => {
    assert.equal(transcript.findSection("tl-claude-2"), document.querySelector('[data-testid="user-message"]'));
    assert.equal(transcript.findSection("tl-claude-3").dataset.index, "1");
    assert.equal(transcript.findSection("tl-claude-0"), null);
  });
});

test("flags mounted messages newer than the fetched branch as stale", async () => {
  const html = userRow(2, "u2", "Question two") + userRow(4, "new", "A brand new question");
  await withTranscript(html, (transcript) => {
    const { parsed, stale } = transcript.buildParsed();

    assert.equal(stale, true);
    assert.equal(parsed.at(-1).id, "tl-claude-4");
    assert.equal(parsed.at(-1).text, "A brand new question");
  });
});

test("falls back to mounted messages when the API is unavailable", async () => {
  await withTranscript(userRow(7, "u7", "Only mounted"), (transcript) => {
    const { parsed } = transcript.buildParsed();
    assert.deepEqual(parsed.map((p) => p.id), ["tl-claude-7"]);
  }, null);
});
