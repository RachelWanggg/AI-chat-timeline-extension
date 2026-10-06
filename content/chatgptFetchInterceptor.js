// content/chatgptFetchInterceptor.js
//
// Runs in the MAIN world, not the isolated world, so it can replace the page's real
// window.fetch. ChatGPT fetches /backend-api/conversation/{id} (legacy) or
// /backend-api/conversations/{id} (current). The legacy response contains a message mapping;
// the current response contains an already ordered messages array. We clone the response,
// normalize either schema, and hand the result to timelineController in the isolated world
// via a CustomEvent.
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
  var paginationRunId = 0;
  var MAX_PAGINATION_PAGES = 100;

  // Only intercept the conversation detail endpoint; ignore stream_status, textdocs, init, etc.
  function shouldIntercept(url) {
    if (!url || !/\/backend-api\/conversations?\/[^/?#]+/i.test(url)) return false;
    if (/[?&](?:before|cursor)=/i.test(url)) return false;
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

  function normalizeMessage(message, fallbackId) {
    if (!message || !message.author) return null;

    var role = message.author.role;

    // Assistant messages whose recipient is not "all" (tool calls, reasoning) are noise.
    if (role === "assistant" && message.recipient && message.recipient !== "all") {
      return null;
    }

    if (role !== "user" && role !== "assistant") return null;

    var text = extractText(message);
    if (!text) return null; // Skip empty messages, including image-only and tool-only nodes

    var id = typeof message.id === "string" && message.id ? message.id : fallbackId;
    if (!id) return null;
    return { role: role, id: id, text: text };
  }

  // Rebuild messages in conversation-tree order: walk from current_node up through parent
  // links to the root, then reverse into chronological order. This yields the currently
  // active branch -- regenerate and edit create branches, and current_node points at the
  // live leaf.
  function extractMessages(data) {
    // Current endpoint response. The server has already selected the active branch and put
    // messages in chronological order, so preserving array order is both simpler and safer.
    if (data && Array.isArray(data.messages)) {
      var orderedMessages = [];
      for (var arrayIndex = 0; arrayIndex < data.messages.length; arrayIndex++) {
        var normalized = normalizeMessage(data.messages[arrayIndex], null);
        if (normalized) orderedMessages.push(normalized);
      }
      return orderedMessages;
    }

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
      var normalizedMessage = normalizeMessage(node && node.message, chain[i]);
      if (normalizedMessage) messages.push(normalizedMessage);
    }

    return messages;
  }

  function getConversationId(data, url) {
    if (data && typeof data.conversation_id === "string") return data.conversation_id;
    var m = String(url || "").match(/\/backend-api\/conversations?\/([^/?#]+)/i);
    return m ? m[1] : null;
  }

  function mergeMessages(olderMessages, newerMessages) {
    var newerIds = Object.create(null);
    var seen = Object.create(null);
    var merged = [];
    var i;

    for (i = 0; i < newerMessages.length; i++) {
      newerIds[newerMessages[i].id] = true;
    }
    for (i = 0; i < olderMessages.length; i++) {
      var olderMessage = olderMessages[i];
      if (newerIds[olderMessage.id] || seen[olderMessage.id]) continue;
      seen[olderMessage.id] = true;
      merged.push(olderMessage);
    }
    for (i = 0; i < newerMessages.length; i++) {
      var newerMessage = newerMessages[i];
      if (seen[newerMessage.id]) continue;
      seen[newerMessage.id] = true;
      merged.push(newerMessage);
    }

    return merged;
  }

  function buildPageUrl(url, cursor) {
    try {
      var pageUrl = new URL(url, window.location.href);
      pageUrl.searchParams.set("before", cursor);
      return pageUrl.href;
    } catch (e) {
      return null;
    }
  }

  // ChatGPT's current endpoint is cursor-paginated. Reuse the exact request options from
  // ChatGPT's own request so required authentication/device headers are preserved.
  function fetchOlderPage(pageUrl, requestContext) {
    var input = requestContext.input;
    var init = requestContext.init;
    var fetchThis = requestContext.fetchThis;

    try {
      if (typeof Request !== "undefined" && input instanceof Request) {
        return originalFetch.call(fetchThis, new Request(pageUrl, input));
      }
    } catch (e) {
      log("could not clone Request; falling back to URL and init", e);
    }
    return originalFetch.call(fetchThis, pageUrl, init);
  }

  function loadOlderPages(data, detail, url, requestContext, runId, pageCount) {
    var pageInfo = data && data.page_info;
    var cursor = pageInfo && pageInfo.start_cursor;
    if (!pageInfo || !pageInfo.has_previous_page || !cursor) return;
    if (pageCount >= MAX_PAGINATION_PAGES) {
      log("pagination stopped at safety limit", MAX_PAGINATION_PAGES);
      return;
    }

    var pageUrl = buildPageUrl(url, cursor);
    if (!pageUrl) return;

    fetchOlderPage(pageUrl, requestContext)
      .then(function (response) {
        return response.json();
      })
      .then(function (pageData) {
        if (runId !== paginationRunId) return;

        var olderMessages = extractMessages(pageData);
        if (!olderMessages || olderMessages.length === 0) return;

        var mergedDetail = {
          conversationId: detail.conversationId,
          currentNodeId: detail.currentNodeId,
          messages: mergeMessages(olderMessages, detail.messages),
        };
        cachedDetail = mergedDetail;
        dispatchFetched(mergedDetail);

        var nextInfo = pageData && pageData.page_info;
        if (nextInfo && nextInfo.start_cursor === cursor && nextInfo.has_previous_page) {
          log("pagination cursor did not advance; stop");
          return;
        }
        loadOlderPages(pageData, mergedDetail, url, requestContext, runId, pageCount + 1);
      })
      .catch(function (err) {
        log("older-page fetch failed (ignored)", err);
      });
  }

  function dispatchFetched(detail) {
    try {
      // Avoid dispatching identical data twice while still detecting regeneration, edits, and
      // streaming completion. Message count alone is not enough because another active branch
      // can have exactly the same number of nodes.
      var messageSignature = detail.messages
        .map(function (message) {
          return message.id + ":" + message.role + ":" + message.text;
        })
        .join("\u001f");
      var signature =
        detail.conversationId + ":" + (detail.currentNodeId || "") + ":" + messageSignature;
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
  function handleResponse(response, url, requestContext) {
    response
      .clone()
      .json()
      .then(function (data) {
        var messages = extractMessages(data);
        if (!messages || messages.length === 0) return;
        var detail = {
          conversationId: getConversationId(data, url),
          currentNodeId: data.current_node || null,
          messages: messages,
        };
        cachedDetail = detail;
        dispatchFetched(detail);

        if (Array.isArray(data.messages)) {
          var runId = ++paginationRunId;
          loadOlderPages(data, detail, url, requestContext, runId, 0);
        }
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
    var fetchThis = this;
    var fetchPromise = originalFetch.apply(fetchThis, args);
    try {
      var url = getUrlString(args[0]);
      if (shouldIntercept(url)) {
        fetchPromise
          .then(function (response) {
            try {
              if (response && typeof response.clone === "function") {
                handleResponse(response, url, {
                  input: args[0],
                  init: args[1],
                  fetchThis: fetchThis,
                });
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
