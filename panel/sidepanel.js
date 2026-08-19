// ── lastTimelineData：保存最新一次收到的 timeline 数据
// togglePin 需要用它来重新渲染 timeline
let lastTimelineData = [];

// 当前已 pin 的 anchor 集合（Set 保证唯一性）
// key: anchorId, value: { id, label, userText }
let pinnedAnchors = new Map();

// 当前折叠的 turn 集合（默认全部展开）
const collapsedTurns = new Set();

// ── 当前页面 URL（由 content script 推送）
// 用来生成 per-conversation storage key
let currentPageUrl = "unknown";

// 从 chrome.storage.local 读取上次保存的 pins
async function loadPinnedAnchors() {
  const key = getStorageKey();
  const result = await chrome.storage.local.get(key);
  if (result[key]) {
    pinnedAnchors = new Map(Object.entries(result[key]));
  } else {
    pinnedAnchors = new Map(); // 新对话，清空
  }
  renderPinnedSection();
}
// 每次 pin/unpin 后都调用，持久化到 storage
async function savePinnedAnchors() {
  // Map 不能直接 JSON 序列化，转成 Object
  const key = getStorageKey();
  const obj = Object.fromEntries(pinnedAnchors);
  await chrome.storage.local.set({ [key]: obj });
}
// 切换 pin 状态
async function togglePin(anchorId, label, userText) {
  if (pinnedAnchors.has(anchorId)) {
    pinnedAnchors.delete(anchorId);
  } else {
    pinnedAnchors.set(anchorId, { id: anchorId, label, userText });
  }
  await savePinnedAnchors();
  renderPinnedSection();
  renderTimeline(lastTimelineData); // 重新渲染 timeline，更新按钮状态
}
function renderPinnedSection() {
  const section = document.getElementById("pinned-section");
  const list = document.getElementById("pinned-list");

  if (pinnedAnchors.size === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  list.innerHTML = "";

  pinnedAnchors.forEach(({ id, label, userText }) => {
    const item = document.createElement("div");
    item.className = "pinned-item";
    item.innerHTML = `
      <span class="pinned-context">${userText ?? ""}</span>
      <div class="pinned-row">
        <span class="pinned-label">${label}</span>
        <button class="unpin-btn" data-id="${id}" title="Unpin">✕</button>
      </div>
    `;

    // 点击跳转：乐观高亮 + 跳转，并在 settle 期间忽略观测回报，避免途中闪烁
    item.querySelector(".pinned-label").addEventListener("click", () => {
      isManualClick = true;
      setActiveAnchor(id);
      scrollToAnchor(id);
      setTimeout(() => { isManualClick = false; }, 1600);
    });

    // 点击取消 pin
    item.querySelector(".unpin-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(id, label, userText);
    });

    list.appendChild(item);
  });
}

function collectTimelineAnchorIds(timelineData) {
  const ids = new Set();
  if (!Array.isArray(timelineData)) return ids;
  timelineData.forEach((turn) => {
    if (!Array.isArray(turn.assistantAnchors)) return;
    turn.assistantAnchors.forEach((anchor) => {
      if (anchor?.id) ids.add(anchor.id);
    });
  });
  return ids;
}

function pruneStalePinnedAnchors(timelineData) {
  if (!Array.isArray(timelineData) || timelineData.length === 0) return;
  const validIds = collectTimelineAnchorIds(timelineData);
  let changed = false;

  Array.from(pinnedAnchors.keys()).forEach((id) => {
    if (!validIds.has(id)) {
      pinnedAnchors.delete(id);
      changed = true;
    }
  });

  if (changed) {
    savePinnedAnchors().catch(() => { });
    renderPinnedSection();
  }
}

function collectTimelineTurnIds(timelineData) {
  const ids = new Set();
  if (!Array.isArray(timelineData)) return ids;
  timelineData.forEach((turn) => {
    if (turn?.id) ids.add(turn.id);
  });
  return ids;
}

function syncCollapsedTurns(timelineData) {
  const validTurnIds = collectTimelineTurnIds(timelineData);
  Array.from(collapsedTurns).forEach((turnId) => {
    if (!validTurnIds.has(turnId)) {
      collapsedTurns.delete(turnId);
    }
  });
  return validTurnIds;
}

function updateTurnFoldButton(button, isCollapsed) {
  button.textContent = isCollapsed ? "▸" : "▾";
  button.title = isCollapsed ? "Expand turn" : "Collapse turn";
  button.setAttribute("aria-label", isCollapsed ? "Expand turn" : "Collapse turn");
}

