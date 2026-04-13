const AI_HOSTNAMES = ["chatgpt.com", "chat.openai.com", "claude.ai"];

function isAiTab(url) {
  // 检查 URL 是否属于我们支持的 AI 网站
  try {
    const hostname = new URL(url).hostname;
    return AI_HOSTNAMES.some((h) => hostname.includes(h));
  } catch {
    return false;
  }
}

// 通知 side panel 清空（当前 tab 不是 AI 页面）
function notifyPanelClear() {
  chrome.runtime.sendMessage({ type: "TIMELINE_CLEAR" }).catch(() => {});
}

// 通知 content.js 重新解析并推送 timeline 给 side panel
function triggerContentReparse(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "REPARSE_NOW" }).catch(() => {});
}

// ── 监听：用户切换 tab（tab activation）
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (!tab.url) return;
    if (isAiTab(tab.url)) {
      triggerContentReparse(tabId);
    } else {
      notifyPanelClear();
    }
  });
});

// ── 监听：tab URL 变化（包括普通导航 + SPA 路由）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 只在 tab 完成加载时处理（status === "complete"）
  if (changeInfo.status !== "complete") return;
  // 只处理当前激活的 tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0] || tabs[0].id !== tabId) return;

    if (isAiTab(tab.url)) {
      triggerContentReparse(tabId);
    } else {
      notifyPanelClear();
    }
  });
});

// ── 原有功能保留：点击 icon 打开 side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
