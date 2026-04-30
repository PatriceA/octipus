/**
 * Octi Browser Bridge — Service Worker (background.js)
 *
 * Maintains a WebSocket connection to Octipus backend and dispatches
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

// Console log buffer for capture
let consoleBuffer = [];
const MAX_CONSOLE_ENTRIES = 200;

// Network request buffer for monitoring
let networkBuffer = [];
const MAX_NETWORK_ENTRIES = 500;

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
      console.log('[Octi] Connected to backend');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleBackendMessage(msg);
      } catch (err) {
        console.error('[Octi] Failed to parse message:', err);
      }
    };

    ws.onclose = (event) => {
      connected = false;
      ws = null;
      stopHeartbeat();
      updateBadge('OFF', '#9E9E9E');
      broadcastStatus({ connected: false });
      console.log('[Octi] Disconnected:', event.code, event.reason);

      // Auto-reconnect unless explicitly disconnected
      if (event.code !== 4000) {
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[Octi] WebSocket error:', err);
    };
  } catch (err) {
    console.error('[Octi] Connection failed:', err);
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
    // ── Original commands ──
    case 'navigate':       return cmdNavigate(params);
    case 'screenshot':     return cmdScreenshot(params);
    case 'extract_content': return cmdExtractContent(params);
    case 'click':          return cmdClick(params);
    case 'fill':           return cmdFill(params);
    case 'evaluate':       return cmdEvaluate(params);
    case 'get_tabs':       return cmdGetTabs(params);
    case 'get_cookies':    return cmdGetCookies(params);

    // ── New: Tab management ──
    case 'new_tab':        return cmdNewTab(params);
    case 'close_tab':      return cmdCloseTab(params);
    case 'select_tab':     return cmdSelectTab(params);

    // ── New: Element interactions ──
    case 'hover':          return cmdHover(params);
    case 'select':         return cmdSelect(params);
    case 'press_key':      return cmdPressKey(params);
    case 'scroll':         return cmdScroll(params);
    case 'drag':           return cmdDrag(params);

    // ── New: Waiting & detection ──
    case 'wait_for':       return cmdWaitFor(params);
    case 'highlight':      return cmdHighlight(params);

    // ── New: Storage & state ──
    case 'get_storage':    return cmdGetStorage(params);
    case 'set_storage':    return cmdSetStorage(params);
    case 'set_cookies':    return cmdSetCookies(params);

    // ── New: Monitoring ──
    case 'get_console':    return cmdGetConsole(params);
    case 'get_network':    return cmdGetNetwork(params);

    // ── New: Dialog handling ──
    case 'handle_dialog':  return cmdHandleDialog(params);

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

// ── Original Commands ──

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
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
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

async function cmdClick({ selector, tabId, doubleClick }) {
  if (!selector) throw new Error('Missing selector parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: clickElement,
    args: [selector, !!doubleClick],
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

// ── New: Tab Management ──

async function cmdNewTab({ url, active }) {
  const tab = await chrome.tabs.create({
    url: url || 'about:blank',
    active: active !== false,
  });
  // If URL provided, wait for load
  if (url) {
    await new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });
  }
  const finalTab = await chrome.tabs.get(tab.id);
  return { tabId: finalTab.id, url: finalTab.url, title: finalTab.title };
}

async function cmdCloseTab({ tabId }) {
  const tab = await getTargetTab({ tabId });
  await chrome.tabs.remove(tab.id);
  return { closed: true, tabId: tab.id };
}

async function cmdSelectTab({ tabId }) {
  if (!tabId) throw new Error('Missing tabId parameter');
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  return { tabId: tab.id, url: tab.url, title: tab.title };
}

// ── New: Element Interactions ──

async function cmdHover({ selector, tabId }) {
  if (!selector) throw new Error('Missing selector parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: hoverElement,
    args: [selector],
  });
  if (!results || !results[0]) throw new Error('Hover execution failed');
  return results[0].result;
}

async function cmdSelect({ selector, value, tabId }) {
  if (!selector) throw new Error('Missing selector parameter');
  if (value === undefined) throw new Error('Missing value parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: selectOption,
    args: [selector, value],
  });
  if (!results || !results[0]) throw new Error('Select execution failed');
  return results[0].result;
}

async function cmdPressKey({ key, tabId, modifiers }) {
  if (!key) throw new Error('Missing key parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pressKey,
    args: [key, modifiers || {}],
  });
  if (!results || !results[0]) throw new Error('Key press execution failed');
  return results[0].result;
}

async function cmdScroll({ direction, amount, selector, tabId }) {
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrollPage,
    args: [direction || 'down', amount || 500, selector || null],
  });
  if (!results || !results[0]) throw new Error('Scroll execution failed');
  return results[0].result;
}

async function cmdDrag({ sourceSelector, targetSelector, tabId }) {
  if (!sourceSelector) throw new Error('Missing sourceSelector parameter');
  if (!targetSelector) throw new Error('Missing targetSelector parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: dragElement,
    args: [sourceSelector, targetSelector],
  });
  if (!results || !results[0]) throw new Error('Drag execution failed');
  return results[0].result;
}

// ── New: Waiting & Detection ──

async function cmdWaitFor({ selector, text, timeout, tabId }) {
  if (!selector && !text) throw new Error('Missing selector or text parameter');
  const tab = await getTargetTab({ tabId });
  const timeoutMs = timeout || 10000;

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: waitForElement,
    args: [selector || null, text || null, timeoutMs],
  });
  if (!results || !results[0]) throw new Error('Wait execution failed');
  return results[0].result;
}

async function cmdHighlight({ selector, color, duration, tabId }) {
  if (!selector) throw new Error('Missing selector parameter');
  const tab = await getTargetTab({ tabId });
  // Use the content script for highlighting
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'highlight',
      selector,
      color: color || 'rgba(66, 133, 244, 0.3)',
      duration: duration || 2000,
    });
    return { success: true, selector };
  } catch {
    // Fallback via executeScript if content script not loaded
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: highlightElementInPage,
      args: [selector, color || 'rgba(66, 133, 244, 0.3)', duration || 2000],
    });
    if (!results || !results[0]) throw new Error('Highlight failed');
    return results[0].result;
  }
}

// ── New: Storage & State ──

async function cmdGetStorage({ storageType, key, tabId }) {
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: getStorage,
    args: [storageType || 'local', key || null],
  });
  if (!results || !results[0]) throw new Error('Storage read failed');
  return results[0].result;
}

async function cmdSetStorage({ storageType, key, value, tabId }) {
  if (!key) throw new Error('Missing key parameter');
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: setStorage,
    args: [storageType || 'local', key, value],
  });
  if (!results || !results[0]) throw new Error('Storage write failed');
  return results[0].result;
}

async function cmdSetCookies({ name, value, url, domain, path, secure, httpOnly, expirationDate }) {
  if (!name || value === undefined) throw new Error('Missing name or value parameter');
  if (!url && !domain) throw new Error('Missing url or domain parameter');
  const details = { name, value };
  if (url) details.url = url;
  if (domain) details.domain = domain;
  if (path) details.path = path;
  if (secure !== undefined) details.secure = secure;
  if (httpOnly !== undefined) details.httpOnly = httpOnly;
  if (expirationDate) details.expirationDate = expirationDate;
  const cookie = await chrome.cookies.set(details);
  return { success: true, cookie };
}

// ── New: Monitoring ──

async function cmdGetConsole({ level, clear, tabId }) {
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: getConsoleLogs,
    args: [level || null, !!clear],
  });
  if (!results || !results[0]) throw new Error('Console capture failed');
  return results[0].result;
}

async function cmdGetNetwork({ filter, clear, tabId }) {
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: getNetworkRequests,
    args: [filter || null, !!clear],
  });
  if (!results || !results[0]) throw new Error('Network capture failed');
  return results[0].result;
}

// ── New: Dialog Handling ──

async function cmdHandleDialog({ action, text, tabId }) {
  const tab = await getTargetTab({ tabId });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: setupDialogHandler,
    args: [action || 'accept', text || null],
  });
  if (!results || !results[0]) throw new Error('Dialog handler setup failed');
  return results[0].result;
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

function clickElement(selector, doubleClick) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  if (doubleClick) {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  } else {
    el.click();
  }
  return { success: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 100) };
}

function fillElement(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.focus();
  el.value = '';
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, tag: el.tagName, name: el.name || el.id };
}

function evaluateExpression(expression) {
  try {
    const result = eval(expression);
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

// ── New Injected Functions ──

function hoverElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  return { success: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 100) };
}

function selectOption(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };
  if (el.tagName !== 'SELECT') return { success: false, error: `Element is not a <select>: ${el.tagName}` };

  // Try value match first, then text match
  let found = false;
  for (const opt of el.options) {
    if (opt.value === value || opt.textContent.trim() === value) {
      el.value = opt.value;
      found = true;
      break;
    }
  }
  if (!found) return { success: false, error: `Option not found: ${value}`, options: [...el.options].map(o => o.textContent.trim()) };

  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { success: true, selectedValue: el.value, selectedText: el.selectedOptions[0]?.textContent?.trim() };
}

function pressKey(key, modifiers) {
  const target = document.activeElement || document.body;
  const eventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!modifiers.ctrl,
    shiftKey: !!modifiers.shift,
    altKey: !!modifiers.alt,
    metaKey: !!modifiers.meta,
  };
  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
  if (key.length === 1) {
    target.dispatchEvent(new InputEvent('input', { data: key, inputType: 'insertText', bubbles: true }));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  return { success: true, key, target: target.tagName };
}

function scrollPage(direction, amount, selector) {
  let target = document;
  let el = null;

  if (selector) {
    el = document.querySelector(selector);
    if (!el) return { success: false, error: `Element not found: ${selector}` };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { success: true, scrolledTo: selector };
  }

  const opts = { behavior: 'smooth' };
  switch (direction) {
    case 'up':    window.scrollBy({ top: -amount, ...opts }); break;
    case 'down':  window.scrollBy({ top: amount, ...opts }); break;
    case 'left':  window.scrollBy({ left: -amount, ...opts }); break;
    case 'right': window.scrollBy({ left: amount, ...opts }); break;
    case 'top':   window.scrollTo({ top: 0, ...opts }); break;
    case 'bottom': window.scrollTo({ top: document.body.scrollHeight, ...opts }); break;
  }

  return {
    success: true,
    direction,
    scrollY: window.scrollY,
    scrollX: window.scrollX,
    pageHeight: document.body.scrollHeight,
  };
}

function dragElement(sourceSelector, targetSelector) {
  const source = document.querySelector(sourceSelector);
  const target = document.querySelector(targetSelector);
  if (!source) return { success: false, error: `Source not found: ${sourceSelector}` };
  if (!target) return { success: false, error: `Target not found: ${targetSelector}` };

  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  const dataTransfer = new DataTransfer();

  source.dispatchEvent(new DragEvent('dragstart', {
    bubbles: true, cancelable: true, dataTransfer,
    clientX: sourceRect.left + sourceRect.width / 2,
    clientY: sourceRect.top + sourceRect.height / 2,
  }));

  target.dispatchEvent(new DragEvent('dragover', {
    bubbles: true, cancelable: true, dataTransfer,
    clientX: targetRect.left + targetRect.width / 2,
    clientY: targetRect.top + targetRect.height / 2,
  }));

  target.dispatchEvent(new DragEvent('drop', {
    bubbles: true, cancelable: true, dataTransfer,
    clientX: targetRect.left + targetRect.width / 2,
    clientY: targetRect.top + targetRect.height / 2,
  }));

  source.dispatchEvent(new DragEvent('dragend', {
    bubbles: true, cancelable: true, dataTransfer,
  }));

  return { success: true };
}

function waitForElement(selector, text, timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    function check() {
      if (selector) {
        const el = document.querySelector(selector);
        if (el) {
          if (text) {
            if (el.textContent?.includes(text)) {
              return resolve({ found: true, selector, elapsed: Date.now() - startTime });
            }
          } else {
            return resolve({ found: true, selector, tag: el.tagName, elapsed: Date.now() - startTime });
          }
        }
      } else if (text) {
        if (document.body.textContent?.includes(text)) {
          return resolve({ found: true, text, elapsed: Date.now() - startTime });
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        return resolve({ found: false, timeout: true, elapsed: timeoutMs });
      }

      setTimeout(check, 200);
    }

    check();
  });
}

function highlightElementInPage(selector, color, duration) {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };

  const originalOutline = el.style.outline;
  const originalBg = el.style.backgroundColor;
  const originalTransition = el.style.transition;

  el.style.transition = 'outline 0.2s, background-color 0.2s';
  el.style.outline = `3px solid ${color.replace('0.3', '0.8')}`;
  el.style.backgroundColor = color;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  setTimeout(() => {
    el.style.outline = originalOutline;
    el.style.backgroundColor = originalBg;
    el.style.transition = originalTransition;
  }, duration);

  return { success: true, selector, tag: el.tagName };
}

function getStorage(storageType, key) {
  const storage = storageType === 'session' ? sessionStorage : localStorage;

  if (key) {
    const value = storage.getItem(key);
    try {
      return { key, value: JSON.parse(value) };
    } catch {
      return { key, value };
    }
  }

  // Return all entries (up to 100)
  const entries = {};
  const maxEntries = Math.min(storage.length, 100);
  for (let i = 0; i < maxEntries; i++) {
    const k = storage.key(i);
    const v = storage.getItem(k);
    try { entries[k] = JSON.parse(v); } catch { entries[k] = v; }
  }
  return { storageType, entries, count: storage.length };
}

function setStorage(storageType, key, value) {
  const storage = storageType === 'session' ? sessionStorage : localStorage;
  if (value === null || value === undefined) {
    storage.removeItem(key);
    return { success: true, action: 'removed', key };
  }
  storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  return { success: true, action: 'set', key };
}

function getConsoleLogs(level, clear) {
  // Install console interceptor if not present
  if (!window.__assistantConsoleBuffer) {
    window.__assistantConsoleBuffer = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;

    const capture = (lvl, origFn) => (...args) => {
      if (window.__assistantConsoleBuffer.length < 200) {
        window.__assistantConsoleBuffer.push({
          level: lvl,
          message: args.map(a => {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch { return String(a); }
          }).join(' '),
          timestamp: Date.now(),
        });
      }
      origFn.apply(console, args);
    };

    console.log = capture('log', origLog);
    console.warn = capture('warn', origWarn);
    console.error = capture('error', origError);
    console.info = capture('info', origInfo);
  }

  let logs = window.__assistantConsoleBuffer || [];
  if (level) {
    logs = logs.filter(l => l.level === level);
  }

  const result = { logs: logs.slice(-100), total: logs.length };

  if (clear) {
    window.__assistantConsoleBuffer = [];
  }

  return result;
}

function getNetworkRequests(filter, clear) {
  // Install performance observer if not present
  if (!window.__assistantNetworkBuffer) {
    window.__assistantNetworkBuffer = [];

    // Use PerformanceObserver for Resource Timing
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (window.__assistantNetworkBuffer.length < 500) {
            window.__assistantNetworkBuffer.push({
              name: entry.name,
              type: entry.initiatorType,
              duration: Math.round(entry.duration),
              size: entry.transferSize || 0,
              startTime: Math.round(entry.startTime),
            });
          }
        }
      });
      observer.observe({ type: 'resource', buffered: true });
      window.__assistantNetworkObserver = observer;
    } catch { /* PerformanceObserver not supported */ }
  }

  let requests = window.__assistantNetworkBuffer || [];
  if (filter) {
    const f = filter.toLowerCase();
    requests = requests.filter(r =>
      r.name.toLowerCase().includes(f) ||
      r.type.toLowerCase().includes(f)
    );
  }

  const result = { requests: requests.slice(-200), total: requests.length };

  if (clear) {
    window.__assistantNetworkBuffer = [];
  }

  return result;
}

