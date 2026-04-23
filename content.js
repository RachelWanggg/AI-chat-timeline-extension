// content.js
// 职责：解析 ChatGPT/Claude 页面的对话结构，发送给 side panel

// 全局变量 id 计数器（monotonically increasing counter）
let anchorCounter = 0;

let lastTimelineJSON = "";
// ChatGPT assistant anchors: anchor id -> stable assistant turn container id
let assistantAnchorFallbackMap = new Map();
// 当前时间线里的 assistant anchor id（用于过滤陈旧点击）
let activeTimelineAnchorIds = new Set();
// 当前解析周期里的 anchor 元素引用（优先用于精确跳转）
let anchorElementMap = new Map();

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
  if (!chrome.runtime?.id) return;

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

// ── Claude.ai action row 样式（一次性注入，用 id 防重复）
function injectClaudeActionRowCSS() {
  if (document.getElementById('tl-injected-styles')) return;
  const style = document.createElement('style');
  style.id = 'tl-injected-styles';
  style.textContent = `
    .tl-action-row {
      display: flex;
      gap: 6px;
      padding: 2px 0;
      margin-top: 2px;
    }
    .tl-action-row .tl-action-btn {
      background: transparent;
      border: none;
      font-size: 12px;
      cursor: pointer;
      opacity: 0.4;
      transition: opacity 0.15s;
      padding: 2px 4px;
      border-radius: 3px;
      color: inherit;
      font-family: inherit;
      white-space: nowrap;
    }
    .tl-action-row .tl-action-btn:hover {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}

let isInjecting = false;
// ── 给消息框动态添加 "Save to Prompt Library" + "✨ Revise" 按钮行 ──
function injectSaveButtons() {
  if (isInjecting) return;
  isInjecting = true;

  try {
    console.log("💥 injectSaveButtons called");
    const isClaude = window.location.hostname.includes('claude.ai');

    if (isClaude) {
      // ── Claude.ai 专用路径：按钮行插在气泡外部（wrapper 之后的兄弟节点）
      injectClaudeActionRowCSS();

      document.querySelectorAll('div[data-testid="user-message"]').forEach((msg) => {
        // 向上走 2 级，找到包裹整个消息块（头像 + 气泡）的容器
        const wrapper = msg.parentElement?.parentElement?.parentElement || msg.parentElement;
        if (!wrapper) return;

        // 防重复：wrapper 的下一个兄弟已经是 .tl-action-row 则跳过
        if (wrapper.nextElementSibling?.classList.contains('tl-action-row')) return;

        const actionRow = document.createElement('div');
        actionRow.className = 'tl-action-row';

        // ── Save to Prompt Library 按钮 claude
        const saveBtn = document.createElement('button');
        saveBtn.className = 'tl-action-btn tl-save-prompt-btn';
        saveBtn.textContent = '📚 Save to Prompt Library';
        saveBtn.style.cssText = TL_BTN_STYLE + 'background:#5b9cf6;';
        saveBtn.onmouseover = () => (saveBtn.style.opacity = '1');
        saveBtn.onmouseout = () => (saveBtn.style.opacity = '0.7');
        saveBtn.onclick = () => {
          const text = extractMsgText(msg);
          const title = `Saved from ${window.location.host} at ${new Date().toLocaleTimeString()}`;
          addPromptFromContent(title, text);
          saveBtn.textContent = '✅ Saved!';
          setTimeout(() => (saveBtn.textContent = '📚 Save to Prompt Library'), 2000);
        };

        // ── Revise 按钮（使用现有 handleReviseClick，未来可扩展）
        const reviseBtn = document.createElement('button');
        reviseBtn.className = 'tl-action-btn tl-revise-btn';
        reviseBtn.textContent = '✨ Revise';
        reviseBtn.style.cssText = TL_BTN_STYLE + 'background:#7c4dff;';
        reviseBtn.onmouseover = () => (reviseBtn.style.opacity = '1');
        reviseBtn.onmouseout = () => (reviseBtn.style.opacity = '0.7');
        reviseBtn.onclick = () => {
          const text = extractMsgText(msg);
          if (!text) return;
          handleReviseClick(text, reviseBtn);
        };

        actionRow.appendChild(saveBtn);
        actionRow.appendChild(reviseBtn);

        // 插入到 wrapper 后面，气泡外部
        wrapper.insertAdjacentElement('afterend', actionRow);
      });

      return;
    }
  } finally {
    isInjecting = false;
  }

  // ── ChatGPT 路径 ──
  // 以 section[data-testid^="conversation-turn"][data-turn="user"] 为锚，
  // 把按钮行插在 section 后面（React 管辖范围外），避免 re-render 清除或拦截 click。
  const userTurns = document.querySelectorAll(
    'section[data-testid^="conversation-turn"][data-turn="user"]'
  );

  userTurns.forEach((section) => {
    if (section.dataset.tlProcessed === "true") return;

    section.dataset.tlProcessed = "true";

    // 文本提取：从 section 内部找 .whitespace-pre-wrap
    const textNode = section.querySelector('.whitespace-pre-wrap');
    if (!textNode) return;

    // 找到 bubble 容器（data-message-author-role="user"），插在它后面继承父容器的右对齐
    const bubbleDiv = section.querySelector('[data-message-author-role="user"]');
    const anchor = bubbleDiv || section;

    // 防重复：anchor 的下一个兄弟已经是 .tl-btn-row 则跳过
    if (anchor.nextElementSibling?.classList.contains('tl-btn-row')) return;

    // 按钮行容器：不设宽度，让父容器的 align-items:flex-end 控制右对齐
    const btnRow = document.createElement('div');
    btnRow.className = 'tl-btn-row';
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap;align-self:flex-end;';

    // ── Save to Prompt Library 按钮
    const saveBtn = document.createElement('button');
    saveBtn.className = 'tl-action-btn tl-save-prompt-btn';
    saveBtn.textContent = '📚 Save to Prompt Library';
    saveBtn.style.cssText = TL_BTN_STYLE + 'background:#5b9cf6;';
    saveBtn.onmouseover = () => (saveBtn.style.opacity = '1');
    saveBtn.onmouseout = () => (saveBtn.style.opacity = '0.7');
    saveBtn.onclick = () => {
      const text = textNode.textContent.trim();
      const title = `Saved from ${window.location.host} at ${new Date().toLocaleTimeString()}`;
      addPromptFromContent(title, text);
      saveBtn.textContent = '✅ Saved!';
      setTimeout(() => (saveBtn.textContent = '📚 Save to Prompt Library'), 2000);
    };

    // ── Revise 按钮
    const reviseBtn = document.createElement('button');
    reviseBtn.className = 'tl-revise-btn';
    reviseBtn.textContent = '✨ Revise';
    reviseBtn.style.cssText = TL_BTN_STYLE + 'background:#7c4dff;';
    reviseBtn.onmouseover = () => (reviseBtn.style.opacity = '1');
    reviseBtn.onmouseout = () => (reviseBtn.style.opacity = '0.7');
    reviseBtn.onclick = () => {
      const text = textNode.textContent.trim();
      if (!text) return;
      handleReviseClick(text, reviseBtn);
    };

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(reviseBtn);
    // bubble div 后面（React 控制范围外），继承父容器的右对齐布局
    anchor.insertAdjacentElement('afterend', btnRow);
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

function collectActiveTimelineAnchorIds(timelineData) {
  const next = new Set();
  if (!Array.isArray(timelineData)) return next;
  timelineData.forEach((turn) => {
    if (!Array.isArray(turn.assistantAnchors)) return;
    turn.assistantAnchors.forEach((anchor) => {
      if (anchor?.id) next.add(anchor.id);
    });
  });
  return next;
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
    extractAssistantAnchors: (el, index) => {
      const container = el.querySelector('[data-message-author-role="assistant"]');
      if (!container) {
        
        return []
      } ;
      
      // 给整个 assistant turn 一个稳定 id，供 anchor 找不到时回退滚动
      if (!el.id) {
        const domId = el.getAttribute("data-turn-id");
        el.id = domId || `tl-assistant-turn-${index}`;
      }
      const turnId = el.id;

      // 策略一：寻找 markdown 标题（h1~h3）
      // ChatGPT 会把 ## 标题渲染成 <h2>、<h3>
      const headings = Array.from(container.querySelectorAll("h1, h2, h3")).filter(
        (h) => !h.closest("pre") // closest() 向上找父元素，如果父元素是 pre 就排除
      );

      if (headings.length > 0) {
        return headings.map((h, idx) => {
          const stableId = `tl-anchor-${turnId}-h${idx}`;
          if (h.id !== stableId) {
            h.id = stableId;
          }
          assistantAnchorFallbackMap.set(stableId, { sectionId: el.id, headingIndex: idx, isParagraph: false });
          anchorElementMap.set(stableId, h);
          return { id: stableId, label: h.textContent.trim() };
        });
      }

      // 策略二：没有标题，取第一个有内容的<p>段落作为唯一 anchor
      const paragraphs = container.querySelectorAll("p");
      for (const p of paragraphs) {
        const text = p.textContent.trim();
        if (text.length > 10) { // 过滤掉太短的段落
          const stableId = `tl-anchor-${turnId}-p0`;
          if (p.id !== stableId) {
            p.id = stableId;
          }
          // 改成存对象
          assistantAnchorFallbackMap.set(stableId, { sectionId: el.id, headingIndex: 0, isParagraph: true });
          anchorElementMap.set(stableId, p);
          return [{ id: stableId, label: smartTruncate(text, 40) }];
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
          anchorElementMap.set(h.id, h);
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
            anchorElementMap.set(p.id, p);
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

  // 在 parseClaude() 的 return result 之前加
  // console.log("[Timeline] parseClaude anchors:",
  //   result.filter(r => r.role === 'assistant')
  //     .flatMap(r => r.anchors)
  //     .map(a => `${a.id} → ${a.label}`)
  // );

  return result;
}

// ── Claude.ai 专用 MutationObserver
function startClaudeObserver() {
  const debouncedParse = debounce(() => {
    // 注入保存按钮
    injectSaveButtons();

    anchorElementMap = new Map();
    const parsed = parseClaude();
    const timelineData = buildTimelineData(parsed);
    activeTimelineAnchorIds = collectActiveTimelineAnchorIds(timelineData);
    console.log("[Timeline] Claude updated:", timelineData.length, "turns");
    sendTimelineToPanel(timelineData);
  }, 800);

  const observer = new MutationObserver((mutations) => {
    const hasNewMessage = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).some((node) => {
        if (node.nodeType !== 1) return false;

        // ✅ Claude 用户消息
        if (node.matches?.('div[data-testid="user-message"]')) return true;

        // ✅ Claude assistant 消息
        if (node.matches?.('div.font-claude-response')) return true;

        // ✅ 有时候是包裹层
        if (node.querySelector?.('div[data-testid="user-message"]')) return true;
        if (node.querySelector?.('div.font-claude-response')) return true;

        return false;
      })
    );

    if (hasNewMessage) {
      console.log("🟢 New Claude message detected");
      injectSaveButtons();   // ✅ 只在新消息时触发
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
  const scope = adapter.containerSelector
    ? (document.querySelector(adapter.containerSelector) || document)
    : document;
  const turns = scope.querySelectorAll(adapter.turnSelector);
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
      const anchors = adapter.extractAssistantAnchors(turn, index);
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
  // 检查扩展上下文是否还有效（防止重新加载扩展时报错）
  if (!chrome.runtime?.id) {
    console.log("[Timeline] Extension context invalidated, skipping message.");
    return;
  }

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

      if (!chrome.runtime?.id) return;

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
  assistantAnchorFallbackMap = new Map();
  anchorElementMap = new Map();
  const parsed = parseConversation(adapter);
  const timelineData = buildTimelineData(parsed);
  activeTimelineAnchorIds = collectActiveTimelineAnchorIds(timelineData);
  const currentJSON = JSON.stringify(timelineData);
  if (currentJSON === lastTimelineJSON) return;
  lastTimelineJSON = currentJSON;
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
    const hasNewMessage = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).some((node) =>
        node.nodeType === 1 &&
        (
          node.matches?.('section[data-testid^="conversation-turn"]') ||
          node.querySelector?.('section[data-testid^="conversation-turn"]')
        )
      )
    );
    if (hasNewMessage) {
      injectSaveButtons();   // ✅ 只在新 turn 时
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

function getElementsByExactId(anchorId) {
  if (window.CSS && CSS.escape) {
    return Array.from(document.querySelectorAll(`#${CSS.escape(anchorId)}`));
  }
  const safeId = anchorId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return Array.from(document.querySelectorAll(`[id="${safeId}"]`));
}

