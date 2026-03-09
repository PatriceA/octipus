/**
 * Assistant Browser Bridge — Service Worker (background.js)
 *
 * Maintains a WebSocket connection to the Assistant backend and dispatches
 * commands to content scripts or Chrome APIs.
 */

const DEFAULT_BACKEND_URL = 'ws://localhost:3005/ws/browser-bridge';
const RECONNECT_DELAY_MS = 5000;
const COMMAND_TIMEOUT_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 20000;

let ws = null;
let connected = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let apiKey = '';
let backendUrl = DEFAULT_BACKEND_URL;

// ── Connection Management ──────────────────────────────────────────

async function loadSettings() {
  const data = await chrome.storage.local.get(['apiKey', 'backendUrl', 'autoConnect']);
  apiKey = data.apiKey || '';
  backendUrl = data.backendUrl || DEFAULT_BACKEND_URL;
  return data;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  await loadSettings();

  if (!apiKey) {
    updateBadge('!', '#FF0000');
    broadcastStatus({ connected: false, error: 'No API key configured' });
    return;
  }

  try {
    ws = new WebSocket(`${backendUrl}?token=${encodeURIComponent(apiKey)}`);

    ws.onopen = async () => {
      connected = true;
      updateBadge('ON', '#4CAF50');

      // Send handshake
      const tabs = await chrome.tabs.query({});
      ws.send(JSON.stringify({
        type: 'connect',
        version: chrome.runtime.getManifest().version,
        tabCount: tabs.length,
        userAgent: navigator.userAgent,
      }));

      broadcastStatus({ connected: true });
      startHeartbeat();
      console.log('[Assistant] Connected to backend');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleBackendMessage(msg);
      } catch (err) {
        console.error('[Assistant] Failed to parse message:', err);
      }
    };

    ws.onclose = (event) => {
      connected = false;
      ws = null;
      stopHeartbeat();
      updateBadge('OFF', '#9E9E9E');
      broadcastStatus({ connected: false });
      console.log('[Assistant] Disconnected:', event.code, event.reason);

      // Auto-reconnect unless explicitly disconnected
      if (event.code !== 4000) {
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[Assistant] WebSocket error:', err);
    };
  } catch (err) {
    console.error('[Assistant] Connection failed:', err);
    scheduleReconnect();
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
  if (ws) {
    ws.close(4000, 'User disconnected');
    ws = null;
  }
  connected = false;
  updateBadge('OFF', '#9E9E9E');
  broadcastStatus({ connected: false });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Command Handling ───────────────────────────────────────────────

async function handleBackendMessage(msg) {
  if (msg.type === 'pong') return;

  if (msg.type === 'command') {
    const { id, command, params } = msg;
    try {
      const result = await executeCommand(command, params || {});
      sendResult(id, result);
    } catch (err) {
      sendResult(id, null, err.message || String(err));
    }
  }
}

function sendResult(commandId, result, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'result',
    id: commandId,
    result: error ? undefined : result,
    error: error || undefined,
  }));
}

async function executeCommand(command, params) {
  switch (command) {
    case 'navigate':
      return cmdNavigate(params);
    case 'screenshot':
      return cmdScreenshot(params);
    case 'extract_content':
      return cmdExtractContent(params);
    case 'click':
      return cmdClick(params);
    case 'fill':
      return cmdFill(params);
    case 'evaluate':
      return cmdEvaluate(params);
    case 'get_tabs':
      return cmdGetTabs(params);
    case 'get_cookies':
      return cmdGetCookies(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ── Command Implementations ────────────────────────────────────────

async function getTargetTab(params) {
  if (params.tabId) {
    return await chrome.tabs.get(params.tabId);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

async function cmdNavigate({ url, tabId }) {
  if (!url) throw new Error('Missing url parameter');
  const tab = await getTargetTab({ tabId });
  const updated = await chrome.tabs.update(tab.id, { url });
  // Wait for page to load
  await new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 30s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
  const finalTab = await chrome.tabs.get(tab.id);
  return { url: finalTab.url, title: finalTab.title, tabId: tab.id };
}

async function cmdScreenshot({ tabId, format }) {
  const tab = await getTargetTab({ tabId });
  // Focus the tab's window for captureVisibleTab
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  // Small delay for render
  await new Promise(r => setTimeout(r, 200));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: format || 'png',
    quality: 80,
  });
  return { image: dataUrl, tabId: tab.id, url: tab.url, title: tab.title };
}

async function cmdExtractContent({ tabId, selector }) {
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContent,
    args: [selector || null],
  });
  if (!results || !results[0]) throw new Error('Content extraction failed');
  return results[0].result;
}

async function cmdClick({ selector, tabId }) {
  if (!selector) throw new Error('Missing selector parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: clickElement,
    args: [selector],
  });
  if (!results || !results[0]) throw new Error('Click execution failed');
  return results[0].result;
}

