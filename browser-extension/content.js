/**
 * Assistant Browser Bridge — Content Script
 *
 * Injected into all pages. Provides DOM access for the background service worker
 * via chrome.runtime messaging. Also highlights elements during agent interactions.
 */

// Highlight element briefly when agent interacts with it
function highlightElement(el, color = 'rgba(66, 133, 244, 0.3)') {
  const original = el.style.outline;
  const originalBg = el.style.backgroundColor;
  el.style.outline = `3px solid ${color}`;
  el.style.backgroundColor = color;
  setTimeout(() => {
    el.style.outline = original;
    el.style.backgroundColor = originalBg;
  }, 1500);
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'highlight') {
    const el = document.querySelector(msg.selector);
    if (el) highlightElement(el, msg.color);
    sendResponse({ ok: true });
  }
  return false;
});
