// content.js
// 职责：解析 ChatGPT/Claude 页面的对话结构，发送给 side panel

// 全局变量 id 计数器（monotonically increasing counter）
let anchorCounter = 0;



// ── 智能截断（smart truncate）
// 不在单词中间截断，在最近的空格处截断
// In interview language: this is called "word-boundary truncation"
function smartTruncate(text, maxLength) {
  if (text.length <= maxLength) return text;

  // 找到 maxLength 之前最近的空格
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLength * 0.6) {
    // 空格位置合理，在空格处截断
    return truncated.slice(0, lastSpace) + "…";
  }

  // 空格太靠前，直接截断
  return truncated + "…";
}

// ── 发送消息给插件侧添加 prompt ──
function addPromptFromContent(title, text) {
  chrome.runtime.sendMessage({
    type: "ADD_PROMPT_FROM_CONTENT",
    title,
    text
  });
}

// ── 按钮基础样式（内联，避免与宿主页面样式冲突）
const TL_BTN_STYLE = 'color:white;border:none;padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer;opacity:0.7;transition:opacity 0.2s;white-space:nowrap;';

// ── 提取用户消息纯文本（排除注入的按钮/revised UI 文字）
function extractMsgText(msg) {
  // ChatGPT 常见的消息文本容器
  const textNode = msg.querySelector('.whitespace-pre-wrap') || msg.querySelector('.markdown');
  if (textNode) {
    // 如果是 markdown 容器，尝试取内部文本
    const clone = textNode.cloneNode(true);
    clone.querySelectorAll('.tl-btn-row, .tl-revise-result').forEach((el) => el.remove());
    return clone.textContent.trim();
  }
  // Fallback：直接克隆整个消息块并清理
  const clone = msg.cloneNode(true);
  clone.querySelectorAll('.tl-btn-row, .tl-revise-result').forEach((el) => el.remove());
  return clone.textContent.trim();
}

// ── 给消息框动态添加 "Save to Prompt Library" + "✨ Revise" 按钮行 ──
function injectSaveButtons() {
  const userMessages = document.querySelectorAll(
    'div[data-testid="user-message"],[data-message-author-role="user"]'
  );

  userMessages.forEach((msg) => {
    if (msg.querySelector('.tl-btn-row')) return; // 已注入，跳过

    // 按钮行容器（flex 并排）
    const btnRow = document.createElement('div');
    btnRow.className = 'tl-btn-row';
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap;';

    // ── Save to Prompt Library 按钮
    const saveBtn = document.createElement('button');
    saveBtn.className = 'tl-save-prompt-btn';
    saveBtn.textContent = 'Save to Prompt Library';
    saveBtn.style.cssText = TL_BTN_STYLE + 'background:#5b9cf6;';
    saveBtn.onmouseover = () => (saveBtn.style.opacity = '1');
    saveBtn.onmouseout = () => (saveBtn.style.opacity = '0.7');
    saveBtn.onclick = () => {
      const text = extractMsgText(msg);
      const title = `Saved from ${window.location.host} at ${new Date().toLocaleTimeString()}`;
      addPromptFromContent(title, text);
      saveBtn.textContent = '✅ Saved!';
      setTimeout(() => (saveBtn.textContent = 'Save to Prompt Library'), 2000);
    };

    // ── Revise 按钮
    const reviseBtn = document.createElement('button');
    reviseBtn.className = 'tl-revise-btn';
    reviseBtn.textContent = '✨ Revise';
    reviseBtn.style.cssText = TL_BTN_STYLE + 'background:#7c4dff;';
    reviseBtn.onmouseover = () => (reviseBtn.style.opacity = '1');
    reviseBtn.onmouseout = () => (reviseBtn.style.opacity = '0.7');
    reviseBtn.onclick = () => {
      const text = extractMsgText(msg);
      if (!text) return;
      handleReviseClick(text, reviseBtn);
    };

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(reviseBtn);
    msg.appendChild(btnRow);
  });
}

// ── 防抖工具函数（debounce）
// 在 interview 中：debounce delays execution until activity stops
function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ── 网站适配器（Site Adapter）
const SITE_ADAPTERS = {
  "chatgpt.com": {
    // 每一轮对话的容器
    turnSelector: 'section[data-testid^="conversation-turn"]',

    // 对话容器选择器（用于 MutationObserver 的监听目标）
    containerSelector: 'main',

    // 判断是否是用户消息（通过 data-turn 属性）
    isUserTurn: (el) => el.getAttribute("data-turn") === "user",

    // 提取用户消息文字
    extractUserText: (el) => {
      const node = el.querySelector(".whitespace-pre-wrap");
      if (!node) return null

      // 读取 ChatGPT 自带的唯一 id
      const domId = el.getAttribute("data-turn-id");

      // 给 section 元素打上 id，方便 getElementById 找到它
      if (domId && !el.id) {
        el.id = domId;
      }

      return {
        text: node.textContent.trim(),
        domId: domId || null,
      };
    },

    // 提取助手消息文字, 每一个标题是一个anchor
    extractAssistantAnchors: (el) => {
      const container = el.querySelector('[data-message-author-role="assistant"]');
      if (!container) return [];

      // 策略一：寻找 markdown 标题（h1~h3）
      // ChatGPT 会把 ## 标题渲染成 <h2>、<h3>
      const headings = Array.from(container.querySelectorAll("h1, h2, h3")).filter(
        (h) => !h.closest("pre") // closest() 向上找父元素，如果父元素是 pre 就排除
      );

      if (headings.length > 0) {
        return headings.map((h) => {
          if (!h.id || !h.id.startsWith("tl-")) {
            h.id = `tl-anchor-${anchorCounter++}`; // 每个heading的id
          }
          return { id: h.id, label: h.textContent.trim() };
        });
      }

      // 策略二：没有标题，取第一个有内容的<p>段落作为唯一 anchor
      const paragraphs = container.querySelectorAll("p");
      for (const p of paragraphs) {
        const text = p.textContent.trim();
        if (text.length > 10) { // 过滤掉太短的段落
          if (!p.id || !p.id.startsWith("tl-")) {
            p.id = `tl-anchor-${anchorCounter++}`; // 每个<p>的id
          }
          return [{ id: p.id, label: smartTruncate(text, 40) }];
        }
      }

      return [];
    },
  },


  "claude.ai": {
    // Claude 的 selector 留到下一步填入
    turnSelector: null,
    containerSelector: null,
    isUserTurn: () => null,
    extractUserText: () => null,
    extractAssistantAnchors: () => [],
  },
};