function updateFoldAllButtonState(turnIds = collectTimelineTurnIds(lastTimelineData)) {
  const foldAllBtn = document.getElementById("fold-all-btn");
  if (!foldAllBtn) return;

  const hasTurns = turnIds.size > 0;
  const allCollapsed =
    hasTurns && Array.from(turnIds).every((turnId) => collapsedTurns.has(turnId));

  foldAllBtn.textContent = allCollapsed ? "⊞ Unfold All" : "⊟ Fold All";
  foldAllBtn.title = allCollapsed ? "Unfold all turns" : "Fold all turns";
  foldAllBtn.disabled = !hasTurns;
}

function toggleAllTurnsCollapse() {
  const turnIds = collectTimelineTurnIds(lastTimelineData);
  if (turnIds.size === 0) {
    updateFoldAllButtonState(turnIds);
    return;
  }

  const allCollapsed = Array.from(turnIds).every((turnId) => collapsedTurns.has(turnId));
  const shouldCollapse = !allCollapsed;

  if (shouldCollapse) {
    turnIds.forEach((turnId) => collapsedTurns.add(turnId));
  } else {
    collapsedTurns.clear();
  }

  document.querySelectorAll(".assistant-anchors[data-turn-id]").forEach((el) => {
    if (!turnIds.has(el.dataset.turnId)) return;
    el.classList.toggle("hidden", shouldCollapse);
  });

  document.querySelectorAll(".fold-toggle-btn[data-turn-id]").forEach((btn) => {
    if (!turnIds.has(btn.dataset.turnId)) return;
    updateTurnFoldButton(btn, shouldCollapse);
  });

  updateFoldAllButtonState(turnIds);
}

// ── 防止点击后被滚动事件覆盖高亮
let isManualClick = false;
let lastActiveAnchorId = null;

function isElementInView(el, container) {
  if (!el || !container) return true;
  const r = el.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  return r.top >= cr.top && r.bottom <= cr.bottom;
}

