/**
 * Octi Browser Bridge — Content Script
 *
 * Injected into all pages. Provides DOM access for the background service worker
 * via chrome.runtime messaging. Also highlights elements during agent interactions.
 */

// Highlight element briefly when agent interacts with it
function highlightElement(el, color = 'rgba(66, 133, 244, 0.3)', duration = 2000) {
  const original = el.style.outline;
  const originalBg = el.style.backgroundColor;
  const originalTransition = el.style.transition;
  el.style.transition = 'outline 0.2s, background-color 0.2s';
  el.style.outline = `3px solid ${color.replace('0.3', '0.8')}`;
  el.style.backgroundColor = color;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    el.style.outline = original;
    el.style.backgroundColor = originalBg;
    el.style.transition = originalTransition;
  }, duration);
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'highlight') {
    const el = document.querySelector(msg.selector);
    if (el) highlightElement(el, msg.color, msg.duration || 2000);
    sendResponse({ ok: true });
  }
  return false;
});