// ── Claude.ai 专用解析函数
// Claude 没有统一的对话容器，用户消息和助手消息是平级元素，需要按 DOM 顺序合并
function parseClaude() {
  const userEls = Array.from(document.querySelectorAll('div[data-testid="user-message"]'));
  const assistantEls = Array.from(document.querySelectorAll('div.font-claude-response'));

  // 按 DOM 顺序合并（compareDocumentPosition 返回位标志位）
  const allEls = [...userEls, ...assistantEls].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const result = [];

  allEls.forEach((el) => {
    const isUser = el.matches('div[data-testid="user-message"]');

    if (isUser) {
      const node = el.querySelector(".whitespace-pre-wrap");
      if (!node) return;

      // Claude 用户消息没有自带唯一 id，生成并打到元素上
      if (!el.id || !el.id.startsWith("tl-")) {
        el.id = `tl-user-${anchorCounter++}`;
      }

      result.push({
        id: el.id,
        role: "user",
        text: node.textContent.trim(),
      });
    } else {
      // 助手消息：提取 standard-markdown 里的标题（排除 pre 内部）
      const headings = Array.from(
        el.querySelectorAll(".standard-markdown h1, .standard-markdown h2, .standard-markdown h3")
      ).filter((h) => !h.closest("pre"));

      let anchors = [];

      if (headings.length > 0) {
        anchors = headings.map((h) => {
          if (!h.id || !h.id.startsWith("tl-")) {
            h.id = `tl-anchor-${anchorCounter++}`;
          }
          return { id: h.id, label: h.textContent.trim() };
        });
      } else {
        // 没有标题，取第一个有内容的 <p> 作为唯一 anchor
        const paragraphs = el.querySelectorAll("p");
        for (const p of paragraphs) {
          const text = p.textContent.trim();
          if (text.length > 10) {
            if (!p.id || !p.id.startsWith("tl-")) {
              p.id = `tl-anchor-${anchorCounter++}`;
            }
            anchors = [{ id: p.id, label: smartTruncate(text, 40) }];
            break;
          }
        }
      }

      if (anchors.length === 0) return;

      result.push({
        id: `tl-assistant-${anchorCounter}`,
        role: "assistant",
        anchors,
      });
    }
  });

  return result;
}

// ── Claude.ai 专用 MutationObserver
function startClaudeObserver() {
  const debouncedParse = debounce(() => {
    // 注入保存按钮
    injectSaveButtons();

    const parsed = parseClaude();
    const timelineData = buildTimelineData(parsed);
    console.log("[Timeline] Claude updated:", timelineData.length, "turns");
    sendTimelineToPanel(timelineData);
  }, 800);

  const observer = new MutationObserver((mutations) => {
    const hasRelevantChange = mutations.some(
      (mutation) => mutation.type === "childList" && mutation.addedNodes.length > 0
    );
    if (hasRelevantChange) {
      debouncedParse();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log("[Timeline] Claude MutationObserver started");
  return observer;
}

// ── 获取当前网站的 adapter
function getAdapter() {
  const hostname = window.location.hostname;
  // chatgpt.com 和 chat.openai.com 都用同一个 adapter
  if (hostname.includes("chatgpt.com") || hostname.includes("openai.com")) {
    return SITE_ADAPTERS["chatgpt.com"];
  }
  if (hostname.includes("claude.ai")) {
    return SITE_ADAPTERS["claude.ai"];
  }
  return null;
}

// ── 解析整个对话，输出扁平列表
function parseConversation(adapter) {
  const turns = document.querySelectorAll(adapter.turnSelector);
  const result = [];

  turns.forEach((turn, index) => {
    const isUser = adapter.isUserTurn(turn);

    if (isUser) {
      // extractUserText 现在返回 { text, domId }
      const extracted = adapter.extractUserText(turn);
      if (!extracted) return;
      result.push({
        id: extracted.domId || `turn-${index}`,
        role: "user",
        text: extracted.text,
      });
    } else {
      const anchors = adapter.extractAssistantAnchors(turn);
      if (anchors.length == 0) return;
      result.push({
        id: `turn-${index}`,
        role: "assistant",
        anchors, // 只取前80字作为 label
      });
    }
  });

  return result;
}

// ── 把扁平列表转成树形 timeline 数据
// user turn 作为父节点，后面紧跟的 assistant turn 作为子节点
function buildTimelineData(parsedTurns) {
  const timeline = [];
  let currentUserTurn = null;

  parsedTurns.forEach((turn) => {
    if (turn.role === "user") {
      currentUserTurn = {
        id: turn.id,
        userText: smartTruncate(turn.text, 50),
        assistantAnchors: [],
      };
      timeline.push(currentUserTurn);
    } else if (turn.role === "assistant" && currentUserTurn) {
      // 防御性检查（defensive check）
      if (!Array.isArray(turn.anchors)) {
        console.warn("[Timeline] Expected array, got:", turn.anchors);
        return;
      }
      // 把数组里每个标题都变成一个 anchor
      turn.anchors.forEach((anchors) => {
        currentUserTurn.assistantAnchors.push({
          id: anchors.id,
          label: anchors.label,
        });
      });
    }
  });

  return timeline;
}

// ── 发送数据给 side panel
function sendTimelineToPanel(timelineData) {
  // side panel 可能没有打开，所以用 try/catch 保护
  chrome.runtime.sendMessage({
    type: "TIMELINE_UPDATE",
    payload: timelineData,
  }).catch(() => {
    // side panel 未打开时忽略这个错误，属于正常情况
    // console.log("[Timeline] Side panel not open yet, skipping message."); //side panel 未打开时静默忽略
  });
}

// ── 高亮当前位置：监听所有 tl- 元素进入视口
// 元素出现 30% 时触发，发送 ANCHOR_VISIBLE 给 side panel
function startAnchorObserver() {
  // 记录滚动方向
  let lastScrollY = window.scrollY;
  let scrollDirection = "down";

  window.addEventListener("scroll", () => {
    scrollDirection = window.scrollY > lastScrollY ? "down" : "up";
    lastScrollY = window.scrollY;
  }, { passive: true });

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting);
      if (visible.length === 0) return;

      let target;
      if (scrollDirection === "down") {
        // 向下滚动：取最靠近视口顶部的元素
        target = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b
        );
      } else {
        // 向上滚动：取最靠近视口底部的元素
        target = visible.reduce((a, b) =>
          a.boundingClientRect.bottom > b.boundingClientRect.bottom ? a : b
        );
      }

      chrome.runtime.sendMessage({
        type: "ANCHOR_VISIBLE",
        anchorId: target.target.id,
      }).catch(() => { });
    },
    { threshold: 0, rootMargin: "-10% 0px -10% 0px" }
  );

  // 观察所有已打上 tl- id 的元素
  document.querySelectorAll('[id^="tl-"]').forEach((el) => observer.observe(el));

  // reobserveAll：新 anchor 出现后重新注册
  observer.reobserveAll = () => {
    observer.disconnect();
    document.querySelectorAll('[id^="tl-"]').forEach(el => observer.observe(el));
  };

  return observer;
}