// ── 设置当前高亮 anchor（点击 + 滚动共用）
function setActiveAnchor(anchorId) {
  if (!anchorId) return;
  if (anchorId === lastActiveAnchorId) return; // 避免重复高亮导致闪烁
  lastActiveAnchorId = anchorId;

  document.querySelectorAll(".active").forEach((el) => el.classList.remove("active"));
  const el =
    document.querySelector(`[data-anchor-id="${anchorId}"]`) ||
    document.querySelector(`[data-turn-id="${anchorId}"]`);
  if (el) {
    el.classList.add("active");

    // 只有当高亮项不在可视区时才滚动，避免持续 scrollIntoView 引发抖动
    const root = document.getElementById("timeline-root");
    if (root && !isElementInView(el, root)) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
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

// 获取当前 tab 的 URL，生成 per-conversation storage key
// 用 URL 作为 namespace，隔离不同对话的 pins
function getStorageKey() {
  // return new Promise((resolve) => {
  //   chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  //     const url = tabs[0]?.url ?? "unknown";
  //     resolve(`pins:${url}`);
  //   });
  // });
  return `pins:${currentPageUrl}`;
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
  const userMain = document.createElement("div");
  userMain.className = "user-anchor-main";
  userMain.innerHTML = `
    <div class="dot"></div>
    <span class="anchor-label">${escapeHtml(turn.userText)}</span>
  `;
  userRow.appendChild(userMain);

  const hasAssistantAnchors = Array.isArray(turn.assistantAnchors) && turn.assistantAnchors.length > 0;
  let assistantWrapper = null;

  if (hasAssistantAnchors) {
    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = "fold-toggle-btn";
    foldBtn.dataset.turnId = turn.id;
    updateTurnFoldButton(foldBtn, collapsedTurns.has(turn.id));
    foldBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const shouldCollapse = !collapsedTurns.has(turn.id);
      if (shouldCollapse) {
        collapsedTurns.add(turn.id);
      } else {
        collapsedTurns.delete(turn.id);
      }
      if (assistantWrapper) {
        assistantWrapper.classList.toggle("hidden", shouldCollapse);
      }
      updateTurnFoldButton(foldBtn, shouldCollapse);
      updateFoldAllButtonState();
    });
    userRow.appendChild(foldBtn);
  }

  // 点击事件暂时只打 log，后续会跳转到页面元素
  userRow.addEventListener("click", () => {
    console.log("[Timeline] user anchor clicked:", turn.id);
    isManualClick = true;
    setActiveAnchor(turn.id);
    scrollToAnchor(turn.id);
    setTimeout(() => { isManualClick = false; }, 1600);
  });

  block.appendChild(userRow);

  // 渲染助手回复跳转点（assistant anchors）
  if (hasAssistantAnchors) {
    assistantWrapper = document.createElement("div");
    assistantWrapper.className = "assistant-anchors";
    assistantWrapper.dataset.turnId = turn.id;
    assistantWrapper.classList.toggle("hidden", collapsedTurns.has(turn.id));

    turn.assistantAnchors.forEach((anchor) => {
      const row = document.createElement("div");
      row.className = "assistant-anchor";
      row.dataset.anchorId = anchor.id;
      // ── 左侧：箭头 + 标签
      const left = document.createElement("div");
      left.className = "anchor-left";
      left.innerHTML = `
        <span class="dash">▸</span>
        <span class="anchor-label">${escapeHtml(anchor.label)}</span>
      `;
      left.addEventListener("click", () => {
        isManualClick = true;
        setActiveAnchor(anchor.id);
        scrollToAnchor(anchor.id);
        setTimeout(() => { isManualClick = false; }, 1600);
      });

      // ── 右侧：pin 按钮 ✅ 正确位置
      const pinBtn = document.createElement("button");
      pinBtn.className = "pin-btn";
      pinBtn.textContent = pinnedAnchors.has(anchor.id) ? "📌" : "🖇️";
      pinBtn.title = pinnedAnchors.has(anchor.id) ? "Unpin" : "Pin this anchor";
      pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePin(anchor.id, anchor.label, turn.userText);
      });

      row.appendChild(left);
      row.appendChild(pinBtn);
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

function isSameTimeline(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ta = a[i];
    const tb = b[i];
    if (!ta || !tb) return false;
    if (ta.id !== tb.id) return false;
    if (ta.userText !== tb.userText) return false;
    const aa = Array.isArray(ta.assistantAnchors) ? ta.assistantAnchors : [];
    const ab = Array.isArray(tb.assistantAnchors) ? tb.assistantAnchors : [];
    if (aa.length !== ab.length) return false;
    for (let j = 0; j < aa.length; j++) {
      if (aa[j]?.id !== ab[j]?.id) return false;
      if (aa[j]?.label !== ab[j]?.label) return false;
    }
  }
  return true;
}

// ── 主渲染函数（main render function）
function renderTimeline(timelineData) {
  // 如果数据没变，不重渲染，避免闪烁
  if (isSameTimeline(timelineData, lastTimelineData)) {
    return;
  }

  lastTimelineData = timelineData; // 保存最新数据，供 togglePin 重渲染用
  pruneStalePinnedAnchors(timelineData);
  const turnIds = syncCollapsedTurns(timelineData);
  const root = document.getElementById("timeline-root");
  root.innerHTML = ""; // 清空旧内容

  if (!timelineData || timelineData.length === 0) {
    root.appendChild(renderEmptyState());
    updateFoldAllButtonState(turnIds);
    return;
  }

  timelineData.forEach((turn) => {
    root.appendChild(renderTurn(turn));
  });

  updateFoldAllButtonState(turnIds);
}

// ── Context compaction progress bar
const CONTEXT_LIMITS = { claude: 200000, chatgpt: 128000 };
const CONTEXT_STAGES = ["normal", "getting", "soon", "now", "limit"];
const CONTEXT_STAGE_FLOORS = {
  normal: 0,
  getting: 0.5,
  soon: 0.7,
  now: 0.8,
  limit: 0.9,
};
const CONTEXT_STAGE_DEMOTION_FLOORS = {
  normal: 0,
  getting: 0.48,
  soon: 0.68,
  now: 0.78,
  limit: 0.88,
};
const CONTEXT_HINTS = {
  normal: "Estimated context",
  getting: "Context is getting full",
  soon: "Compact recommended soon",
  now: "Compact recommended",
  limit: "Start fresh or compact before continuing",
};
const COMPACT_PROMPT_TEMPLATE =
  "Please compact this conversation before we continue. Keep only key decisions, constraints, unresolved questions, and next steps in concise bullet points.";

let currentContextStage = "normal";
let latestContextPlatform = "chatgpt";
let compactButtonResetTimer = null;

function getBaseContextStage(pct) {
  if (pct >= CONTEXT_STAGE_FLOORS.limit) return "limit";
  if (pct >= CONTEXT_STAGE_FLOORS.now) return "now";
  if (pct >= CONTEXT_STAGE_FLOORS.soon) return "soon";
  if (pct >= CONTEXT_STAGE_FLOORS.getting) return "getting";
  return "normal";
}

function resolveContextStage(pct) {
  const nextStage = getBaseContextStage(pct);
  const currentRank = CONTEXT_STAGES.indexOf(currentContextStage);
  const nextRank = CONTEXT_STAGES.indexOf(nextStage);

  if (nextRank >= currentRank) {
    currentContextStage = nextStage;
    return currentContextStage;
  }

  if (pct < CONTEXT_STAGE_DEMOTION_FLOORS[currentContextStage]) {
    currentContextStage = nextStage;
  }
  return currentContextStage;
}

function getCompactPrompt(platform) {
  if (platform === "claude") {
    return `${COMPACT_PROMPT_TEMPLATE}\n\nFormat for Claude: short, structured, and continuation-ready.`;
  }
  return `${COMPACT_PROMPT_TEMPLATE}\n\nFormat for ChatGPT: short, structured, and continuation-ready.`;
}

function getFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolveEstimatedTokens(contextStats) {
  const directTokens = getFiniteNumber(contextStats?.estimatedTokens);
  if (directTokens !== null) return Math.max(0, Math.round(directTokens));

  const estimatedChars = getFiniteNumber(contextStats?.estimatedChars);
  if (estimatedChars !== null) return Math.max(0, Math.round(estimatedChars / 3.5));

  return 0;
}

function formatKTokens(tokens) {
  const value = Math.max(0, Number(tokens) || 0) / 1000;
  return value < 10 && value > 0 ? value.toFixed(1) : value.toFixed(0);
}

function formatDensityLabel(density) {
  if (density === "code-heavy") return "code-heavy";
  if (density === "cjk-heavy") return "CJK-heavy";
  if (density === "structured") return "structured";
  return "";
}

async function handleCompactNowClick() {
  const compactBtn = document.getElementById("context-compact-btn");
  if (!compactBtn) return;

  if (!navigator.clipboard?.writeText) {
    compactBtn.textContent = "Clipboard unavailable";
    return;
  }

  try {
    await navigator.clipboard.writeText(getCompactPrompt(latestContextPlatform));
    compactBtn.textContent = "Copied compact prompt";
    compactBtn.classList.add("success");
  } catch (error) {
    compactBtn.textContent = "Copy failed";
    compactBtn.classList.remove("success");
    console.log("[Panel] Copy compact prompt failed:", error?.message || error);
  }

  clearTimeout(compactButtonResetTimer);
  compactButtonResetTimer = setTimeout(() => {
    compactBtn.textContent = "Compact now";
    compactBtn.classList.remove("success");
  }, 1800);
}

function renderContextBar(contextStats) {
  const bar = document.getElementById("context-bar");
  const estimatedTokens = resolveEstimatedTokens(contextStats);
  if (!contextStats || estimatedTokens <= 0) {
    bar.classList.add("hidden");
    currentContextStage = "normal";
    return;
  }
  const { platform } = contextStats;
  latestContextPlatform = platform || "chatgpt";
  const limit = CONTEXT_LIMITS[platform] || 128000;
  const pct = Math.min(estimatedTokens / limit, 1);
  const stage = resolveContextStage(pct);

  const fill = document.getElementById("context-bar-fill");
  const hint = document.getElementById("context-bar-hint");
  const label = document.getElementById("context-bar-label");
  const avatar = document.getElementById("context-bar-avatar");
  const trackWrapper = document.getElementById("context-bar-track-wrapper");
  const compactBtn = document.getElementById("context-compact-btn");
  fill.style.width = `${(pct * 100).toFixed(1)}%`;
  fill.className = "context-bar-fill" +
    (stage === "soon" ? " warn" : stage === "now" || stage === "limit" ? " danger" : "");
  avatar.style.left = pct === 0 ? "0px" : `calc(${(pct * 100).toFixed(1)}% - 8px)`;
  avatar.className = "context-bar-avatar" +
    (stage === "soon" ? " warn" : stage === "now" ? " danger" : stage === "limit" ? " limit" : "");
  trackWrapper.classList.toggle("badge", stage === "soon" || stage === "now" || stage === "limit");
  const largestMessageTokens = getFiniteNumber(contextStats.largestMessageTokens);
  const densityLabel = formatDensityLabel(contextStats.density);
  const hintParts = [CONTEXT_HINTS[stage]];
  if (densityLabel) hintParts.push(densityLabel);
  if (largestMessageTokens && largestMessageTokens > 1000) {
    hintParts.push(`largest ~${formatKTokens(largestMessageTokens)}k`);
  }
  hint.textContent = hintParts.filter(Boolean).join(" · ");

  compactBtn.classList.toggle("hidden", !(stage === "now" || stage === "limit"));
  if (stage !== "now" && stage !== "limit") {
    compactBtn.textContent = "Compact now";
    compactBtn.classList.remove("success");
  }

  const kTokens = formatKTokens(estimatedTokens);
  const kLimit = formatKTokens(limit);
  label.textContent = `~${kTokens}k est. / ${kLimit}k`;
  bar.title = `${estimatedTokens.toLocaleString()} estimated tokens`;
  bar.classList.remove("hidden");
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
  renderPinnedSection(); // 初始化时 pins 为空，隐藏 pinned section
  renderTimeline([]);

  // ── 加载设置与主题
  loadSettings();
  loadReviseSettings();

  // ── 加载 Prompt Library
  loadPromptLibrary();

  // ── Prompt 相关事件监听
  document.getElementById("fold-all-btn").addEventListener("click", toggleAllTurnsCollapse);
  document.getElementById("prompt-library-btn").addEventListener("click", openPromptDrawer);
  document.getElementById("close-prompt-drawer").addEventListener("click", closePromptDrawer);
  document.getElementById("save-prompt-btn").addEventListener("click", handleSavePrompt);
  document.getElementById("prompt-search-input").addEventListener("input", handleSearchPrompts);
  document.getElementById("context-compact-btn").addEventListener("click", handleCompactNowClick);

  // ── 设置相关
  document.getElementById("settings-btn").addEventListener("click", () => {
    document.getElementById("settings-overlay").classList.toggle("hidden");
  });
  document.getElementById("close-settings").addEventListener("click", () => {
    document.getElementById("settings-overlay").classList.add("hidden");
  });
  document.getElementById("theme-select").addEventListener("change", (e) => {
    saveSettings({ theme: e.target.value });
    applyTheme(e.target.value);
  });

  // ── Revise Mode 切换
  document.getElementById('revise-mode-select').addEventListener('change', async (e) => {
    const proFields = document.getElementById('pro-mode-fields');
    const status    = document.getElementById('revise-config-status');
    status.textContent = '';
    // API Key Mode：只显示字段，等用户点 Save 才写入 storage
    proFields.classList.remove('hidden');
  });

  // ── Save Revise Config（API Key Mode）
  document.getElementById('save-revise-config-btn').addEventListener('click', async () => {
    const key    = document.getElementById('anthropic-key-input').value.trim();
    const model  = document.getElementById('anthropic-model-select').value;
    const status = document.getElementById('revise-config-status');

    if (!key.startsWith('sk-ant-')) {
      status.style.color = '#e07070';
      status.textContent = 'Key must start with sk-ant-';
      return;
    }

    await setReviseConfig({ reviseMode: 'pro', anthropicApiKey: key, anthropicModel: model });
    status.style.color = '#7ed4a0';
    status.textContent = 'Saved ✓';
    setTimeout(() => { status.textContent = ''; }, 2500);
  });
  // ── Modal 拖拽与缩放初始化
  initModalActions();

  // Prompt 抽屉背景点击关闭
  document.getElementById("prompt-drawer").addEventListener("click", (e) => {
    if (e.target.id === "prompt-drawer") {
      closePromptDrawer();
    }
  });

  // 监听来自 content.js 的消息（message listener）
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TIMELINE_UPDATE") {
      console.log("[Panel] Received timeline data:", message.payload);
      if (message.url && message.url !== currentPageUrl) {
        // 对话切换：先加载新对话的 pins，再渲染 timeline（保证 pin 按钮状态正确）
        currentContextStage = "normal";
        currentPageUrl = message.url;
        renderContextBar(message.contextStats);
        console.log("[Panel] Conversation URL:", currentPageUrl);
        loadPinnedAnchors().then(() => renderTimeline(message.payload));
      } else {
        renderContextBar(message.contextStats);
        renderTimeline(message.payload);
      }
    }
    if (message.type === "TIMELINE_CLEAR") {
      console.log("[Panel] URL changed, clearing timeline");
      renderTimeline([]);
      renderContextBar(null);
      pinnedAnchors = new Map();
      renderPinnedSection();
    }
    if (message.type === "ANCHOR_VISIBLE") {
      if (!isManualClick) {
        setActiveAnchor(message.anchorId);
      }
    }

    // background.js 已保存，panel 只需重新从 storage 加载
    if (message.type === "PROMPT_LIBRARY_UPDATED") {
      loadPromptLibrary();
    }
  });

  // 初始加载：等消息通道建立后请求当前 tab 重解析
  setTimeout(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        console.log("[Panel] Requesting reparse from tab:", tabs[0].id);
        chrome.tabs.sendMessage(tabs[0].id, { type: "REPARSE_NOW" }).catch((err) => {
          console.log("[Panel] REPARSE_NOW failed (tab not ready):", err.message);
        });
      }
    });
  }, 500);

  // Tab 切换：清空旧数据，向新 tab 请求重解析
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    renderTimeline([]);
    renderContextBar(null);
    currentPageUrl = "unknown";
    pinnedAnchors = new Map();
    renderPinnedSection();
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: "REPARSE_NOW" }).catch(() => {});
    }, 300);
  });

  // SPA 内 URL 变化（ChatGPT/Claude 切换对话）：已有 TIMELINE_CLEAR 推送兜底，
  // 但 tab.onUpdated 补一次 REPARSE_NOW 保证 content script 确实跑了解析。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.active || changeInfo.status !== "complete") return;
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: "REPARSE_NOW" }).catch(() => {});
    }, 500);
  });
});

