import { createLogger } from "../utils/logger.js";

/**
 * Claude.ai conversation API client: fetch the full current branch of a conversation.
 * Claude virtualizes the transcript and pages older messages in lazily, so the DOM never
 * holds the whole conversation; this same-origin API (the one the page itself uses) does.
 * Does NOT touch the DOM.
 */

/** The conversation uuid from a Claude.ai path such as /chat/<uuid>, or null. */
export function getClaudeConversationId(pathname) {
  const m = String(pathname || "").match(/\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

/** Visible text of a message: its text content blocks (tool calls and results are skipped). */
export function getClaudeMessageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  return text || String(message?.text || "").trim();
}

/**
 * Walk from the current leaf up to the root, so edits and retries on other branches are
 * excluded. Returns [{ uuid, role: "user"|"assistant", text }] in conversation order; the
 * array index matches the transcript row's data-index once the whole conversation is paged in.
 */
export function walkCurrentBranch(conversation) {
  const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
  const byUuid = new Map(messages.map((m) => [m.uuid, m]));
  const branch = [];
  const seen = new Set();
  let cur = byUuid.get(conversation?.current_leaf_message_uuid);
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    branch.push(cur);
    cur = byUuid.get(cur.parent_message_uuid);
  }
  // Without a leaf pointer, fall back to the API's own ordering.
  const ordered = branch.length > 0
    ? branch.reverse()
    : messages.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((m) => ({
    uuid: m.uuid,
    role: m.sender === "human" ? "user" : "assistant",
    text: getClaudeMessageText(m),
  }));
}

export function createClaudeConversationApi({ fetchImpl = (...args) => fetch(...args) } = {}) {
  const logger = createLogger("ClaudeApi");
  let orgIds = null;

  async function getJson(url) {
    const res = await fetchImpl(url, { credentials: "include" });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Chat-capable organizations first; an account can also hold API-only orgs.
  async function listOrgIds() {
    if (orgIds) return orgIds;
    const orgs = await getJson("/api/organizations");
    const list = Array.isArray(orgs) ? orgs : [];
    const canChat = (o) => Array.isArray(o?.capabilities) && o.capabilities.includes("chat");
    orgIds = [...list.filter(canChat), ...list.filter((o) => !canChat(o))]
      .map((o) => o?.uuid)
      .filter(Boolean);
    return orgIds;
  }

  /** Fetch the current branch, or null if no organization can see the conversation. */
  async function fetchBranch(conversationId) {
    if (!conversationId) return null;
    const ids = await listOrgIds();
    for (const orgId of ids) {
      const url =
        `/api/organizations/${orgId}/chat_conversations/${conversationId}` +
        "?tree=True&rendering_mode=messages&render_all_tools=true";
      try {
        const conversation = await getJson(url);
        // Remember the org that worked so later fetches hit it first.
        orgIds = [orgId, ...ids.filter((id) => id !== orgId)];
        return walkCurrentBranch(conversation);
      } catch (err) {
        if (err?.status !== 403 && err?.status !== 404) throw err;
      }
    }
    logger.warn("conversation not visible to any organization", conversationId);
    return null;
  }

  return { fetchBranch };
}