// ── 核心：解析 + 发送 + 更新 anchor 观察
function parseAndSend(adapter) {
  // 注入保存按钮
  injectSaveButtons();

  const parsed = parseConversation(adapter);
  const timelineData = buildTimelineData(parsed);
  console.log("[Timeline] Updated:", timelineData.length, "turns");
  sendTimelineToPanel(timelineData);

  // 重新观察所有 anchor（包括新增的）
  if (currentAnchorObserver) {
    currentAnchorObserver.reobserveAll();
  }

}

// ── 启动 ChatGPT MutationObserver
function startObserver(adapter) {
  // 找到对话容器（监听目标）
  const container = document.querySelector(adapter.containerSelector);
  if (!container) {
    console.warn("[Timeline] Container not found, falling back to body");
  }
  const target = container || document.body;

  // 防抖版本的解析函数
  // 等 800ms 没有新变化再触发，避免流式输出时重复解析
  const debouncedParse = debounce(() => parseAndSend(adapter), 800);

  const observer = new MutationObserver((mutations) => {
    // 检查是否有相关节点变化（过滤无关的 DOM 操作）
    const hasRelevantChange = mutations.some((mutation) =>
      mutation.type === "childList" && mutation.addedNodes.length > 0
    );

    if (hasRelevantChange) {
      debouncedParse();
    }
  });

  // subtree: true  → 监听所有后代节点的变化
  // childList: true → 监听子节点的增删
  observer.observe(target, {
    childList: true,
    subtree: true,
  });

  console.log("[Timeline] MutationObserver started");
  return observer;
}

// ── 监听跳转指令
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SCROLL_TO_ANCHOR") {
    const el = document.getElementById(message.anchorId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      console.log("[Timeline] Scrolled to:", message.anchorId);
    } else {
      console.warn("[Timeline] Anchor not found:", message.anchorId);
    }
  }
  else if (message.type === "REPARSE_NOW") {
    console.log("[Timeline] Received REPARSE_NOW, re-running main()");
    main();
  }
});

// ── 追踪当前的 MutationObserver（防止 URL 变化后重复启动）
let currentObserver = null;

let currentAnchorObserver = null; // 当前 IntersectionObserver

// ── 主函数
function main() {
  anchorCounter = 0;
  
  // 先 disconnect 旧的 observer，防止重复监听
  if (currentObserver) {
    currentObserver.disconnect();
    currentObserver = null;
  }
  if (currentAnchorObserver) {
    currentAnchorObserver.disconnect();
    currentAnchorObserver = null;
  }

  // Claude.ai 没有统一 turnSelector，走专用解析路径
  if (window.location.hostname.includes("claude.ai")) {
    injectSaveButtons(); // 立即注入一次，覆盖已存在的消息
    const parsed = parseClaude();
    const timelineData = buildTimelineData(parsed);
    sendTimelineToPanel(timelineData);
    currentObserver = startClaudeObserver();
    currentAnchorObserver = startAnchorObserver();
    return;
  }

  const adapter = getAdapter();

  if (!adapter || !adapter.turnSelector) {
    console.log("[Timeline] No adapter for this site:", window.location.hostname);
    return;
  }
  // ✅ 立即解析一次，不等 DOM 变化
  parseAndSend(adapter);

  currentObserver = startObserver(adapter);
  currentAnchorObserver = startAnchorObserver();
}

// ── URL 变化检测（SPA 路由切换）
// SPA 切换对话只改 URL，不刷新页面，需要 polling 检测
let lastHref = window.location.href;
setInterval(() => {
  const currentHref = window.location.href;
  if (currentHref !== lastHref) {
    lastHref = currentHref;
    console.log("[Timeline] URL changed, reloading timeline...");

    // 先通知 side panel 清空显示
    chrome.runtime.sendMessage({ type: "TIMELINE_CLEAR" }).catch(() => { });

    // 等 2000ms 让 SPA 重新渲染 DOM，再重新解析
    setTimeout(main, 2000);
  }
}, 1000);

// 等页面加载完再运行
// 用 setTimeout 是因为 ChatGPT 是 React SPA，DOM 异步渲染
setTimeout(main, 2000);