/* ══════════════════════════════════════════════════
   REVISE CONFIG (mirrors content.js helpers)
   ══════════════════════════════════════════════════ */

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

// 从 storage 读取 Revise 设置并填入表单
async function loadReviseSettings() {
  const config = await getReviseConfig();

  const modeSelect = document.getElementById('revise-mode-select');
  const proFields  = document.getElementById('pro-mode-fields');
  const keyInput   = document.getElementById('anthropic-key-input');
  const modelSelect = document.getElementById('anthropic-model-select');

  modeSelect.value = config.reviseMode ?? 'pro';
  keyInput.value   = config.anthropicApiKey;
  modelSelect.value = config.anthropicModel;

  // 根据当前选中的 mode 显示/隐藏 pro 字段
  proFields.classList.toggle('hidden', modeSelect.value !== 'pro');
}

/* ══════════════════════════════════════════════════
   SETTINGS & THEME
   ══════════════════════════════════════════════════ */

async function loadSettings() {
  const result = await chrome.storage.local.get("settings");
  const settings = result.settings || { theme: "system" };
  document.getElementById("theme-select").value = settings.theme;
  applyTheme(settings.theme);
}

// ── 一次性清理旧版本遗留的 BYOK API Key 存储
// 只在首次运行新版本时执行一次，之后跳过
chrome.storage.local.get("_byokCleanupDone", (r) => {
  if (!r._byokCleanupDone) {
    chrome.storage.local.remove(["apiKeys"]);
    chrome.storage.local.set({ _byokCleanupDone: true });
  }
});