function hasAncestorWithId(el, ancestorId) {
  let cur = el;
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentElement;
  }
  return false;
}

function isUsableAnchorElement(el) {
  if (el.closest('[aria-hidden="true"], [hidden], [inert], .hidden')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return el.getClientRects().length > 0;
}

function findAnchorTargetElement(anchorId, fallbackId = null) {
  const candidates = getElementsByExactId(anchorId);
  console.log("[TL DEBUG] getElementsByExactId results:", candidates.length, candidates);
  if (candidates.length === 0) return null;

  const visible = candidates.filter(isUsableAnchorElement);
  let pool = visible.length > 0 ? visible : candidates;

  if (fallbackId) {
    const inSameTurn = pool.filter((el) => hasAncestorWithId(el, fallbackId));
    if (inSameTurn.length > 0) {
      pool = inSameTurn;
    }
  }

  const inMainConversation = pool.filter((el) =>
    !!el.closest('main section[data-testid^="conversation-turn"], main div.font-claude-response, main div[data-testid="user-message"]')
  );
  if (inMainConversation.length > 0) {
    pool = inMainConversation;
  }

  const inMain = pool.filter((el) => !!el.closest("main"));
  if (inMain.length > 0) {
    pool = inMain;
  }

  const picked = pool.reduce((best, el) => {
    const rect = el.getBoundingClientRect();
    const dist = Math.abs(rect.top - window.innerHeight * 0.25);
    if (!best || dist < best.dist) return { el, dist };
    return best;
  }, null);
  return picked ? picked.el : null;
}

function isScrollableContainer(el) {
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY;
  const canScrollY = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  return canScrollY && el.scrollHeight > el.clientHeight + 1;
}

function findScrollableAncestor(el) {
  let cur = el.parentElement;
  while (cur) {
    if (isScrollableContainer(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// 在复杂容器里优先滚动真实滚动层，避免 scrollIntoView 命中但不滚动
function scrollElementToTarget(el) {
  const scrollContainer = findScrollableAncestor(el);
  console.log("[TL DEBUG] scrollElementToTarget el:", el);
  console.log("[TL DEBUG] scrollContainer:", scrollContainer);
  if (!scrollContainer) {
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    return;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const targetTop =
    scrollContainer.scrollTop +
    (elRect.top - containerRect.top) -
    scrollContainer.clientHeight * 0.25;
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);

  scrollContainer.scrollTo({
    top: Math.min(Math.max(targetTop, 0), maxScrollTop),
    behavior: "smooth",
  });
}

function scrollToAnchorElement(anchorId) {
  console.log("[TL DEBUG] scrollToAnchorElement called:", anchorId);
  console.log("[TL DEBUG] activeTimelineAnchorIds has:", activeTimelineAnchorIds.has(anchorId));
  console.log("[TL DEBUG] fallbackMap has:", assistantAnchorFallbackMap.has(anchorId));
  console.log("[TL DEBUG] anchorElementMap has:", anchorElementMap.has(anchorId));

  if (anchorId.startsWith("tl-anchor-") && !activeTimelineAnchorIds.has(anchorId)) {
    console.log("[TL DEBUG] blocked by activeTimelineAnchorIds guard");
    return false;
  }

  const fallback = assistantAnchorFallbackMap.get(anchorId) || null;
  const fallbackId = fallback?.sectionId || null;

  // ── 策略一：直接用 id 在 DOM 里找（React 没有重渲染时有效）
  const direct = findAnchorTargetElement(anchorId, fallbackId);
  if (direct && direct.id === anchorId) {
    // 确认找到的是 heading 本身，不是 fallback section
    console.log("[TL DEBUG] found direct heading element");
    scrollElementToTarget(direct);
    return true;
  }

  // ── 策略二：从 anchorElementMap 里取存储的节点引用
  const fromMap = anchorElementMap.get(anchorId);
  if (fromMap && fromMap.isConnected && isUsableAnchorElement(fromMap)) {
    console.log("[TL DEBUG] found via anchorElementMap");
    scrollElementToTarget(fromMap);
    return true;
  }

  // ── 策略三：React 重渲染后 id 丢失，用 headingIndex 重新定位
  if (fallback) {
    const section = document.getElementById(fallback.sectionId);
    if (section) {
      let target = null;

      if (!fallback.isParagraph) {
        // 重新查询 section 内所有 heading，按 index 取
        const headings = Array.from(
          section.querySelectorAll('[data-message-author-role="assistant"] h1, [data-message-author-role="assistant"] h2, [data-message-author-role="assistant"] h3')
        ).filter(h => !h.closest('pre'));
        target = headings[fallback.headingIndex] || null;
        console.log("[TL DEBUG] re-queried headings:", headings.length, "target:", target);
      } else {
        // 段落：重新查询第一个有内容的 <p>
        const container = section.querySelector('[data-message-author-role="assistant"]');
        if (container) {
          for (const p of container.querySelectorAll('p')) {
            if (p.textContent.trim().length > 10) {
              target = p;
              break;
            }
          }
        }
      }

      if (target) {
        scrollElementToTarget(target);
        return true;
      }

      // 最终 fallback：滚到 section 顶部
      console.log("[TL DEBUG] falling back to section scroll");
      scrollElementToTarget(section);
      return true;
    }
  }

  return false;
}

// ── 监听跳转指令
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SCROLL_TO_ANCHOR") {
    if (scrollToAnchorElement(message.anchorId)) {
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
  // ── 推送当前 URL 给 side panel（用于生成 storage key）
  if (chrome.runtime?.id) {
    chrome.runtime.sendMessage({
      type: "UPDATE_PAGE_URL",
      url: window.location.href,
    }).catch(() => { });
  }

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
    anchorElementMap = new Map();
    const parsed = parseClaude();
    const timelineData = buildTimelineData(parsed);
    activeTimelineAnchorIds = collectActiveTimelineAnchorIds(timelineData);
    sendTimelineToPanel(timelineData);
    currentObserver = startClaudeObserver();
    currentAnchorObserver = startAnchorObserver();

    // ✨ 启动 Draft Revise(在 return 之前!)
    startClaudeDraftReviseObserver();
    attachClaudeComposerInputListener();

    return;
  }

  //ChatGPT路径
  const adapter = getAdapter();
  if (!adapter || !adapter.turnSelector) {
    console.log("[Timeline] No adapter for this site:", window.location.hostname);
    return;
  }
  // ✅ 立即解析一次，不等 DOM 变化
  parseAndSend(adapter);

  currentObserver = startObserver(adapter);
  currentAnchorObserver = startAnchorObserver();
  if (location.hostname.includes('chatgpt.com') || location.hostname.includes('openai.com')) {
    startDraftReviseObserver();
    attachComposerInputListener();
  }
  if (location.hostname.includes('claude.ai')) {
    startClaudeDraftReviseObserver();
    attachClaudeComposerInputListener();
  }
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
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: "TIMELINE_CLEAR" }).catch(() => { });
    }

    // 等 2000ms 让 SPA 重新渲染 DOM，再重新解析
    setTimeout(main, 2000);
  }
}, 1000);