// ── REVISE CONFIG HELPERS ─────────────────────────────────────────────────────
// Storage keys: reviseMode ("free"|"pro"|null), anthropicApiKey, anthropicModel

function getReviseConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['reviseMode', 'anthropicApiKey', 'anthropicModel'], (r) => {
      resolve({
        reviseMode: r.reviseMode ?? null,
        anthropicApiKey: r.anthropicApiKey ?? '',
        anthropicModel: r.anthropicModel ?? 'claude-haiku-4-5',
      });
    });
  });
}

function setReviseConfig(partial) {
  return new Promise((resolve) => {
    chrome.storage.local.set(partial, resolve);
  });
}

// ── Pro Mode proxy: 把 API 调用转发给 background.js（绕过内容页 CSP）
function reviseViaAnthropicAPI(prompt, apiKey, model) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'REVISE_VIA_API', prompt, apiKey, model },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.ok) {
          resolve(response.text);
        } else {
          const err = new Error(response?.error ?? 'API call failed');
          if (response?.code) err.code = response.code;
          reject(err);
        }
      }
    );
  });
}

// ── 统一 Revise 入口：根据 reviseMode 路由到 free 或 pro 分支
async function handleReviseClick(text, btn) {
  const config = await getReviseConfig();

  // 首次使用：显示模式选择 modal
  if (config.reviseMode === null) {
    showSetupModal(async () => {
      // 用户完成设置后，重新读取 config 并执行
      await handleReviseClick(text, btn);
    });
    return;
  }

  // 仅在 ChatGPT 上才支持 Free Mode（DOM automation）
  const isClaude = window.location.hostname.includes('claude.ai');

  if (isClaude && config.reviseMode === 'free') {
    showToast(
      'Free Mode is not supported on Claude.ai yet. Set up Pro Mode in Settings.',
      'error'
    );
    return;
  }

  btn.textContent = '⏳ Revising...';
  btn.disabled = true;
  btn.style.opacity = '0.5';

  try {
    let revised;
    if (config.reviseMode === 'pro') {
      if (!config.anthropicApiKey) {
        showToast('No API key set. Open Settings → Revise Settings.', 'error');
        return;
      }
      revised = await reviseViaAnthropicAPI(
        text,
        config.anthropicApiKey,
        config.anthropicModel
      );
    } else {
      revised = await revisePromptViaChatGPT(text);
    }
    showRevisionModal(revised);
  } catch (err) {
    if (err.code === 'INVALID_KEY') {
      showToast('Invalid API key. Update it in Settings → Revise Settings.', 'error');
    } else {
      showToast('Revise failed: ' + err.message, 'error');
    }
  } finally {
    btn.textContent = '✨ Revise';
    btn.disabled = false;
    btn.style.opacity = '0.7';
  }
}

// ── PROMPT REVISION VIA DOM AUTOMATION (Phase 1 + 2) ──────────────────────────
// ChatGPT (chatgpt.com / chat.openai.com) ONLY.
// Programmatically types a revision request into the composer and extracts the
// response — the exchange appears in the conversation but is isolated to a
// separate call from the user's original prompt.

// ── Centralized selectors
// All DOM selectors live here. When ChatGPT changes their UI, this is the only
// place that needs updating.
const REVISION_SELECTORS = {
  // div#prompt-textarea — ChatGPT's React-controlled contenteditable input.
  // The `id` has been stable since 2023; more reliable than class-based selectors
  // which change on every deploy.
  composer: '#prompt-textarea',

  // Fallback if id changes: any contenteditable inside the submit form.
  composerFallback: 'form div[contenteditable="true"]',

  // Send button — data-testid is locale-independent (unlike aria-label, which
  // changes with browser language settings).
  sendButton: 'button[data-testid="send-button"]',

  // "Stop generating" button — present DURING streaming, absent before/after.
  // WHY this signal: it is toggled by ChatGPT's own internal streaming state
  // machine, not a CSS transition or timer. When it disappears, the model is
  // truly done writing — not just paused or animating. More reliable than
  // watching the send button re-enable (which can lag) or observing the last
  // message's MutationObserver (which requires guessing a "quiet" window).
  stopButton: 'button[data-testid="stop-button"]',

  // All conversation turns — reuses the selector already in this file.
  conversationTurn: 'section[data-testid^="conversation-turn"]',

  // The text container inside an assistant turn. textContent gives the full
  // response text regardless of whether it contains markdown headings or plain text.
  assistantMessage: '[data-message-author-role="assistant"]',
};

const REVISION_TIMEOUT_MS = 90_000;       // max total wait for response
const REVISION_START_TIMEOUT_MS = 10_000; // max wait for streaming to begin

// Poll conditionFn() every 200ms until it returns true or timeoutMs elapses.
function waitForCondition(conditionFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const id = setInterval(() => {
      try {
        if (conditionFn()) {
          clearInterval(id);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(id);
          reject(new Error('Timed out after ' + timeoutMs + 'ms'));
        }
      } catch (e) {
        clearInterval(id);
        reject(e);
      }
    }, 200);
  });
}

// Insert text into ChatGPT's React-controlled contenteditable composer.
//
// WHY execCommand("insertText"):
// ChatGPT's composer is managed by React. Setting .innerText or .textContent
// directly writes to the DOM but skips React's synthetic event system — React
// never sees the change, so its internal state stays empty and the send button
// remains disabled.
// document.execCommand("insertText") fires the native "input" DOM event, which
// React's top-level event delegation intercepts and propagates as a synthetic
// onChange — correctly updating state and enabling the send button.
//
// execCommand is deprecated per spec but remains fully supported in Chromium.
// If it ever stops working, the fallback dispatches a paste ClipboardEvent,
// which React also handles via its event delegation.
function typeIntoComposer(composerEl, text) {
  composerEl.focus();
  // Replace any existing draft text so we start clean
  document.execCommand('selectAll');
  const ok = document.execCommand('insertText', false, text);

  if (!ok) {
    // Fallback: simulate paste. React intercepts ClipboardEvents and updates
    // state the same way it does for keyboard input.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    composerEl.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    );
    console.warn('[Timeline] [Revision] execCommand failed — used paste fallback');
  }
}

