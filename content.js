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

// ── 给消息框动态添加 "Save to Prompt Library" 按钮 ──
function injectSaveButtons() {
  // 用户消息
  const userMessages = document.querySelectorAll('div[data-testid="user-message"],[data-message-author-role="user"]');

  userMessages.forEach((msg) => {
    if (msg.querySelector(".tl-save-prompt-btn")) return; // 已注入过，跳过

    const btn = document.createElement('button');
    btn.className = 'tl-save-prompt-btn';
    btn.textContent = 'Save to Prompt Library';
    btn.style.cssText = `
      background: #5b9cf6;
      color: black;
      border: none;
      padding: 4px 8px;
      margin-top: 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      opacity: 0.7;
      display: block;
      transition: opacity 0.2s;
    `;
    btn.onmouseover = () => btn.style.opacity = '1';
    btn.onmouseout = () => btn.style.opacity = '0.7';

    btn.onclick = () => {
      const text = msg.innerText || msg.textContent;
      const title = `Saved from ${window.location.host} at ${new Date().toLocaleTimeString()}`;
      addPromptFromContent(title, text);
      btn.textContent = '✅ Saved!';
      setTimeout(() => btn.textContent = 'Save to Prompt Library', 2000);
    };

    msg.appendChild(btn);
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