function setupDialogHandler(action, promptText) {
  // Set up a handler for the next dialog (alert/confirm/prompt)
  window.__assistantDialogResult = null;

  const handler = (event) => {
    window.__assistantDialogResult = {
      type: event.type === 'beforeunload' ? 'beforeunload' : 'dialog',
      message: event.message || event.returnValue,
      defaultPrompt: event.defaultValue,
    };

    if (action === 'dismiss') {
      event.preventDefault();
      event.returnValue = '';
      return false;
    }
    // accept is the default behavior
  };

  // Override window methods for next dialog
  const origAlert = window.alert;
  const origConfirm = window.confirm;
  const origPrompt = window.prompt;

  window.alert = (msg) => {
    window.__assistantDialogResult = { type: 'alert', message: msg };
    window.alert = origAlert;
    // Silently accept
  };

  window.confirm = (msg) => {
    window.__assistantDialogResult = { type: 'confirm', message: msg };
    window.confirm = origConfirm;
    return action === 'accept';
  };

  window.prompt = (msg, defaultValue) => {
    window.__assistantDialogResult = { type: 'prompt', message: msg, defaultValue };
    window.prompt = origPrompt;
    if (action === 'dismiss') return null;
    return promptText !== null ? promptText : defaultValue;
  };

  // Auto-restore after 30 seconds
  setTimeout(() => {
    window.alert = origAlert;
    window.confirm = origConfirm;
    window.prompt = origPrompt;
  }, 30000);

  return { success: true, action, message: 'Dialog handler installed for next dialog' };
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