// Wrap the original prompt in an instruction envelope for the revision task.
function buildRevisionRequest(originalPrompt) {
  return (
    'Please revise and improve the following prompt to make it clearer, more specific, ' +
    'and more effective. Return ONLY the revised prompt with no preamble or explanation.\n\n' +
    'Original prompt:\n---\n' +
    originalPrompt.trim() +
    '\n---'
  );
}

// Main automation function. Resolves with the revised prompt text.
async function revisePromptViaChatGPT(originalPrompt) {
  // ── 1. Locate the composer
  const composer =
    document.querySelector(REVISION_SELECTORS.composer) ||
    document.querySelector(REVISION_SELECTORS.composerFallback);

  if (!composer) {
    throw new Error(
      '[Timeline] ChatGPT composer not found. ' +
      'Tried selectors: "' + REVISION_SELECTORS.composer + '", "' + REVISION_SELECTORS.composerFallback + '". ' +
      'Inspect the input element and update REVISION_SELECTORS.composer.'
    );
  }

  // ── 2. Snapshot current turn count so we can identify the new response later
  const turnsBefore = document.querySelectorAll(REVISION_SELECTORS.conversationTurn).length;
  console.log('[Timeline] [Revision] Turns before send:', turnsBefore);

  // ── 3. Type the revision request
  typeIntoComposer(composer, buildRevisionRequest(originalPrompt));

  // Brief pause: React's reconciliation (state → send button enable) can lag
  // ~100–200ms after the input event fires.
  await new Promise((r) => setTimeout(r, 350));

  // ── 4. Click send
  const sendBtn = document.querySelector(REVISION_SELECTORS.sendButton);
  if (!sendBtn) {
    throw new Error(
      '[Timeline] ChatGPT send button not found. ' +
      'Selector: "' + REVISION_SELECTORS.sendButton + '". May need updating.'
    );
  }

  const isSendDisabled =
    sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
  if (isSendDisabled) {
    throw new Error(
      '[Timeline] Send button is still disabled after typing — the composer text ' +
      'likely did not register in React state. The execCommand approach may need ' +
      'updating for the current ChatGPT version.'
    );
  }

  sendBtn.click();
  console.log('[Timeline] [Revision] Request submitted');

  // ── 5. Wait for streaming to START (stop button appears)
  // Confirms ChatGPT accepted the submission and began generating.
  try {
    await waitForCondition(
      () => !!document.querySelector(REVISION_SELECTORS.stopButton),
      REVISION_START_TIMEOUT_MS
    );
    console.log('[Timeline] [Revision] Streaming started');
  } catch {
    throw new Error(
      '[Timeline] ChatGPT did not begin responding within ' +
      (REVISION_START_TIMEOUT_MS / 1000) + 's. ' +
      'Stop button selector may be outdated: "' + REVISION_SELECTORS.stopButton + '"'
    );
  }

  // ── 6. Wait for streaming to FINISH (stop button disappears)
  try {
    await waitForCondition(
      () => !document.querySelector(REVISION_SELECTORS.stopButton),
      REVISION_TIMEOUT_MS
    );
    console.log('[Timeline] [Revision] Streaming complete');
  } catch {
    throw new Error(
      '[Timeline] Response timed out after ' + (REVISION_TIMEOUT_MS / 1000) + 's'
    );
  }

  // Grace period: let React flush any final DOM updates after the stream ends
  await new Promise((r) => setTimeout(r, 500));

  // ── 7. Extract the last assistant message
  // After our submission there should be at least one new turn.
  const allTurns = document.querySelectorAll(REVISION_SELECTORS.conversationTurn);
  if (allTurns.length <= turnsBefore) {
    throw new Error(
      '[Timeline] Expected new turns after revision (had ' + turnsBefore +
      ', still have ' + allTurns.length + '). Response may not have been captured.'
    );
  }

  // Walk backwards from the last turn to find the most recent assistant message.
  // (The final assistant turn is always last, but we loop defensively in case
  // ChatGPT inserts a trailing UI turn we don't know about.)
  let revised = null;
  for (let i = allTurns.length - 1; i >= Math.max(0, turnsBefore - 1); i--) {
    const assistantEl = allTurns[i].querySelector(REVISION_SELECTORS.assistantMessage);
    if (assistantEl) {
      // Prefer the .markdown container (clean prose text) if present; fall back
      // to the full assistant container.
      const textContainer = assistantEl.querySelector('.markdown') || assistantEl;
      revised = textContainer.textContent.trim();
      if (revised) break;
    }
  }

  if (!revised) {
    throw new Error(
      '[Timeline] Could not extract assistant response. ' +
      'assistantMessage selector "' + REVISION_SELECTORS.assistantMessage + '" may be outdated.'
    );
  }

  console.log('[Timeline] [Revision] Extracted ' + revised.length + ' chars');
  return revised;
}

// ── TOAST HELPER ──────────────────────────────────────────────────────────────
// CSS tokens from sidepanel.css:
//   bg #1a1a1a, border #333, text #e8e8e8, accent #5b9cf6
//   font -apple-system…, shadow 0 4px 12px rgba(0,0,0,0.3), radius 6px

