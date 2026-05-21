// content/chatgptFetchInterceptor.js
//
// 运行在 MAIN world（不是 isolated world），目的是能改写页面真正的 window.fetch。
// ChatGPT 在 DOM 渲染前会 GET /backend-api/conversation/{id} 拿到完整 mapping，
// 里面包含所有消息（不受虚拟滚动影响）。我们克隆响应、解析、按对话树顺序还原，
// 然后用 CustomEvent 把结果丢给 isolated world 的 timelineController。
//
// 约束：
// - 绝不破坏原始响应，ChatGPT 必须照常拿到 body（所以用 response.clone()）。
// - 解析失败时静默回退，不影响页面。
// - 与 isolated world 之间只能传可结构化克隆的数据（字符串/数组/普通对象）。
(function () {
  "use strict";

  // 防止重复注入（HMR / 多次执行）覆盖两次 fetch。
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

  // 最近一次成功解析的结果，用于 replay：
  // 拦截发生在 document_start，而监听方（isolated world）在 document_idle 才就绪，
  // 首屏的 conversation fetch 很可能早于监听器注册。监听器就绪后会发一个 request
  // 事件，我们把缓存的结果重新 dispatch 一次，避免首屏丢数据。
  var cachedDetail = null;
  var lastDispatchedSignature = null;

  // 只拦截 conversation 详情接口，排除 stream_status / textdocs / init 等噪音。
  function shouldIntercept(url) {
    if (!url || url.indexOf("/backend-api/conversation/") === -1) return false;
    if (url.indexOf("stream_status") !== -1) return false;
    if (url.indexOf("textdocs") !== -1) return false;
    if (url.indexOf("/init") !== -1) return false;
    return true;
  }

  // fetch 的第一个参数可能是 string / URL / Request。
  function getUrlString(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url; // Request
      if (input && typeof input.href === "string") return input.href; // URL
      if (input != null) return String(input);
    } catch (e) {}
    return "";
  }

  // 从单个 message node 里抽取纯文本（拼接 content.parts 中的字符串）。
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

  // 按对话树顺序还原消息：从 current_node 沿 parent 一路回溯到根，再反转成时间顺序。
  // 这样拿到的是「当前激活分支」（regenerate/edit 会产生分支，current_node 指向活跃叶子）。
  function extractMessages(data) {
    var mapping = data && data.mapping;
    if (!mapping || typeof mapping !== "object") return null;

    var nodeId = data.current_node;
    if (!nodeId || !mapping[nodeId]) {
      log("no usable current_node, skip");
      return null;
    }

    // 回溯收集 node id（叶子 -> 根）
    var chain = [];
    var guard = 0;
    while (nodeId && mapping[nodeId] && guard < 100000) {
      chain.push(nodeId);
      nodeId = mapping[nodeId].parent;
      guard++;
    }
    chain.reverse(); // 变成根 -> 叶子（时间顺序）

    var messages = [];
    for (var i = 0; i < chain.length; i++) {
      var node = mapping[chain[i]];
      var message = node && node.message;
      if (!message || !message.author) continue;

      var role = message.author.role;

      // 工具调用 / reasoning 等 recipient 不是 all 的助手消息属于噪音，排除。
      if (role === "assistant" && message.recipient && message.recipient !== "all") {
        continue;
      }

      if (role !== "user" && role !== "assistant") continue;

      var text = extractText(message);
      if (!text) continue; // 跳过空消息（含纯图片/纯工具节点）

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
      // 避免完全相同的数据重复 dispatch（同一对话的多次 GET）。
      var signature = detail.conversationId + ":" + detail.messages.length;
      if (signature === lastDispatchedSignature) {
        // 仍然允许 replay（request 触发时 lastDispatchedSignature 已设过），
        // 这里只拦截「主动重复」，replay 走 replayCached() 不经过这里。
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

  // 异步处理克隆体，不阻塞返回给 ChatGPT 的原始响应。
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
    // 永远返回原始 promise，绝不改动 ChatGPT 拿到的响应。
    return fetchPromise;
  };

  // isolated world 的监听器就绪后会发这个事件，我们把首屏缓存补发一次。
  window.addEventListener(EVENT_REQUEST, replayCached);

  log("installed (MAIN world)");
})();