// 等页面加载完再运行
// 用 setTimeout 是因为 ChatGPT 是 React SPA，DOM 异步渲染
setTimeout(main, 2000);

// ── REVISE CONFIG HELPERS ─────────────────────────────────────────────────────
// Storage keys: reviseMode ("pro"|null), anthropicApiKey, anthropicModel

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

// ── API Key Mode proxy: 把 API 调用转发给 background.js（绕过内容页 CSP）
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

// ── 统一 Revise 入口：仅支持 API Key Mode（pro）
async function handleReviseClick(text, btn) {
  const config = await getReviseConfig();

  // 首次使用：显示设置 modal
  if (config.reviseMode === null) {
    showSetupModal(async () => {
      // 用户完成设置后，重新读取 config 并执行
      await handleReviseClick(text, btn);
    });
    return;
  }

  if (config.reviseMode !== 'pro') {
    showSetupModal(async () => {
      await handleReviseClick(text, btn);
    });
    return;
  }

  btn.textContent = '⏳ Revising...';
  btn.disabled = true;
  btn.style.opacity = '0.5';

  try {
    if (!config.anthropicApiKey) {
      showToast('No API key set. Open Settings → Revise Settings.', 'error');
      return;
    }
    const revised = await reviseViaAnthropicAPI(
      text,
      config.anthropicApiKey,
      config.anthropicModel
    );
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

};

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
    error: { bg: '#2e1a1a', border: '#7d2e2e', text: '#e07070' },
    info: { bg: '#1a2233', border: '#2e4a7d', text: '#7aaee8' },
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
  closeBtn.onmouseout = () => (closeBtn.style.background = 'none');
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
  copyBtn.onmouseout = () => (copyBtn.style.background = 'transparent');
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
  useBtn.onmouseout = () => (useBtn.style.background = '#5b9cf6');
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
  const BLUE = '#5b9cf6';
  const PURPLE = '#7c4dff';
  const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

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
  closeBtn.onmouseout = () => (closeBtn.style.background = 'none');
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
      c.onclick = showProSetup;
      return c;
    }
    grid.appendChild(
      makeCard(
        '⚡',
        'API Key Mode',
        "Uses your Anthropic API key. Silent, instant, and doesn't add messages to your chat.",
        PURPLE,
        'pro'
      )
    );

    body.appendChild(grid);
  }

  // ── View B: Pro API key setup ─────────────────────────────────────
  function showProSetup() {
    headerTitle.textContent = '⚡ API Key Mode Setup';
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
    keyInput.onblur = () => keyInput.style.setProperty('border-color', 'var(--modal-input-border)');

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
      ['claude-haiku-4-5', 'Claude Haiku 4.5 (Fast & Cheap)'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Balanced)'],
      ['claude-opus-4-6', 'Claude Opus 4.6 (Best Quality)'],
    ].forEach(([val, txt]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = txt;
      modelSelect.appendChild(opt);
    });

    // Pre-fill existing values
    getReviseConfig().then((cfg) => {
      if (cfg.anthropicApiKey) keyInput.value = cfg.anthropicApiKey;
      if (cfg.anthropicModel) modelSelect.value = cfg.anthropicModel;
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
    backBtn.onmouseout = () => (backBtn.style.background = 'transparent');
    backBtn.onclick = showModeChoice;

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save & Continue';
    saveBtn.style.cssText =
      `flex:2;padding:8px;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;` +
      `border:none;background:${PURPLE};color:#fff;transition:background 0.2s;`;
    saveBtn.onmouseover = () => (saveBtn.style.background = '#9966ff');
    saveBtn.onmouseout = () => (saveBtn.style.background = PURPLE);
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

// ── DRAFT REVISE BUTTON ───────────────────────────────────────────────────────
// Injects a "✨ Revise" button into ChatGPT's composer toolbar, left of the
// Dictate button (which is always in the DOM even with an empty composer).
// API Key Mode only, ChatGPT only. Distinct from the ✨ Revise button on submitted
// message bubbles — this one revises the in-progress draft before sending.

// ──────────────────────────────────────────────────────────────────────
// DRAFT REVISE BUTTON — floating above composer
// ──────────────────────────────────────────────────────────────────────
// Floats above ChatGPT's composer area (outside the cramped toolbar) so
// the tooltip has room to display without occlusion. ChatGPT only,
// API Key Mode only. Distinct from the ✨ Revise button on submitted
// message bubbles — this one revises the in-progress draft before sending.

// ── 1. CSS：浮动按钮 + custom tooltip
function injectDraftReviseTooltipCSS() {
  if (document.getElementById('tl-draft-revise-tooltip-style')) return;
  const style = document.createElement('style');
  style.id = 'tl-draft-revise-tooltip-style';
  style.textContent = `
    /* Wrapper：浮动定位在 composer form 上方右侧 */
    .tl-revise-draft-wrapper {
      position: absolute;
      top: -36px;          /* 浮在 composer 上方 36px 处 */
      right: 12px;         /* 距 composer 右边 12px */
      z-index: 999999;
      display: inline-flex;
      align-items: center;
    }

    /* 按钮本体：药丸状，紫色，带阴影 */
    .tl-revise-draft-btn {
      background: #7c4dff;
      color: white;
      border: none;
      border-radius: 16px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      opacity: 0.9;
      transition: opacity 0.2s, transform 0.1s;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .tl-revise-draft-btn:hover:not(:disabled) {
      opacity: 1;
      transform: translateY(-1px);
    }
    .tl-revise-draft-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Tooltip：显示在按钮下方（按钮已浮在外面，下方空间充足） */
    .tl-revise-draft-wrapper::after {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 6px);
      right: 0;            /* 右对齐，避免溢出 */
      background: rgba(40, 40, 40, 0.95);
      color: #fff;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.1s ease-out;
      z-index: 9999999;
    }
    .tl-revise-draft-wrapper:hover::after {
      opacity: 1;
    }
    .tl-revise-draft-wrapper[data-tooltip=""]:hover::after {
      opacity: 0;
    }
  `;
  document.head.appendChild(style);
}

// ── 2. 找到 composer 的容器（作为按钮的定位 anchor）
// ChatGPT 曾经把 #prompt-textarea 包在 <form> 里，现在可能已经去掉了 form。
// 先找 form，找不到就往上找第一个有 position:relative/absolute 或 rounded- 的祖先，
// 最后兜底用 composer 的 parentElement。
function findComposerForm() {
  const composer = document.querySelector('#prompt-textarea');
  if (!composer) return null;

  // 优先：还有 <form> 就用它
  const form = composer.closest('form');
  if (form) return form;

  // 次选：往上找 className 含 rounded 的稳定容器（ChatGPT 新版 composer card）
  let el = composer.parentElement;
  while (el && el !== document.body) {
    const cls = el.className || '';
    if (typeof cls === 'string' && cls.includes('rounded')) return el;
    el = el.parentElement;
  }

  // 兜底：直接用 parentElement
  return composer.parentElement;
}

// ── 3. 注入浮动 Draft Revise 按钮
// 可安全重复调用——内部检查是否已存在
function injectDraftReviseButton() {
  // 仅在 ChatGPT 上注入
  const isOnChatGPT =
    window.location.hostname.includes('chatgpt.com') ||
    window.location.hostname.includes('openai.com');
  if (!isOnChatGPT) return;

  const form = findComposerForm();
  if (!form) return;

  // 防重复注入
  if (form.querySelector('.tl-revise-draft-wrapper')) return;

  // 确保 tooltip CSS 已注入
  injectDraftReviseTooltipCSS();

  // form 必须是 position: relative，才能让 wrapper 的 absolute 定位锚定到它
  if (getComputedStyle(form).position === 'static') {
    form.style.position = 'relative';
  }

  // ── 创建 wrapper（承载 tooltip + 绝对定位）
  const wrapper = document.createElement('span');
  wrapper.className = 'tl-revise-draft-wrapper';
  wrapper.setAttribute('data-tooltip', 'Type something to revise');

  // ── 创建 button（药丸状，带文字）
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tl-revise-draft-btn';
  btn.innerHTML = '✨ Revise';

  btn.addEventListener('click', () => handleDraftReviseClick(btn));

  wrapper.appendChild(btn);
  form.appendChild(wrapper);

  // 初始化按钮状态
  updateDraftButtonState(btn);

  console.log('[Timeline] Draft Revise button injected (floating above composer)');
}

// ── 4. 根据 composer 内容更新按钮状态 + tooltip 文案
function updateDraftButtonState(btn) {
  if (!btn) return;
  const composerEl = document.querySelector('#prompt-textarea');
  if (!composerEl) return;

  const wrapper = btn.closest('.tl-revise-draft-wrapper');
  // .value 兼容 <textarea>，.innerText 兼容 contenteditable div（两者 ChatGPT 都可能用）
  const text = (composerEl.value || composerEl.innerText || '').trim();

  if (!text) {
    btn.disabled = true;
    if (wrapper) wrapper.setAttribute('data-tooltip', 'Type something to revise');
  } else if (text.length < 5) {
    btn.disabled = false;
    if (wrapper) wrapper.setAttribute('data-tooltip', 'Draft too short — type more');
  } else {
    btn.disabled = false;
    if (wrapper) wrapper.setAttribute('data-tooltip', 'Revise draft with AI');
  }

  // 移除 native title，避免双重 tooltip
  btn.removeAttribute('title');
}

// ── 5. 注册 composer input 监听器（一次）
// 改用 dataset 标记替代全局 flag，防止 SPA 切换后新 element 没有 listener
function attachComposerInputListener() {
  const composer = document.querySelector('#prompt-textarea');
  if (!composer) {
    setTimeout(attachComposerInputListener, 500);
    return;
  }
  if (composer.dataset.tlListenerAttached === 'true') return;

  const handler = () => {
    const btn = document.querySelector('.tl-revise-draft-btn');
    if (btn) updateDraftButtonState(btn);
  };
  composer.addEventListener('input', handler);
  // keyup 兜底：部分 React 版本不冒泡 input 事件
  composer.addEventListener('keyup', handler);
  composer.dataset.tlListenerAttached = 'true';
}

// ── 6. Click handler
async function handleDraftReviseClick(btn) {
  const composer =
    document.querySelector(REVISION_SELECTORS.composer) ||
    document.querySelector(REVISION_SELECTORS.composerFallback);
  if (!composer) {
    showToast('Composer not found', 'error');
    return;
  }

  const draftText = (composer.value || composer.innerText || '').trim();
  if (!draftText) return;

  if (draftText.length < 5) {
    showToast('Draft too short to revise', 'info');
    return;
  }

  const config = await getReviseConfig();
  if (config.reviseMode !== 'pro' || !config.anthropicApiKey) {
    showToast(
      'Draft Revise requires API Key Mode. Set up your Anthropic API key in Settings.',
      'error'
    );
    return;
  }

  // Loading 状态
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Revising...';

  try {
    const revised = await reviseViaAnthropicAPI(
      draftText,
      config.anthropicApiKey,
      config.anthropicModel
    );
    showRevisionModal(revised);
    // 现有 modal 的 "Use in Composer" 调用 typeIntoComposer()，
    // 它会 selectAll + insertText，天然替换掉草稿内容
  } catch (err) {
    if (err.code === 'INVALID_KEY') {
      showToast('Your API key is invalid. Update it in Settings.', 'error');
    } else {
      showToast('Revise failed: ' + err.message, 'error');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
    updateDraftButtonState(btn);
  }
}

// ── 7. MutationObserver：保证按钮在 React 重渲染后重新注入
let draftReviseObserver = null;
function startDraftReviseObserver() {
  if (draftReviseObserver) draftReviseObserver.disconnect();

  const composer = document.querySelector('#prompt-textarea');
  if (!composer) {
    setTimeout(startDraftReviseObserver, 500);
    return;
  }

  // 监听 form（或其上层稳定容器），捕获 React 子树重建
  const watchTarget =
    composer.closest('form') ||
    composer.parentElement?.parentElement?.parentElement ||
    composer.parentElement;

  draftReviseObserver = new MutationObserver(() => {
    const form = findComposerForm();
    if (form && !form.querySelector('.tl-revise-draft-wrapper')) {
      injectDraftReviseButton();
    }
  });

  draftReviseObserver.observe(watchTarget, {
    childList: true,
    subtree: true,
  });

  console.log('[Timeline] Draft Revise observer started');
  // 立即尝试注入
  injectDraftReviseButton();
}

// ── CLAUDE.AI DRAFT REVISE BUTTON ────────────────────────────────────────────
// Parallel implementation for Claude.ai's ProseMirror/tiptap composer.
// All functions are Claude-specific (suffixed with "Claude") to avoid
// any interference with the ChatGPT Draft Revise implementation above.

// Find Claude.ai composer (ProseMirror inside a contenteditable div)
function findClaudeComposer() {
  return document.querySelector('[data-testid="chat-input"]')
    || document.querySelector('.ProseMirror');
}

// Find a stable outer container to anchor the floating button.
// Walks up from the composer until finding a parent whose className
// includes "rounded-" (Claude's composer card uses rounded-[20px]).
function findClaudeComposerContainer() {
  const composer = findClaudeComposer();
  if (!composer) return null;
  let parent = composer.parentElement;
  while (parent && parent !== document.body) {
    const cls = parent.className || '';
    if (typeof cls === 'string' && cls.includes('rounded-')) {
      return parent;
    }
    parent = parent.parentElement;
  }
  // Fallback: grandparent if no rounded ancestor found
  return composer.parentElement?.parentElement || composer.parentElement;
}

// 注入按钮 — 修改:每次注入后都尝试 attach listener(防 SPA 切换)
function injectClaudeDraftReviseButton() {
  if (!window.location.hostname.includes('claude.ai')) return;

  const container = findClaudeComposerContainer();
  if (!container) return;

  if (container.querySelector('.tl-revise-draft-wrapper-claude')) {
    // 按钮已存在,但仍要确保 listener attached(SPA 切换可能换了 composer)
    attachClaudeComposerInputListener();
    return;
  }

  injectDraftReviseTooltipCSS();
  injectClaudeDraftReviseExtraCSS();

  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const wrapper = document.createElement('span');
  wrapper.className = 'tl-revise-draft-wrapper-claude';
  wrapper.setAttribute('data-tooltip', 'Type something to revise');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tl-revise-draft-btn';
  btn.innerHTML = '✨ Revise';
  btn.addEventListener('click', () => handleDraftReviseClickClaude(btn));

  wrapper.appendChild(btn);
  container.appendChild(wrapper);

  updateClaudeDraftButtonState(btn);

  // ✨ 关键修改:注入按钮的同时立刻 attach listener(用最新的 composer reference)
  attachClaudeComposerInputListener();

  console.log('[Timeline] Claude Draft Revise button injected + listener attached');
}

// Inject Claude-specific CSS for the wrapper positioning.
// (The ChatGPT version uses .tl-revise-draft-wrapper relative to the form.
// We need a separate class for Claude's rounded card container.)
function injectClaudeDraftReviseExtraCSS() {
  if (document.getElementById('tl-claude-draft-revise-style')) return;
  const style = document.createElement('style');
  style.id = 'tl-claude-draft-revise-style';
  style.textContent = `
    .tl-revise-draft-wrapper-claude {
      position: absolute;
      top: -36px;
      right: 12px;
      z-index: 999999;
      display: inline-flex;
      align-items: center;
    }
    .tl-revise-draft-wrapper-claude::after {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      background: rgba(40, 40, 40, 0.95);
      color: #fff;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.1s ease-out;
      z-index: 9999999;
    }
    .tl-revise-draft-wrapper-claude:hover::after {
      opacity: 1;
    }
    .tl-revise-draft-wrapper-claude[data-tooltip=""]:hover::after {
      opacity: 0;
    }
  `;
  document.head.appendChild(style);
}

// Update Claude button state based on composer content
function updateClaudeDraftButtonState(btn) {
  if (!btn) return;
  const composer = findClaudeComposer();
  if (!composer) return;

  const wrapper = btn.closest('.tl-revise-draft-wrapper-claude');
  // ProseMirror text extraction: use innerText (handles tiptap structure)
  const text = (composer.innerText || '').trim();

  if (!text) {
    btn.disabled = true;
    if (wrapper) wrapper.setAttribute('data-tooltip', 'Type something to revise');
  } else if (text.length < 5) {
    btn.disabled = false;
    if (wrapper) wrapper.setAttribute('data-tooltip', 'Draft too short — type more');
  } else {
    btn.disabled = false;
    if (wrapper) wrapper.setAttribute('data-tooltip', 'Revise draft with AI');
  }
  btn.removeAttribute('title');
}

// 不再用全局标志位 — 改用 dataset 标记 composer 是否已有 listener
function attachClaudeComposerInputListener() {
  const composer = findClaudeComposer();
  if (!composer) {
    setTimeout(attachClaudeComposerInputListener, 500);
    return;
  }

  // 用 dataset 标记是否已 attach,避免重复注册
  if (composer.dataset.tlListenerAttached === 'true') return;

  const handler = () => {
    const btn = document.querySelector('.tl-revise-draft-wrapper-claude .tl-revise-draft-btn');
    if (btn) updateClaudeDraftButtonState(btn);
  };
  composer.addEventListener('input', handler);
  // keyup 兜底：ProseMirror 某些操作不一定触发 input 事件
  composer.addEventListener('keyup', handler);

  composer.dataset.tlListenerAttached = 'true';
  console.log('[Timeline] Claude composer input listener attached');
}

// Click handler for Claude version
async function handleDraftReviseClickClaude(btn) {
  const composer = findClaudeComposer();
  if (!composer) {
    showToast('Claude composer not found', 'error');
    return;
  }

  const draftText = (composer.innerText || '').trim();
  if (!draftText) return;
  if (draftText.length < 5) {
    showToast('Draft too short to revise', 'info');
    return;
  }

  const config = await getReviseConfig();
  if (config.reviseMode !== 'pro' || !config.anthropicApiKey) {
    showToast(
      'Draft Revise requires API Key Mode. Set up your Anthropic API key in Settings.',
      'error'
    );
    return;
  }

  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Revising...';

  try {
    const revised = await reviseViaAnthropicAPI(
      draftText,
      config.anthropicApiKey,
      config.anthropicModel
    );
    showRevisionModal(revised);
    // NOTE: The existing showRevisionModal's "Use in Composer" button calls
    // typeIntoComposer(), which uses ChatGPT-specific selectors and execCommand.
    // It will NOT work on Claude's ProseMirror editor. Known limitation —
    // users should use the "Copy" button on Claude.ai. Cross-platform
    // composer insertion is a separate follow-up task.
  } catch (err) {
    if (err.code === 'INVALID_KEY') {
      showToast('Your API key is invalid. Update it in Settings.', 'error');
    } else {
      showToast('Revise failed: ' + err.message, 'error');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
    updateClaudeDraftButtonState(btn);
  }
}

// MutationObserver for Claude.ai — re-injects button on DOM changes
let claudeDraftReviseObserver = null;
function startClaudeDraftReviseObserver() {
  if (!window.location.hostname.includes('claude.ai')) return;

  if (claudeDraftReviseObserver) claudeDraftReviseObserver.disconnect();

  const composer = findClaudeComposer();
  if (!composer) {
    setTimeout(startClaudeDraftReviseObserver, 500);
    return;
  }

  // Watch a stable ancestor — walk up several levels to capture all
  // re-renders that might evict our button
  let watchTarget = composer;
  for (let i = 0; i < 5 && watchTarget.parentElement; i++) {
    watchTarget = watchTarget.parentElement;
  }

  claudeDraftReviseObserver = new MutationObserver(() => {
    const container = findClaudeComposerContainer();
    if (container && !container.querySelector('.tl-revise-draft-wrapper-claude')) {
      injectClaudeDraftReviseButton();
    }
  });

  claudeDraftReviseObserver.observe(watchTarget, {
    childList: true,
    subtree: true,
  });

  console.log('[Timeline] Claude Draft Revise observer started');
  injectClaudeDraftReviseButton();
}
