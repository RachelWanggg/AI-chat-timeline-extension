const AI_HOSTNAMES = ["chatgpt.com", "chat.openai.com", "claude.ai"];

function isAiTab(url) {
  // Check whether the URL belongs to one of the AI sites we support
  try {
    const hostname = new URL(url).hostname;
    return AI_HOSTNAMES.some((h) => hostname.includes(h));
  } catch {
    return false;
  }
}

// Tell the side panel to clear (the active tab is not an AI page)
function notifyPanelClear() {
  chrome.runtime.sendMessage({ type: "TIMELINE_CLEAR" }).catch(() => {});
}

// Ask content.js to re-parse and push a fresh timeline to the side panel
function triggerContentReparse(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "REPARSE_NOW" }).catch(() => {});
}

// Listen for tab activation
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

// Listen for tab URL changes (regular navigation as well as SPA routing)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only handle the currently active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0] || tabs[0].id !== tabId) return;

    if (changeInfo.status === "loading" && isAiTab(tab.url)) {
      // The page is reloading or navigating: clear the panel right away so it never shows
      // the previous conversation's stale timeline.
      notifyPanelClear();
      return;
    }

    if (changeInfo.status === "complete") {
      if (isAiTab(tab.url)) {
        triggerContentReparse(tabId);
      } else {
        notifyPanelClear();
      }
    }
  });
});

// Clicking the toolbar icon opens the side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Pro Mode: call the Anthropic API from the service worker, which is not subject to the
// content page's CSP.
// A 401 maps to err.code = "INVALID_KEY" so the caller can surface an API-key error.
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

// Handle messages from content.js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ADD_PROMPT_FROM_CONTENT: write straight to storage so it works whether or not the
  // side panel is open.
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
        // Ask the side panel to refresh its list (fails silently when the panel is closed)
        chrome.runtime.sendMessage({ type: 'PROMPT_LIBRARY_UPDATED' }).catch(() => {});
      });
    });
    return true; // Keep the channel open for the async sendResponse
  }

  // REVISE_VIA_API: call the Anthropic API
  if (message.type === 'REVISE_VIA_API') {
    const { prompt, apiKey, model } = message;
    callAnthropicAPI(prompt, apiKey, model)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message, code: err.code ?? null }));
    return true; // Keep the message channel open for the async response
  }

  return false;
});