async function saveSettings(newSettings) {
  const result = await chrome.storage.local.get("settings");
  const current = result.settings || {};
  await chrome.storage.local.set({ settings: { ...current, ...newSettings } });
}

function applyTheme(theme) {
  if (theme === "system") {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

/* ══════════════════════════════════════════════════
   MODAL ACTIONS (Move & Resize)
   ══════════════════════════════════════════════════ */

function initModalActions() {
  const modal = document.getElementById("prompt-modal");
  const header = document.getElementById("prompt-modal-header");
  const resizeHandle = modal.querySelector(".modal-resize-handle");

  // Move
  let isMoving = false;
  let offsetX, offsetY;

  header.addEventListener("mousedown", (e) => {
    isMoving = true;
    offsetX = e.clientX - modal.offsetLeft;
    offsetY = e.clientY - modal.offsetTop;
    e.preventDefault();
  });

  // Resize
  let isResizing = false;
  let startWidth, startHeight, startX, startY;

  resizeHandle.addEventListener("mousedown", (e) => {
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = modal.offsetWidth;
    startHeight = modal.offsetHeight;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (isMoving) {
      modal.style.left = `${e.clientX - offsetX}px`;
      modal.style.top = `${e.clientY - offsetY}px`;
      modal.style.transform = "none"; // Disable centering when moved
    }
    if (isResizing) {
      modal.style.width = `${startWidth + (e.clientX - startX)}px`;
      modal.style.height = `${startHeight + (e.clientY - startY)}px`;
      modal.style.transform = "none";
    }
  });

  window.addEventListener("mouseup", () => {
    isMoving = false;
    isResizing = false;
  });
}

function openPromptDrawer() {
  const drawer = document.getElementById("prompt-drawer");
  const modal = document.getElementById("prompt-modal");
  drawer.classList.remove("hidden");

  // Center initially
  modal.style.left = "50%";
  modal.style.top = "50%";
  modal.style.transform = "translate(-50%, -50%)";
  modal.style.width = "90%";
  modal.style.height = "80%";

  activeCategory = "All";
  document.getElementById("prompt-title-input").focus();
  document.getElementById("prompt-search-input").value = "";
  renderPromptList();
}

/* ══════════════════════════════════════════════════
   PROMPT LIBRARY 功能
   ══════════════════════════════════════════════════ */

// Prompt Library 数据（内存中保存）
let promptLibrary = [];

// 当前激活的 category filter（"All" 表示不过滤）
let activeCategory = "All";

// 从 chrome.storage.local 加载已保存的 prompts
async function loadPromptLibrary() {
  try {
    const result = await chrome.storage.local.get("promptLibrary");
    promptLibrary = result.promptLibrary || [];
    renderPromptList();
  } catch (error) {
    console.error("[Prompt] Failed to load prompt library:", error);
  }
}

// 持久化 Prompt Library 到 chrome.storage.local
async function savePromptLibrary() {
  try {
    await chrome.storage.local.set({ promptLibrary });
  } catch (error) {
    console.error("[Prompt] Failed to save prompt library:", error);
  }
}

// 生成 UUID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// 添加新 prompt
async function addPrompt(title, text, category, tagsString) {
  if (!title.trim() || !text.trim()) {
    alert("Title and text cannot be empty");
    return;
  }

  // Parse tags from comma-separated string
  const tags = tagsString
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);

  const newPrompt = {
    id: generateId(),
    title: title.trim(),
    text: text.trim(),
    category: category.trim() || "Other",
    tags: tags,
    createdAt: new Date().toISOString(),
  };

  promptLibrary.push(newPrompt);
  await savePromptLibrary();
  renderPromptList();
  clearPromptForm();
}

// 删除 prompt
async function deletePrompt(id) {
  if (!confirm("Delete this prompt?")) {
    return;
  }

  promptLibrary = promptLibrary.filter((p) => p.id !== id);
  await savePromptLibrary();
  renderPromptList();
}

// 编辑 prompt（in-place 编辑）
function editPrompt(id) {
  const prompt = promptLibrary.find((p) => p.id === id);
  if (!prompt) return;

  const item = document.querySelector(`[data-prompt-id="${id}"]`);
  if (!item) return;

  // 标记为编辑模式
  item.classList.add("editing");

  // 编辑表单用到的 datalist options（来自当前 library）
  const editDatalistId = `edit-category-datalist-${id}`;
  const categoryOptions = getUniqueSortedCategories()
    .map((cat) => `<option value="${escapeHtml(cat)}">`)
    .join("");

  // 创建编辑表单
  const form = document.createElement("div");
  form.className = "prompt-edit-form";
  const tagsString = prompt.tags.join(", ");
  form.innerHTML = `
    <input
      type="text"
      class="prompt-title-input edit-title"
      value="${escapeHtml(prompt.title)}"
      maxlength="50"
    />
    <input
      type="text"
      class="prompt-category-input edit-category"
      list="${editDatalistId}"
      value="${escapeHtml(prompt.category)}"
      placeholder="Category (e.g., Coding)"
      autocomplete="off"
    />
    <datalist id="${editDatalistId}">${categoryOptions}</datalist>
    <input
      type="text"
      class="prompt-tags-input edit-tags"
      value="${escapeHtml(tagsString)}"
      placeholder="Add tags (comma-separated)"
    />
    <textarea
      class="prompt-textarea edit-text"
      rows="4"
    >${escapeHtml(prompt.text)}</textarea>
    <div class="prompt-edit-actions">
      <button class="save-btn save-edit-btn" data-id="${id}">Save</button>
      <button class="cancel-btn cancel-edit-btn">Cancel</button>
    </div>
  `;

  item.innerHTML = "";
  item.appendChild(form);

  // 自动聚焦到 title 输入框
  form.querySelector(".edit-title").focus();

  // 保存编辑事件
  form.querySelector(".save-edit-btn").addEventListener("click", async (e) => {
    const newTitle = form.querySelector(".edit-title").value.trim();
    const newCategory = form.querySelector(".edit-category").value.trim();
    const newTagsString = form.querySelector(".edit-tags").value;
    const newText = form.querySelector(".edit-text").value.trim();

    if (!newTitle || !newText) {
      alert("Title and text cannot be empty");
      return;
    }

    // Parse tags
    const newTags = newTagsString
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0);

    // 更新 prompt
    const promptObj = promptLibrary.find((p) => p.id === id);
    promptObj.title = newTitle;
    promptObj.category = newCategory || "Other";
    promptObj.tags = newTags;
    promptObj.text = newText;

    await savePromptLibrary();
    renderPromptList();
  });

  // 取消编辑事件
  form.querySelector(".cancel-edit-btn").addEventListener("click", () => {
    renderPromptList();
  });
}

