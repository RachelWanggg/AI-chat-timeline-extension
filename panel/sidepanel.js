// Most recent timeline data received. togglePin re-renders from it.
let lastTimelineData = [];

// Currently pinned anchors
// key: anchorId, value: { id, label, userText }
let pinnedAnchors = new Map();

// Currently collapsed turns (everything is expanded by default)
const collapsedTurns = new Set();

// Current page URL, pushed by the content script. Used to build a per-conversation storage key.
let currentPageUrl = "unknown";

// Load previously saved pins from chrome.storage.local
async function loadPinnedAnchors() {
  const key = getStorageKey();
  const result = await chrome.storage.local.get(key);
  if (result[key]) {
    pinnedAnchors = new Map(Object.entries(result[key]));
  } else {
    pinnedAnchors = new Map(); // New conversation, start empty
  }
  renderPinnedSection();
}
// Called after every pin/unpin to persist to storage
async function savePinnedAnchors() {
  // A Map is not JSON-serializable, so convert to a plain object
  const key = getStorageKey();
  const obj = Object.fromEntries(pinnedAnchors);
  await chrome.storage.local.set({ [key]: obj });
}
// Toggle the pinned state of an anchor
async function togglePin(anchorId, label, userText) {
  if (pinnedAnchors.has(anchorId)) {
    pinnedAnchors.delete(anchorId);
  } else {
    pinnedAnchors.set(anchorId, { id: anchorId, label, userText });
  }
  await savePinnedAnchors();
  renderPinnedSection();
  renderTimeline(lastTimelineData); // Re-render so the pin buttons reflect the new state
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

    // Click to jump: highlight optimistically, scroll, and ignore observer reports while the
    // scroll settles so the highlight does not flicker en route.
    item.querySelector(".pinned-label").addEventListener("click", () => {
      isManualClick = true;
      setActiveAnchor(id);
      scrollToAnchor(id);
      setTimeout(() => { isManualClick = false; }, 1600);
    });

    // Click to unpin
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

// Prevent a scroll event from overriding the highlight right after a click
let isManualClick = false;
let lastActiveAnchorId = null;

function isElementInView(el, container) {
  if (!el || !container) return true;
  const r = el.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  return r.top >= cr.top && r.bottom <= cr.bottom;
}

// Set the active anchor, shared by click and scroll paths
function setActiveAnchor(anchorId) {
  if (!anchorId) return;
  if (anchorId === lastActiveAnchorId) return; // Skip redundant highlights that cause flicker
  lastActiveAnchorId = anchorId;

  document.querySelectorAll(".active").forEach((el) => el.classList.remove("active"));
  const el =
    document.querySelector(`[data-anchor-id="${anchorId}"]`) ||
    document.querySelector(`[data-turn-id="${anchorId}"]`);
  if (el) {
    el.classList.add("active");

    // Only scroll when the active item is out of view; scrolling on every update jitters
    const root = document.getElementById("timeline-root");
    if (root && !isElementInView(el, root)) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
}

// Send a jump message to content.js
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

// Build a per-conversation storage key from the active tab's URL, namespacing pins so
// different conversations do not share them.
function getStorageKey() {
  // return new Promise((resolve) => {
  //   chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  //     const url = tabs[0]?.url ?? "unknown";
  //     resolve(`pins:${url}`);
  //   });
  // });
  return `pins:${currentPageUrl}`;
}

// Render a single conversation turn
function renderTurn(turn) {
  // Outer container
  const block = document.createElement("div");
  block.className = "turn-block";
  block.dataset.turnId = turn.id;

  // User question row (the user anchor)
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

  // For now the click only logs; jumping to the page element comes later
  userRow.addEventListener("click", () => {
    console.log("[Timeline] user anchor clicked:", turn.id);
    isManualClick = true;
    setActiveAnchor(turn.id);
    scrollToAnchor(turn.id);
    setTimeout(() => { isManualClick = false; }, 1600);
  });

  block.appendChild(userRow);

  // Assistant anchors
  if (hasAssistantAnchors) {
    assistantWrapper = document.createElement("div");
    assistantWrapper.className = "assistant-anchors";
    assistantWrapper.dataset.turnId = turn.id;
    assistantWrapper.classList.toggle("hidden", collapsedTurns.has(turn.id));

    turn.assistantAnchors.forEach((anchor) => {
      const row = document.createElement("div");
      row.className = "assistant-anchor";
      row.dataset.anchorId = anchor.id;
      // Left: caret + label
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

      // Right: pin button
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

// Render the empty state
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

// Main render function
function renderTimeline(timelineData) {
  // Skip the re-render when nothing changed, to avoid flicker
  if (isSameTimeline(timelineData, lastTimelineData)) {
    return;
  }

  lastTimelineData = timelineData; // Keep the latest data for togglePin to re-render from
  pruneStalePinnedAnchors(timelineData);
  const turnIds = syncCollapsedTurns(timelineData);
  const root = document.getElementById("timeline-root");
  root.innerHTML = ""; // Clear previous content

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

// Escape HTML to prevent XSS (output encoding)
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Entry point: render once the page has loaded
document.addEventListener("DOMContentLoaded", () => {
  renderPinnedSection(); // Pins are empty at startup, so the section stays hidden
  renderTimeline([]);

  // Load settings and theme
  loadSettings();
  loadReviseSettings();

  // Load the Prompt Library
  loadPromptLibrary();

  // Prompt Library event listeners
  document.getElementById("fold-all-btn").addEventListener("click", toggleAllTurnsCollapse);
  document.getElementById("prompt-library-btn").addEventListener("click", openPromptDrawer);
  document.getElementById("close-prompt-drawer").addEventListener("click", closePromptDrawer);
  document.getElementById("save-prompt-btn").addEventListener("click", handleSavePrompt);
  document.getElementById("prompt-search-input").addEventListener("input", handleSearchPrompts);
  document.getElementById("context-compact-btn").addEventListener("click", handleCompactNowClick);

  // Settings
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

  // Revise mode switch
  document.getElementById('revise-mode-select').addEventListener('change', async (e) => {
    const proFields = document.getElementById('pro-mode-fields');
    const status    = document.getElementById('revise-config-status');
    status.textContent = '';
    // API Key Mode: only reveal the fields; nothing is written to storage until Save
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
  // Modal drag and resize setup
  initModalActions();

  // Clicking the backdrop closes the prompt drawer
  document.getElementById("prompt-drawer").addEventListener("click", (e) => {
    if (e.target.id === "prompt-drawer") {
      closePromptDrawer();
    }
  });

  // Messages from content.js
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TIMELINE_UPDATE") {
      console.log("[Panel] Received timeline data:", message.payload);
      if (message.url && message.url !== currentPageUrl) {
        // Conversation switch: load the new conversation's pins before rendering the
        // timeline, so the pin buttons show the right state.
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

    // background.js already saved it; the panel just reloads from storage
    if (message.type === "PROMPT_LIBRARY_UPDATED") {
      loadPromptLibrary();
    }
  });

  // Initial load: once the message channel exists, ask the active tab to re-parse
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

  // Tab switch: clear stale data and ask the new tab to re-parse
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

  // SPA URL changes (switching conversations on ChatGPT/Claude) are already covered by the
  // TIMELINE_CLEAR push, but tab.onUpdated sends one more REPARSE_NOW to guarantee the
  // content script actually ran a parse.
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

// Read revise settings from storage and populate the form
async function loadReviseSettings() {
  const config = await getReviseConfig();

  const modeSelect = document.getElementById('revise-mode-select');
  const proFields  = document.getElementById('pro-mode-fields');
  const keyInput   = document.getElementById('anthropic-key-input');
  const modelSelect = document.getElementById('anthropic-model-select');

  modeSelect.value = config.reviseMode ?? 'pro';
  keyInput.value   = config.anthropicApiKey;
  modelSelect.value = config.anthropicModel;

  // Show or hide the pro fields based on the selected mode
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

// One-time cleanup of the BYOK API key storage left behind by an older version.
// Runs once on the first launch of a new version, then is skipped.
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
   PROMPT LIBRARY
   ══════════════════════════════════════════════════ */

// In-memory Prompt Library data
let promptLibrary = [];

// Active category filter ("All" means no filtering)
let activeCategory = "All";

// Load saved prompts from chrome.storage.local
async function loadPromptLibrary() {
  try {
    const result = await chrome.storage.local.get("promptLibrary");
    promptLibrary = result.promptLibrary || [];
    renderPromptList();
  } catch (error) {
    console.error("[Prompt] Failed to load prompt library:", error);
  }
}

// Persist the Prompt Library to chrome.storage.local
async function savePromptLibrary() {
  try {
    await chrome.storage.local.set({ promptLibrary });
  } catch (error) {
    console.error("[Prompt] Failed to save prompt library:", error);
  }
}

// Generate a UUID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Add a new prompt
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

// Delete a prompt
async function deletePrompt(id) {
  if (!confirm("Delete this prompt?")) {
    return;
  }

  promptLibrary = promptLibrary.filter((p) => p.id !== id);
  await savePromptLibrary();
  renderPromptList();
}

// Edit a prompt in place
function editPrompt(id) {
  const prompt = promptLibrary.find((p) => p.id === id);
  if (!prompt) return;

  const item = document.querySelector(`[data-prompt-id="${id}"]`);
  if (!item) return;

  // Mark as editing
  item.classList.add("editing");

  // datalist options for the edit form, taken from the current library
  const editDatalistId = `edit-category-datalist-${id}`;
  const categoryOptions = getUniqueSortedCategories()
    .map((cat) => `<option value="${escapeHtml(cat)}">`)
    .join("");

  // Build the edit form
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

  // Focus the title input
  form.querySelector(".edit-title").focus();

  // Save handler
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

    // Update the prompt
    const promptObj = promptLibrary.find((p) => p.id === id);
    promptObj.title = newTitle;
    promptObj.category = newCategory || "Other";
    promptObj.tags = newTags;
    promptObj.text = newText;

    await savePromptLibrary();
    renderPromptList();
  });

  // Cancel handler
  form.querySelector(".cancel-edit-btn").addEventListener("click", () => {
    renderPromptList();
  });
}

// Clear the prompt form
function clearPromptForm() {
  document.getElementById("prompt-title-input").value = "";
  document.getElementById("prompt-category-input").value = "";
  document.getElementById("prompt-tags-input").value = "";
  document.getElementById("prompt-textarea").value = "";
}

// Handle saving a new prompt
async function handleSavePrompt() {
  const title = document.getElementById("prompt-title-input").value;
  const category = document.getElementById("prompt-category-input").value;
  const tags = document.getElementById("prompt-tags-input").value;
  const text = document.getElementById("prompt-textarea").value;
  await addPrompt(title, text, category, tags);
}

// Close the Prompt Library drawer
function closePromptDrawer() {
  const drawer = document.getElementById("prompt-drawer");
  drawer.classList.add("hidden");
  clearPromptForm();
  document.getElementById("prompt-search-input").value = "";
  activeCategory = "All";
}

// Filter prompts by search text AND category
function filterPrompts(searchQuery) {
  let results = promptLibrary;

  // Filter by the selected category chip
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

// Handle search input
function handleSearchPrompts(e) {
  const query = e.target.value;
  renderPromptList(query);
}

// All unique categories, alphabetically sorted
function getUniqueSortedCategories() {
  const cats = new Set(promptLibrary.map((p) => p.category || "Other"));
  return Array.from(cats).sort((a, b) => a.localeCompare(b));
}

// Render the category filter chips
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

// Sync <datalist> options so the category text input can autocomplete
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

// Render the prompt list
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

    // Copy the prompt text to the clipboard
    item.querySelector(".copy-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(prompt.text);
        // Transient feedback
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

    // Edit
    item.querySelector(".edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      editPrompt(prompt.id);
    });

    // Delete
    item.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deletePrompt(prompt.id);
    });

    list.appendChild(item);
  });
}
