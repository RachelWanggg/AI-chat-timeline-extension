// ── Mock data（假数据），用于测试 UI 渲染
// 在真实版本里，这些数据将来自 content script 解析出的结构

const MOCK_TIMELINE = [
  {
    id: "turn-1",
    userText: "解释一下什么是 binary search",
    assistantAnchors: [
      { id: "a-1-1", label: "概念解释" },
      { id: "a-1-2", label: "时间复杂度分析" },
      { id: "a-1-3", label: "代码示例 (Python)" },
    ],
  },
  {
    id: "turn-2",
    userText: "帮我生成一份 README.md",
    assistantAnchors: [
      { id: "a-2-1", label: "README 文档内容" },
      { id: "a-2-2", label: "下载链接" },
    ],
  },
  {
    id: "turn-3",
    userText: "这段代码有什么 bug？",
    assistantAnchors: [
      { id: "a-3-1", label: "Bug 分析" },
      { id: "a-3-2", label: "修复方案" },
    ],
  },
];


// ── 防止点击后被滚动事件覆盖高亮
let isManualClick = false;

// ── 设置当前高亮 anchor（点击 + 滚动共用）
function setActiveAnchor(anchorId) {
  document.querySelectorAll(".active").forEach((el) => el.classList.remove("active"));
  const el =
    document.querySelector(`[data-anchor-id="${anchorId}"]`) ||
    document.querySelector(`[data-turn-id="${anchorId}"]`);
  if (el) {
    el.classList.add("active");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ── 发送跳转消息给 content.js
function scrollToAnchor(anchorId) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: "SCROLL_TO_ANCHOR",
        anchorId,
      });
    }
  });
}

// ── 渲染单个用户消息块（conversation turn）
function renderTurn(turn) {
  // 创建外层容器
  const block = document.createElement("div");
  block.className = "turn-block";
  block.dataset.turnId = turn.id;

  // 渲染用户问题行（user anchor）
  const userRow = document.createElement("div");
  userRow.className = "user-anchor";
  userRow.innerHTML = `
    <div class="dot"></div>
    <span class="anchor-label">${escapeHtml(turn.userText)}</span>
  `;
  // 点击事件暂时只打 log，后续会跳转到页面元素
  userRow.addEventListener("click", () => {
    console.log("[Timeline] user anchor clicked:", turn.id);
    isManualClick = true;
    setActiveAnchor(turn.id);
    scrollToAnchor(turn.id);
    setTimeout(() => { isManualClick = false; }, 1000);
  });

  block.appendChild(userRow);

  // 渲染助手回复跳转点（assistant anchors）
  if (turn.assistantAnchors && turn.assistantAnchors.length > 0) {
    const assistantWrapper = document.createElement("div");
    assistantWrapper.className = "assistant-anchors";

    turn.assistantAnchors.forEach((anchor) => {
      const row = document.createElement("div");
      row.className = "assistant-anchor";
      row.dataset.anchorId = anchor.id;
      row.innerHTML = `
        <span class="dash">▸</span>
        <span class="anchor-label">${escapeHtml(anchor.label)}</span>
      `;
      row.addEventListener("click", () => {
        console.log("[Timeline] assistant anchor clicked:", anchor.id);
        isManualClick = true;
        setActiveAnchor(anchor.id);
        scrollToAnchor(anchor.id);
        setTimeout(() => { isManualClick = false; }, 1000);
      });
      assistantWrapper.appendChild(row);
    });

    block.appendChild(assistantWrapper);
  }

  return block;
}

// ── 渲染空状态（empty state）
function renderEmptyState() {
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `
    <div class="empty-icon">💬</div>
    <div class="empty-text">
      Open a conversation in Claude or ChatGPT,<br/>
      and your timeline will appear here.
    </div>
  `;
  return el;
}

// ── 主渲染函数（main render function）
function renderTimeline(timelineData) {
  const root = document.getElementById("timeline-root");
  root.innerHTML = ""; // 清空旧内容

  if (!timelineData || timelineData.length === 0) {
    root.appendChild(renderEmptyState());
    return;
  }

  timelineData.forEach((turn) => {
    root.appendChild(renderTurn(turn));
  });
}

// ── 工具函数：防止 XSS（escape HTML）
// 在 interview 中，这个叫做 output encoding / HTML sanitization
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── 入口：页面加载完毕后渲染
document.addEventListener("DOMContentLoaded", () => {
  // 先显示空状态，等待真实数据
  renderTimeline([]);

  // 监听来自 content.js 的消息（message listener）
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TIMELINE_UPDATE") {
      console.log("[Panel] Received timeline data:", message.payload);
      renderTimeline(message.payload);
    }
    if (message.type === "TIMELINE_CLEAR") {
      console.log("[Panel] URL changed, clearing timeline");
      renderTimeline([]);
    }
    if (message.type === "ANCHOR_VISIBLE") {
      if (!isManualClick) {
        setActiveAnchor(message.anchorId);
      }
    }
  });
});