// 清空 prompt 表单
function clearPromptForm() {
  document.getElementById("prompt-title-input").value = "";
  document.getElementById("prompt-category-input").value = "";
  document.getElementById("prompt-tags-input").value = "";
  document.getElementById("prompt-textarea").value = "";
}

// 处理保存新 prompt
async function handleSavePrompt() {
  const title = document.getElementById("prompt-title-input").value;
  const category = document.getElementById("prompt-category-input").value;
  const tags = document.getElementById("prompt-tags-input").value;
  const text = document.getElementById("prompt-textarea").value;
  await addPrompt(title, text, category, tags);
}

// 关闭 Prompt Library 抽屉
function closePromptDrawer() {
  const drawer = document.getElementById("prompt-drawer");
  drawer.classList.add("hidden");
  clearPromptForm();
  document.getElementById("prompt-search-input").value = "";
  activeCategory = "All";
}

// 搜索/过滤 prompts（搜索 AND 分类双重过滤）
function filterPrompts(searchQuery) {
  let results = promptLibrary;

  // 按 category chip 过滤
  if (activeCategory !== "All") {
    results = results.filter((p) => p.category === activeCategory);
  }

  if (!searchQuery.trim()) return results;

  const query = searchQuery.toLowerCase();
  return results.filter((prompt) => {
    const matchTitle = prompt.title.toLowerCase().includes(query);
    const matchTags = prompt.tags.some((tag) => tag.includes(query));
    const matchCategory = prompt.category.toLowerCase().includes(query);
    const matchText = prompt.text.toLowerCase().includes(query);
    return matchTitle || matchTags || matchCategory || matchText;
  });
}