function showToast(message, type = 'info') {
  // Reuse or create a single fixed container so multiple toasts stack cleanly
  let container = document.getElementById('tl-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'tl-toast-container';
    container.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'display:flex;flex-direction:column-reverse;align-items:center;gap:8px;' +
      'z-index:999999;pointer-events:none;';
    document.body.appendChild(container);
  }

  const palette = {
    success: { bg: '#1a2e22', border: '#2e7d50', text: '#7ed4a0' },
    error:   { bg: '#2e1a1a', border: '#7d2e2e', text: '#e07070' },
    info:    { bg: '#1a2233', border: '#2e4a7d', text: '#7aaee8' },
  };
  const p = palette[type] || palette.info;
  const duration = type === 'error' ? 4000 : 2500;

  const toast = document.createElement('div');
  toast.style.cssText =
    `background:${p.bg};border:1px solid ${p.border};color:${p.text};` +
    'padding:9px 16px;border-radius:6px;font-size:13px;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'box-shadow:0 4px 12px rgba(0,0,0,0.4);pointer-events:auto;' +
    'white-space:nowrap;opacity:1;transition:opacity 0.3s;';
  toast.textContent = message;
  container.appendChild(toast);

  const dismiss = () => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  };
  const timer = setTimeout(dismiss, duration);
  toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

// ── MODAL THEME HELPERS ───────────────────────────────────────────────────────
// Color tokens extracted from sidepanel.css:
//   Dark  (`:root`):          bg #1a1a1a, bg-header #242424, border #333333,
//                             text #e8e8e8, input-bg #2a2a2a, input-border #444444,
//                             placeholder #666666
//   Light (`[data-theme=light]`): bg #ffffff, bg-header #f5f5f5, border #dddddd,
//                             text #333333, input-bg #ffffff, input-border #cccccc,
//                             placeholder #999999
//   Accents (both themes):    blue #5b9cf6, purple #7c4dff

// Read user's theme setting and resolve "system" → actual dark/light.
async function getResolvedTheme() {
  const result = await chrome.storage.local.get('settings');
  const theme = result.settings?.theme ?? 'system';
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

// Inject CSS variable definitions for both themes once into the host page.
// Scoped to .tl-modal-backdrop[data-theme] so they only affect our modals.
// Child elements reference them via var(--modal-*) in inline styles.
function ensureModalStyles() {
  if (document.getElementById('tl-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'tl-modal-styles';
  style.textContent = `
    .tl-modal-backdrop[data-theme="dark"] {
      --modal-overlay: rgba(0,0,0,0.6);
      --modal-bg: #1a1a1a;
      --modal-bg-header: #242424;
      --modal-border: #333333;
      --modal-text: #e8e8e8;
      --modal-input-bg: #2a2a2a;
      --modal-input-border: #444444;
      --modal-placeholder: #666666;
      --modal-close-hover: rgba(128,128,128,0.2);
      --modal-back-hover: rgba(128,128,128,0.15);
      --modal-secondary-border: #444444;
      --modal-secondary-color: #e8e8e8;
    }
    .tl-modal-backdrop[data-theme="light"] {
      --modal-overlay: rgba(0,0,0,0.4);
      --modal-bg: #ffffff;
      --modal-bg-header: #f5f5f5;
      --modal-border: #dddddd;
      --modal-text: #333333;
      --modal-input-bg: #ffffff;
      --modal-input-border: #cccccc;
      --modal-placeholder: #999999;
      --modal-close-hover: rgba(0,0,0,0.08);
      --modal-back-hover: rgba(0,0,0,0.08);
      --modal-secondary-border: #cccccc;
      --modal-secondary-color: #333333;
    }
    .tl-modal-backdrop input::placeholder {
      color: var(--modal-placeholder);
    }
    .tl-modal-backdrop select option {
      background: var(--modal-input-bg);
      color: var(--modal-text);
    }
  `;
  document.head.appendChild(style);
}

// Re-apply data-theme to any open modals when the OS colour-scheme changes.
// Only has a visual effect when the user's stored preference is "system".
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
  const resolved = await getResolvedTheme();
  document.querySelectorAll('.tl-modal-backdrop').forEach((el) => {
    el.setAttribute('data-theme', resolved);
  });
});

// ── REVISION MODAL UI ─────────────────────────────────────────────────────────
// Colors come from CSS variables injected by ensureModalStyles().
// The backdrop carries class="tl-modal-backdrop" and data-theme="dark|light"
// so all descendants inherit the correct variable set.

async function showRevisionModal(revisedText) {
  document.getElementById('tl-revision-backdrop')?.remove();
  ensureModalStyles();
  const theme = await getResolvedTheme();
  const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  // ── Backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'tl-revision-backdrop';
  backdrop.className = 'tl-modal-backdrop';
  backdrop.setAttribute('data-theme', theme);
  backdrop.style.cssText =
    'position:fixed;inset:0;background:var(--modal-overlay);z-index:999998;' +
    'display:flex;align-items:center;justify-content:center;' +
    `font-family:${FONT};`;
  backdrop.addEventListener('click', closeModal);

  // ── Card (stops backdrop-click from propagating through)
  const card = document.createElement('div');
  card.style.cssText =
    'background:var(--modal-bg);border:1px solid var(--modal-border);border-radius:12px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.4);' +
    'width:min(560px,92vw);max-height:70vh;' +
    'display:flex;flex-direction:column;overflow:hidden;';
  card.addEventListener('click', (e) => e.stopPropagation());

  // ── Header
  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;' +
    'padding:14px 16px;background:var(--modal-bg-header);' +
    'border-bottom:1px solid var(--modal-border);flex-shrink:0;';

  const title = document.createElement('span');
  title.textContent = '✨ Revised Prompt';
  title.style.cssText = 'font-size:14px;font-weight:600;color:var(--modal-text);';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText =
    'background:none;border:none;cursor:pointer;font-size:14px;color:var(--modal-text);' +
    'padding:4px 8px;border-radius:4px;line-height:1;transition:background 0.2s;';
  closeBtn.onmouseover = () => closeBtn.style.setProperty('background', 'var(--modal-close-hover)');
  closeBtn.onmouseout  = () => (closeBtn.style.background = 'none');
  closeBtn.onclick = closeModal;

  header.appendChild(title);
  header.appendChild(closeBtn);

  // ── Body (scrollable)
  const body = document.createElement('div');
  body.style.cssText =
    'flex:1;overflow-y:auto;padding:16px;' +
    'scrollbar-width:thin;scrollbar-color:var(--modal-input-border) transparent;';

  const textEl = document.createElement('div');
  textEl.textContent = revisedText;
  textEl.style.cssText =
    'font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:var(--modal-text);';

  body.appendChild(textEl);

  // ── Footer
  const footer = document.createElement('div');
  footer.style.cssText =
    'display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;' +
    'background:var(--modal-bg-header);border-top:1px solid var(--modal-border);flex-shrink:0;';

  // Secondary: Copy
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.style.cssText =
    'padding:8px 14px;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;' +
    'border:1px solid var(--modal-secondary-border);background:transparent;' +
    'color:var(--modal-secondary-color);transition:background 0.2s;';
  copyBtn.onmouseover = () => copyBtn.style.setProperty('background', 'var(--modal-back-hover)');
  copyBtn.onmouseout  = () => (copyBtn.style.background = 'transparent');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(revisedText);
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    } catch {
      showToast('Copy failed', 'error');
    }
  };

  // Primary: Use in Composer (accent blue — same in both themes)
  const useBtn = document.createElement('button');
  useBtn.textContent = 'Use in Composer';
  useBtn.style.cssText =
    'padding:8px 14px;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;' +
    'border:none;background:#5b9cf6;color:#fff;transition:background 0.2s;';
  useBtn.onmouseover = () => (useBtn.style.background = '#7aacff');
  useBtn.onmouseout  = () => (useBtn.style.background = '#5b9cf6');
  useBtn.onclick = () => {
    const composer =
      document.querySelector(REVISION_SELECTORS.composer) ||
      document.querySelector(REVISION_SELECTORS.composerFallback);
    if (!composer) {
      showToast('Composer not found — selector may be outdated', 'error');
      return;
    }
    typeIntoComposer(composer, revisedText);
    closeModal();
    showToast('Inserted into composer', 'success');
  };

  footer.appendChild(copyBtn);
  footer.appendChild(useBtn);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  // Escape key to close
  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }
  document.addEventListener('keydown', onKeyDown);

  function closeModal() {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
  }
}

