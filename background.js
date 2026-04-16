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

// ── Pro Mode: 直接调用 Anthropic API（不受内容页 CSP 限制）
// 401 → err.code = "INVALID_KEY"（调用方可据此弹出 key 错误提示）
async function callAnthropicAPI(prompt, apiKey, model) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            'Please revise and improve the following prompt to make it clearer, more specific, ' +
            'and more effective. Return ONLY the revised prompt with no preamble or explanation.\n\n' +
            'Original prompt:\n---\n' +
            prompt.trim() +
            '\n---',
        },
      ],
    }),
  });

  if (response.status === 401) {
    const err = new Error('Invalid Anthropic API key');
    err.code = 'INVALID_KEY';
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('Anthropic API returned no content');
  return text;
}

// ── 监听来自 content.js 的消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ── ADD_PROMPT_FROM_CONTENT: 直接写 storage，不依赖 side panel 是否开启
  if (message.type === 'ADD_PROMPT_FROM_CONTENT') {
    const { title, text } = message;
    chrome.storage.local.get('promptLibrary', (result) => {
      const library = result.promptLibrary || [];
      library.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        title: title.trim(),
        text: text.trim(),
        category: 'Other',
        tags: [],
        createdAt: new Date().toISOString(),
      });
      chrome.storage.local.set({ promptLibrary: library }, () => {
        sendResponse({ ok: true });
        // 通知 side panel 刷新列表（panel 未开时静默失败）
        chrome.runtime.sendMessage({ type: 'PROMPT_LIBRARY_UPDATED' }).catch(() => {});
      });
    });
    return true; // 保持通道（async sendResponse）
  }

  // ── REVISE_VIA_API: 调用 Anthropic API
  if (message.type === 'REVISE_VIA_API') {
    const { prompt, apiKey, model } = message;
    callAnthropicAPI(prompt, apiKey, model)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message, code: err.code ?? null }));
    return true; // 保持消息通道开放（async response）
  }

  return false;
});