// 处理搜索输入
function handleSearchPrompts(e) {
  const query = e.target.value;
  renderPromptList(query);
}

// 所有唯一分类（按字母排序）
function getUniqueSortedCategories() {
  const cats = new Set(promptLibrary.map((p) => p.category || "Other"));
  return Array.from(cats).sort((a, b) => a.localeCompare(b));
}

// 渲染 category filter chips
function renderCategoryChips() {
  const container = document.getElementById("category-chips");
  if (!container) return;
  container.innerHTML = "";

  const categories = getUniqueSortedCategories();
  if (categories.length === 0) return;

  const allChipLabels = ["All", ...categories];
  allChipLabels.forEach((label) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "category-chip" + (label === activeCategory ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      activeCategory = label;
      renderCategoryChips();
      renderPromptList(document.getElementById("prompt-search-input").value);
    });
    container.appendChild(chip);
  });
}

// 同步 <datalist> 选项，供 category text input 自动补全
function updateCategoryDatalist() {
  const datalist = document.getElementById("category-datalist");
  if (!datalist) return;
  datalist.innerHTML = "";
  getUniqueSortedCategories().forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    datalist.appendChild(opt);
  });
}

// 渲染 Prompt 列表
function renderPromptList(searchQuery = "") {
  renderCategoryChips();
  updateCategoryDatalist();

  const list = document.getElementById("prompt-list");
  list.innerHTML = "";

  // Filter prompts based on search query
  const filteredPrompts = filterPrompts(searchQuery);

  if (filteredPrompts.length === 0) {
    if (searchQuery.trim()) {
      list.innerHTML = '<div style="color: #666; padding: 12px; text-align: center;">No prompts match your search.</div>';
    } else if (promptLibrary.length === 0) {
      list.innerHTML = '<div style="color: #666; padding: 12px; text-align: center;">No prompts yet. Create your first one!</div>';
    }
    return;
  }

  filteredPrompts.forEach((prompt) => {
    const item = document.createElement("div");
    item.className = "prompt-item";
    item.dataset.promptId = prompt.id;

    // Build tags HTML
    const tagsHTML = prompt.tags && prompt.tags.length > 0
      ? `<div class="prompt-item-tags">${prompt.tags.map((tag) => `<span class="prompt-item-tag">#${escapeHtml(tag)}</span>`).join("")}</div>`
      : "";

    item.innerHTML = `
      <div class="prompt-item-header">
        <div class="prompt-item-title">${escapeHtml(prompt.title)}</div>
        <div class="prompt-item-actions">
          <button class="icon-btn copy-btn" data-id="${prompt.id}" data-tooltip="Pin" title="Copy">⎘</button>
          <button class="icon-btn edit-btn" data-id="${prompt.id}" data-tooltip="Copy" title="Edit">✏️</button>
          <button class="icon-btn delete delete-btn" data-id="${prompt.id}"data-tooltip="Delete" title="Delete">🗑</button>
        </div>
      </div>
      <div class="prompt-item-meta">
        ${prompt.category ? `<span class="prompt-item-category">${escapeHtml(prompt.category)}</span>` : ""}
        ${tagsHTML}
      </div>
      <div class="prompt-item-text">${escapeHtml(prompt.text)}</div>
    `;

    // 复制 prompt 文本到剪贴板
    item.querySelector(".copy-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(prompt.text);
        // 临时反馈
        const btn = e.target;
        const originalText = btn.textContent;
        btn.textContent = "✓";
        setTimeout(() => {
          btn.textContent = originalText;
        }, 1500);
      } catch (error) {
        console.error("[Prompt] Copy failed:", error);
        alert("Failed to copy prompt");
      }
    });

    // 编辑 prompt
    item.querySelector(".edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      editPrompt(prompt.id);
    });

    // 删除 prompt
    item.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deletePrompt(prompt.id);
    });

    list.appendChild(item);
  });
}
