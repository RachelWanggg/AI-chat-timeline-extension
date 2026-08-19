// content/chatgptFetchInterceptor.js
//
// Runs in the MAIN world, not the isolated world, so it can replace the page's real
// window.fetch. Before rendering any DOM, ChatGPT GETs /backend-api/conversation/{id},
// which returns the full message mapping -- every message, unaffected by virtual scrolling.
// We clone the response, parse it, rebuild the conversation in tree order, and hand the
// result to timelineController in the isolated world via a CustomEvent.
//
// Constraints:
// - Never disturb the original response: ChatGPT must still receive its body, hence
//   response.clone().
// - Fail silently on a parse error rather than breaking the page.
// - Only structured-cloneable data (strings, arrays, plain objects) can cross into the
//   isolated world.
(function () {
  "use strict";

  // Guard against double injection (HMR or a repeated run) wrapping fetch twice.
  if (window.__tlChatgptFetchPatched) return;
  window.__tlChatgptFetchPatched = true;

  var PREFIX = "[FetchInterceptor]";
  var EVENT_FETCHED = "chatgpt-conversation-fetched";
  var EVENT_REQUEST = "chatgpt-conversation-request";

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(PREFIX);
      console.debug.apply(console, args);
    } catch (e) {}
  }

  // Last successful parse, kept for replay. Interception starts at document_start but the
  // listener in the isolated world is only ready at document_idle, so the first conversation
  // fetch usually lands before anyone is listening. Once ready, the listener emits a request
  // event and we re-dispatch the cached result instead of losing the first screen.
  var cachedDetail = null;
  var lastDispatchedSignature = null;

  // Only intercept the conversation detail endpoint; ignore stream_status, textdocs, init, etc.
  function shouldIntercept(url) {
    if (!url || url.indexOf("/backend-api/conversation/") === -1) return false;
    if (url.indexOf("stream_status") !== -1) return false;
    if (url.indexOf("textdocs") !== -1) return false;
    if (url.indexOf("/init") !== -1) return false;
    return true;
  }

  // fetch's first argument may be a string, a URL, or a Request.
  function getUrlString(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url; // Request
      if (input && typeof input.href === "string") return input.href; // URL
      if (input != null) return String(input);
    } catch (e) {}
    return "";
  }

  // Extract plain text from a single message node by joining the strings in content.parts.
  function extractText(message) {
    var content = message && message.content;
    if (!content) return "";
    var parts = content.parts;
    if (!Array.isArray(parts)) return "";
    var text = parts
      .filter(function (p) {
        return typeof p === "string";
      })
      .join("\n");
    return text.replace(/​/g, "").trim();
  }

  // Rebuild messages in conversation-tree order: walk from current_node up through parent
  // links to the root, then reverse into chronological order. This yields the currently
  // active branch -- regenerate and edit create branches, and current_node points at the
  // live leaf.
  function extractMessages(data) {
    var mapping = data && data.mapping;
    if (!mapping || typeof mapping !== "object") return null;

    var nodeId = data.current_node;
    if (!nodeId || !mapping[nodeId]) {
      log("no usable current_node, skip");
      return null;
    }

    // Collect node ids while walking up (leaf -> root)
    var chain = [];
    var guard = 0;
    while (nodeId && mapping[nodeId] && guard < 100000) {
      chain.push(nodeId);
      nodeId = mapping[nodeId].parent;
      guard++;
    }
    chain.reverse(); // Now root -> leaf, i.e. chronological order

    var messages = [];
    for (var i = 0; i < chain.length; i++) {
      var node = mapping[chain[i]];
      var message = node && node.message;
      if (!message || !message.author) continue;

      var role = message.author.role;

      // Assistant messages whose recipient is not "all" (tool calls, reasoning) are noise.
      if (role === "assistant" && message.recipient && message.recipient !== "all") {
        continue;
      }

      if (role !== "user" && role !== "assistant") continue;

      var text = extractText(message);
      if (!text) continue; // Skip empty messages, including image-only and tool-only nodes

      messages.push({ role: role, id: chain[i], text: text });
    }

    return messages;
  }

  function getConversationId(data, url) {
    if (data && typeof data.conversation_id === "string") return data.conversation_id;
    var m = String(url || "").match(/\/backend-api\/conversation\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function dispatchFetched(detail) {
    try {
      // Avoid dispatching identical data twice (the same conversation can be fetched again).
      var signature = detail.conversationId + ":" + detail.messages.length;
      if (signature === lastDispatchedSignature) {
        // Replay is still allowed: by the time a request event fires, lastDispatchedSignature
        // is already set. This guard only suppresses spontaneous duplicates -- replay goes
        // through replayCached() and does not pass here.
        return;
      }
      lastDispatchedSignature = signature;
      window.dispatchEvent(new CustomEvent(EVENT_FETCHED, { detail: detail }));
      log("dispatched", detail.messages.length, "messages for", detail.conversationId);
    } catch (e) {
      log("dispatch failed", e);
    }
  }

  function replayCached() {
    if (!cachedDetail) return;
    try {
      window.dispatchEvent(new CustomEvent(EVENT_FETCHED, { detail: cachedDetail }));
      log("replayed cached", cachedDetail.messages.length, "messages");
    } catch (e) {
      log("replay failed", e);
    }
  }

  // Process the clone asynchronously so the original response reaches ChatGPT unblocked.
  function handleResponse(response, url) {
    response
      .clone()
      .json()
      .then(function (data) {
        var messages = extractMessages(data);
        if (!messages || messages.length === 0) return;
        var detail = {
          conversationId: getConversationId(data, url),
          messages: messages,
        };
        cachedDetail = detail;
        dispatchFetched(detail);
      })
      .catch(function (err) {
        log("parse failed (ignored)", err);
      });
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch !== "function") {
    log("window.fetch unavailable, abort");
    return;
  }

  window.fetch = function () {
    var args = arguments;
    var fetchPromise = originalFetch.apply(this, args);
    try {
      var url = getUrlString(args[0]);
      if (shouldIntercept(url)) {
        fetchPromise
          .then(function (response) {
            try {
              if (response && typeof response.clone === "function") {
                handleResponse(response, url);
              }
            } catch (e) {
              log("handleResponse threw (ignored)", e);
            }
            return response;
          })
          .catch(function () {});
      }
    } catch (e) {
      log("intercept wrapper threw (ignored)", e);
    }
    // Always return the original promise; never alter what ChatGPT receives.
    return fetchPromise;
  };

  // The isolated-world listener emits this once it is ready; replay the cached first screen.
  window.addEventListener(EVENT_REQUEST, replayCached);

  log("installed (MAIN world)");
})();