// ── SETUP MODAL ───────────────────────────────────────────────────────────────
// First-run modal injected into the host page.
// Two views: (a) mode choice  (b) Pro API key setup.
// onComplete() is called after mode is saved.

async function showSetupModal(onComplete) {
  document.getElementById('tl-setup-backdrop')?.remove();
  ensureModalStyles();
  const theme = await getResolvedTheme();

  // Accent colors are theme-independent
  const BLUE   = '#5b9cf6';
  const PURPLE = '#7c4dff';
  const FONT   = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  // ── Backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'tl-setup-backdrop';
  backdrop.className = 'tl-modal-backdrop';
  backdrop.setAttribute('data-theme', theme);
  backdrop.style.cssText =
    'position:fixed;inset:0;background:var(--modal-overlay);z-index:999998;' +
    `display:flex;align-items:center;justify-content:center;font-family:${FONT};`;

  // ── Card
  const card = document.createElement('div');
  card.style.cssText =
    'background:var(--modal-bg);border:1px solid var(--modal-border);border-radius:12px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.5);width:min(480px,94vw);' +
    'display:flex;flex-direction:column;overflow:hidden;';
  card.addEventListener('click', (e) => e.stopPropagation());
  backdrop.addEventListener('click', closeSetup);
  document.addEventListener('keydown', onEsc);

  function onEsc(e) { if (e.key === 'Escape') closeSetup(); }
  function closeSetup() {
    backdrop.remove();
    document.removeEventListener('keydown', onEsc);
  }

  // ── Header (shared)
  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;' +
    'padding:14px 16px;background:var(--modal-bg-header);' +
    'border-bottom:1px solid var(--modal-border);flex-shrink:0;';
  const headerTitle = document.createElement('span');
  headerTitle.style.cssText = 'font-size:14px;font-weight:600;color:var(--modal-text);';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText =
    'background:none;border:none;cursor:pointer;font-size:14px;color:var(--modal-text);' +
    'padding:4px 8px;border-radius:4px;transition:background 0.2s;';
  closeBtn.onmouseover = () => closeBtn.style.setProperty('background', 'var(--modal-close-hover)');
  closeBtn.onmouseout  = () => (closeBtn.style.background = 'none');
  closeBtn.onclick = closeSetup;
  header.appendChild(headerTitle);
  header.appendChild(closeBtn);

  // ── Body (swappable)
  const body = document.createElement('div');
  body.style.cssText = 'padding:20px;';

  card.appendChild(header);
  card.appendChild(body);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  // ── View A: Mode choice ───────────────────────────────────────────
  function showModeChoice() {
    headerTitle.textContent = '✨ Choose Revise Mode';
    body.innerHTML = '';

    const desc = document.createElement('p');
    desc.style.cssText = 'font-size:13px;color:var(--modal-text);margin-bottom:16px;line-height:1.5;';
    desc.textContent = 'How would you like the Revise feature to work?';
    body.appendChild(desc);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;gap:12px;';

    function makeCard(emoji, label, sublabel, accent, mode) {
      const c = document.createElement('div');
      c.style.cssText =
        'flex:1;border:2px solid var(--modal-border);border-radius:8px;padding:14px 12px;cursor:pointer;' +
        'display:flex;flex-direction:column;gap:6px;transition:border-color 0.2s,background 0.2s;';
      c.innerHTML =
        `<span style="font-size:22px;">${emoji}</span>` +
        `<span style="font-size:13px;font-weight:600;color:var(--modal-text);">${label}</span>` +
        `<span style="font-size:11px;color:var(--modal-placeholder);line-height:1.4;">${sublabel}</span>`;
      c.onmouseover = () => {
        c.style.setProperty('border-color', accent);
        c.style.background = `${accent}18`;
      };
      c.onmouseout = () => {
        c.style.setProperty('border-color', 'var(--modal-border)');
        c.style.background = 'transparent';
      };
      c.onclick = async () => {
        if (mode === 'free') {
          await setReviseConfig({ reviseMode: 'free' });
          closeSetup();
          onComplete();
        } else {
          showProSetup();
        }
      };
      return c;
    }

    const isClaude = window.location.hostname.includes('claude.ai');

    const freeCard = makeCard(
      '🆓', 'Free Mode',
      'Uses ChatGPT via DOM automation. Adds 2 messages to your chat.',
      BLUE, 'free'
    );
    // 在 claude.ai 上禁用 Free Mode 卡片
    if (isClaude) {
      freeCard.style.opacity = '0.5';
      freeCard.style.cursor = 'not-allowed';
      freeCard.style.pointerEvents = 'none';
      const badge = document.createElement('span');
      badge.textContent = 'Coming soon';
      badge.style.cssText =
        'display:inline-block;font-size:10px;font-weight:600;' +
        'background:rgba(128,128,128,0.2);color:#aaa;padding:2px 8px;' +
        'border-radius:10px;margin-top:2px;';
      freeCard.appendChild(badge);
    }

    const proSublabel = isClaude
      ? "Uses your Anthropic API key. Silent, instant, and doesn't add messages to your chat."
      : 'Calls Anthropic API directly. Silent — no chat pollution. Requires your API key.';

    grid.appendChild(freeCard);
    grid.appendChild(makeCard('⚡', 'Pro Mode', proSublabel, PURPLE, 'pro'));

    body.appendChild(grid);
  }

  // ── View B: Pro API key setup ─────────────────────────────────────
  function showProSetup() {
    headerTitle.textContent = '⚡ Pro Mode Setup';
    body.innerHTML = '';

    // API key field
    const keyLabel = document.createElement('label');
    keyLabel.style.cssText = 'display:block;font-size:12px;color:var(--modal-text);margin-bottom:6px;';
    keyLabel.textContent = 'Anthropic API Key';

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = 'sk-ant-...';
    keyInput.style.cssText =
      'width:100%;padding:8px 10px;background:var(--modal-input-bg);' +
      'border:1px solid var(--modal-input-border);' +
      `color:var(--modal-text);border-radius:4px;font-size:12px;font-family:${FONT};` +
      'outline:none;box-sizing:border-box;margin-bottom:14px;';
    keyInput.onfocus = () => keyInput.style.setProperty('border-color', BLUE);
    keyInput.onblur  = () => keyInput.style.setProperty('border-color', 'var(--modal-input-border)');

    // Model select
    const modelLabel = document.createElement('label');
    modelLabel.style.cssText = 'display:block;font-size:12px;color:var(--modal-text);margin-bottom:6px;';
    modelLabel.textContent = 'Model';

    const modelSelect = document.createElement('select');
    modelSelect.style.cssText =
      'width:100%;padding:8px 10px;background:var(--modal-input-bg);' +
      'border:1px solid var(--modal-input-border);' +
      `color:var(--modal-text);border-radius:4px;font-size:12px;font-family:${FONT};` +
      'outline:none;cursor:pointer;box-sizing:border-box;margin-bottom:18px;';
    [
      ['claude-haiku-4-5',  'Claude Haiku 4.5 (Fast & Cheap)'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Balanced)'],
      ['claude-opus-4-6',   'Claude Opus 4.6 (Best Quality)'],
    ].forEach(([val, txt]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = txt;
      modelSelect.appendChild(opt);
    });

    // Pre-fill existing values
    getReviseConfig().then((cfg) => {
      if (cfg.anthropicApiKey) keyInput.value = cfg.anthropicApiKey;
      if (cfg.anthropicModel)  modelSelect.value = cfg.anthropicModel;
    });

    // Status text (error red is theme-independent)
    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:#e07070;min-height:16px;margin-bottom:10px;';

    // Buttons row
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back';
    backBtn.style.cssText =
      'flex:1;padding:8px;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;' +
      'border:1px solid var(--modal-secondary-border);background:transparent;' +
      'color:var(--modal-secondary-color);transition:background 0.2s;';
    backBtn.onmouseover = () => backBtn.style.setProperty('background', 'var(--modal-back-hover)');
    backBtn.onmouseout  = () => (backBtn.style.background = 'transparent');
    backBtn.onclick = showModeChoice;

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save & Continue';
    saveBtn.style.cssText =
      `flex:2;padding:8px;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;` +
      `border:none;background:${PURPLE};color:#fff;transition:background 0.2s;`;
    saveBtn.onmouseover = () => (saveBtn.style.background = '#9966ff');
    saveBtn.onmouseout  = () => (saveBtn.style.background = PURPLE);
    saveBtn.onclick = async () => {
      const key = keyInput.value.trim();
      if (!key.startsWith('sk-ant-')) {
        status.textContent = 'Key must start with sk-ant-';
        return;
      }
      status.textContent = '';
      await setReviseConfig({
        reviseMode: 'pro',
        anthropicApiKey: key,
        anthropicModel: modelSelect.value,
      });
      closeSetup();
      onComplete();
    };

    btnRow.appendChild(backBtn);
    btnRow.appendChild(saveBtn);

    body.appendChild(keyLabel);
    body.appendChild(keyInput);
    body.appendChild(modelLabel);
    body.appendChild(modelSelect);
    body.appendChild(status);
    body.appendChild(btnRow);
  }

  // Start with mode choice view
  showModeChoice();
}

// ── DevTools testing hook ─────────────────────────────────────────────────────
// Open chatgpt.com, open DevTools console (F12), then run:
//   await window.__timelineReviseTest("write a function to sort a list")
// Expected: returns the revised prompt string.
// If it throws, read the error message — it names the exact selector that failed.
window.__timelineReviseTest = revisePromptViaChatGPT;