async function cmdFill({ selector, value, tabId }) {
  if (!selector) throw new Error('Missing selector parameter');
  if (value === undefined) throw new Error('Missing value parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fillElement,
    args: [selector, value],
  });
  if (!results || !results[0]) throw new Error('Fill execution failed');
  return results[0].result;
}

async function cmdEvaluate({ expression, tabId }) {
  if (!expression) throw new Error('Missing expression parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: evaluateExpression,
    args: [expression],
  });
  if (!results || !results[0]) throw new Error('Evaluate execution failed');
  return results[0].result;
}

async function cmdGetTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map(t => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
    })),
  };
}

async function cmdGetCookies({ domain }) {
  if (!domain) throw new Error('Missing domain parameter');
  const cookies = await chrome.cookies.getAll({ domain });
  return {
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate,
    })),
  };
}

// ── Injected Functions (run in page context via executeScript) ──────

function extractPageContent(selector) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: `Element not found: ${selector}` };

  return {
    url: window.location.href,
    title: document.title,
    text: root.innerText?.slice(0, 50000),
    links: [...root.querySelectorAll('a[href]')].slice(0, 200).map(a => ({
      href: a.href,
      text: (a.textContent || '').trim().slice(0, 100),
    })),
    forms: [...root.querySelectorAll('form')].slice(0, 20).map(f => ({
      action: f.action,
      method: f.method,
      inputs: [...f.querySelectorAll('input,select,textarea')].map(i => ({
        name: i.name || i.id,
        type: i.type,
        placeholder: i.placeholder,
        value: i.type === 'password' ? '***' : (i.value || '').slice(0, 100),
      })),
    })),
    meta: {
      description: document.querySelector('meta[name="description"]')?.content,
      canonical: document.querySelector('link[rel="canonical"]')?.href,
    },
  };
}

function clickElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.click();
  return { success: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 100) };
}

function fillElement(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.focus();
  // Clear and set value
  el.value = '';
  el.value = value;
  // Dispatch events for React/Vue/Angular compatibility
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, tag: el.tagName, name: el.name || el.id };
}

function evaluateExpression(expression) {
  try {
    const result = eval(expression);
    // Serialize safely
    if (result === undefined) return { result: 'undefined' };
    if (result === null) return { result: 'null' };
    if (typeof result === 'function') return { result: `[Function: ${result.name}]` };
    try {
      return { result: JSON.parse(JSON.stringify(result)) };
    } catch {
      return { result: String(result) };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Badge & Status ─────────────────────────────────────────────────

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: 'status', ...status }).catch(() => {});
}

// ── Message Listener (from popup) ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_status') {
    sendResponse({ connected, backendUrl });
    return;
  }
  if (msg.type === 'connect') {
    connect().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true; // async
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'save_settings') {
    chrome.storage.local.set({
      apiKey: msg.apiKey,
      backendUrl: msg.backendUrl || DEFAULT_BACKEND_URL,
    }).then(() => {
      loadSettings().then(() => sendResponse({ ok: true }));
    });
    return true; // async
  }
});

// ── Tab Change Notifications ───────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (connected && ws && changeInfo.status === 'complete') {
    ws.send(JSON.stringify({
      type: 'tab_update',
      tab: { id: tabId, url: tab.url, title: tab.title },
    }));
  }
});

// ── Auto-Connect on Startup ────────────────────────────────────────

loadSettings().then((data) => {
  if (data.apiKey) {
    connect();
  } else {
    updateBadge('!', '#FF0000');
  }
});
