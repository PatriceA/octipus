/**
 * The two nested frames that show an interactive answer (spec D6).
 *
 *   chat page ─ iframe sandbox=allow-scripts srcdoc=HOST ─▶ host frame (our code only)
 *                └─ iframe sandbox=allow-scripts srcdoc=CONTENT ─▶ content frame
 *                     (our runtime, then the sanitized markup, then the answer's script)
 *
 * Generated text is never concatenated into markup: every document here is a
 * constant plus a JSON literal (with `<` and U+2028/2029 escaped). The content
 * runtime parses the markup with an inert `<template>`, removes what §4.3
 * refuses, and only then inserts it; the answer's script is attached last with
 * the content nonce. The host never holds generated markup, observes the
 * content frame from outside (load events, CSP violations, message floods) and
 * relays validated messages to the chat page — the only frame the chat page
 * listens to.
 *
 * A `srcdoc` document copies its creator's policy container, so the content
 * frame enforces the host CSP as well as its own: the host CSP must allow
 * everything the content CSP allows (`contentCspAllowancesWithinHost` is tested).
 */
import { jsonForScript } from '../html';
import { INLINE_UI_LIMITS } from './limits';
import { inlineUiBaseCss, type InlineUiTheme } from './theme';

export { jsonForScript };

/** A per-mount nonce from the platform CSPRNG (browser and Node 24 alike). */
export function inlineUiNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * No `allow` attribute on either iframe (S3). The opaque-origin frames get
 * none of the powerful features (camera, microphone, geolocation, clipboard,
 * fullscreen, payment, …): their default allowlist is `'self'`, and an iframe
 * only gets them when its embedder delegates them. The features whose default
 * is `*` need network, which the CSP refuses — except picture-in-picture,
 * which the sanitizer disables on every `<video>` it lets through (a script
 * can still request it, with a click inside the frame, for a window that only
 * shows video frames). Denying it with `allow="picture-in-picture 'none'"`
 * would make Chromium log a console error on every frame mount.
 */
export const INLINE_UI_FRAME_SANDBOX = 'allow-scripts';

/** CSP of the content frame (`C` = content nonce). No network of any kind. */
export function contentCsp(contentNonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${contentNonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * CSP of the host frame. It also governs the content frame (inherited policy
 * container), so it allows what the content needs — and its `frame-src` is
 * what refuses the content frame's navigation to any remote URL (D9).
 */
export function hostCsp(hostNonce: string, contentNonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${hostNonce}' 'nonce-${contentNonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** Parse a CSP into directive → source list, for the inheritance test. */
export function parseCsp(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

const HEAD_GUARDS = '<meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">';

/** Everything the content runtime needs, embedded as a JSON literal. */
interface ContentPayload {
  ch: string;
  mode: 'static' | 'scripted';
  preview: boolean;
  html: string;
  css: string;
  js: string;
  nonce: string;
  promptChars: number;
}

/**
 * Elements the sanitizer removes with everything inside them (§4.3). The
 * content runtime and the server's copy for saved answers
 * (`core/inline-ui/promote.ts`) use this one list.
 */
export const INLINE_UI_REFUSED_ELEMENTS: readonly string[] = ['script', 'meta', 'link', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'form', 'noscript', 'template', 'slot', 'set'];
/**
 * Globals the content runtime removes before generated code runs: WebRTC,
 * which CSP does not govern, and the report observer, which would expose the
 * policy (and its nonce).
 */
export const INLINE_UI_WITHHELD_GLOBALS: readonly string[] = [
  'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCDtlsTransport',
  'RTCSctpTransport', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCSessionDescription',
  'RTCIceCandidate', 'RTCCertificate', 'RTCDTMFSender', 'ReportingObserver',
];
/** Attributes the sanitizer removes wherever they appear. */
export const INLINE_UI_DROPPED_ATTRIBUTES: readonly string[] = ['ping', 'attributionsrc', 'autofocus', 'formaction', 'action', 'shadowrootmode', 'shadowroot', 'srcdoc', 'srcset', 'imagesrcset'];

/**
 * The content runtime. Runs first (nonce C), caches every primitive it needs
 * before any generated markup enters the document (DOM clobbering, §4.3),
 * sanitizes and inserts the markup, wires links, height, errors and the
 * `octi` bridge, and attaches the answer's script last.
 */
const CONTENT_RUNTIME = String.raw`(function (P) {
  'use strict';
  var w = window, d = document, parentRef = w.parent;
  // Nothing generated code can read may hold nonce C: with it, a nested
  // srcdoc frame (which CSP frame-src does not stop) would run script in a
  // realm this runtime never touched. The policy stays in force once parsed,
  // so its meta element and this script's element (whose text holds the
  // payload) leave the document; violation events, which carry the policy
  // text, stop at the window; the nonce getter answers ''.
  var selfScript = d.currentScript;
  if (selfScript) selfScript.remove();
  var cspMeta = d.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (cspMeta) cspMeta.remove();
  w.addEventListener('securitypolicyviolation', function (e) { e.stopImmediatePropagation(); }, true);
  // WebRTC is outside CSP (connect-src does not cover it, and browsers do not
  // implement the webrtc directive): ICE and STUN/TURN would reach any host.
  // ReportingObserver would hand back violation reports with the policy.
  ${JSON.stringify(INLINE_UI_WITHHELD_GLOBALS)}.forEach(function (n) {
    try { Object.defineProperty(w, n, { value: undefined, writable: false, configurable: false }); } catch (e) { /* not in this engine */ }
  });
  var post = function (m) { parentRef.postMessage(m, '*'); };
  var createEl = d.createElement.bind(d);
  var getById = d.getElementById.bind(d);
  var body = d.body, head = d.head;
  var raf = w.requestAnimationFrame.bind(w);
  var RO = w.ResizeObserver;
  var slice = Array.prototype.slice;
  var HTML_NS = 'http://www.w3.org/1999/xhtml', SVG_NS = 'http://www.w3.org/2000/svg';
  var REFUSED = ${JSON.stringify(INLINE_UI_REFUSED_ELEMENTS)};
  var DROP_ATTRS = ${JSON.stringify(INLINE_UI_DROPPED_ATTRIBUTES)};
  var CLASSES = ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'Error'];
  var removed = {};
  function send(type, data) {
    var m = { v: 1, ch: P.ch, type: type };
    if (data) for (var k in data) m[k] = data[k];
    post(m);
  }
  function note(code) { removed[code] = 1; }
  function isRefused(el) {
    var n = String(el.localName).toLowerCase();
    if (REFUSED.indexOf(n) >= 0) return true;
    if (n.indexOf('animate') === 0) {
      var a = String(el.getAttribute('attributeName') || '').toLowerCase();
      if (a === 'href' || a === 'xlink:href' || a === 'src') return true;
    }
    return false;
  }
  function cleanCss(css) { return String(css).replace(/-webkit-text-security\s*:[^;}]*;?|text-security\s*:[^;}]*;?/gi, ''); }
  function sanitize(root) {
    var all = root.querySelectorAll('*');
    var uses = 0, filters = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el !== root && !root.contains(el)) continue;
      if (isRefused(el)) { el.remove(); note('element'); continue; }
      var n = String(el.localName).toLowerCase(), ns = el.namespaceURI;
      if (n === 'use' && ++uses > 200) { el.remove(); note('cost'); continue; }
      if (n === 'filter' && ++filters > 20) { el.remove(); note('cost'); continue; }
      if (n === 'video') el.setAttribute('disablepictureinpicture', '');
      if (n === 'input') {
        var t = String(el.getAttribute('type') || '').toLowerCase();
        var ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
        if (t === 'password' || t === 'file' || ac.indexOf('password') >= 0) {
          var span = createEl('span');
          span.textContent = '[field removed: interactive answers never ask for passwords or files]';
          el.replaceWith(span); note('credential-input'); continue;
        }
      }
      var attrs = slice.call(el.attributes);
      for (var j = 0; j < attrs.length; j++) {
        var at = attrs[j], an = String(at.name).toLowerCase(), v = String(at.value);
        if (an.indexOf('on') === 0) { el.removeAttribute(at.name); note('inline-handler'); continue; }
        if (DROP_ATTRS.indexOf(an) >= 0) { el.removeAttribute(at.name); note('attribute'); continue; }
        if (an === 'name' && n === 'img') { el.removeAttribute(at.name); continue; }
        if (an === 'style' && /text-security/i.test(v)) { el.setAttribute('style', cleanCss(v)); note('text-security'); continue; }
        if (an === 'href' || an === 'xlink:href') {
          var vt = v.trim();
          if (ns === HTML_NS && (n === 'a' || n === 'area')) {
            el.removeAttribute(at.name);
            if (/^https:\/\//i.test(vt)) el.setAttribute('data-octi-href', vt);
            else if (vt.charAt(0) === '#') el.setAttribute('data-octi-anchor', vt.slice(1));
            else { note('url'); continue; }
            el.setAttribute('role', 'link');
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
            continue;
          }
          if (ns === SVG_NS && n !== 'a' && vt.charAt(0) === '#') continue;
          el.removeAttribute(at.name); note('url'); continue;
        }
        if (an === 'src' || an === 'poster' || an === 'background' || an === 'data' || an === 'lowsrc') {
          if (!/^\s*(data:|blob:)/i.test(v)) { el.removeAttribute(at.name); note('remote-resource'); }
        }
      }
    }
  }
  var styleEl = createEl('style');
  head.appendChild(styleEl);
  function render(html, css) {
    removed = {};
    var tpl = createEl('template');
    tpl.innerHTML = String(html);
    sanitize(tpl.content);
    styleEl.textContent = cleanCss(css);
    body.replaceChildren(tpl.content);
  }
  var heightPending = false;
  function reportHeight() {
    if (heightPending) return;
    heightPending = true;
    raf(function () {
      heightPending = false;
      // The root element's box is the content's height (html and body are
      // height:auto); scrollHeight would be at least the frame's viewport.
      send('height', { height: Math.ceil(d.documentElement.getBoundingClientRect().height) });
    });
  }
  function findLink(e) {
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (!el || el.nodeType !== 1) continue;
      if (el.hasAttribute('data-octi-href')) return { url: el.getAttribute('data-octi-href') };
      if (el.hasAttribute('data-octi-anchor')) return { anchor: el.getAttribute('data-octi-anchor') };
      var ln = String(el.localName).toLowerCase();
      if ((ln === 'a' || ln === 'area') && el.hasAttribute('href')) return { url: el.getAttribute('href') };
    }
    return null;
  }
  function activate(e) {
    var l = findLink(e);
    if (!l) return;
    e.preventDefault();
    e.stopPropagation();
    if (l.anchor !== undefined) {
      var target = getById(l.anchor);
      if (target) target.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (/^https:\/\//i.test(String(l.url).trim())) send('link', { url: String(l.url).trim() });
  }
  d.addEventListener('click', activate, true);
  d.addEventListener('auxclick', activate, true);
  d.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') activate(e); }, true);
  d.addEventListener('dragstart', function (e) { if (findLink(e)) e.preventDefault(); }, true);
  w.addEventListener('error', function (e) {
    var c = e.error && e.error.name;
    send('error', { kind: 'script', errorClass: CLASSES.indexOf(c) >= 0 ? c : 'other', line: typeof e.lineno === 'number' ? e.lineno : 0 });
  });
  w.addEventListener('unhandledrejection', function (e) {
    var c = e.reason && e.reason.name;
    send('error', { kind: 'script', errorClass: CLASSES.indexOf(c) >= 0 ? c : 'other', line: 0 });
  });
  Object.defineProperty(w, 'octi', {
    value: Object.freeze({
      version: 1,
      openLink: function (url) { send('link', { url: String(url) }); return Promise.resolve(); },
      prompt: function (text) { send('prompt', { text: String(text).slice(0, P.promptChars) }); return Promise.resolve(); },
    }),
    writable: false, configurable: false, enumerable: false,
  });
  render(P.html, P.css);
  if (RO) new RO(reportHeight).observe(d.documentElement);
  w.addEventListener('load', reportHeight);
  if (P.preview) {
    w.addEventListener('message', function (e) {
      if (e.source !== parentRef) return;
      var m = e.data;
      if (!m || m.v !== 1 || m.ch !== P.ch || m.type !== 'update' || typeof m.html !== 'string' || typeof m.css !== 'string') return;
      render(m.html, m.css);
      reportHeight();
    });
  }
  raf(function () {
    reportHeight();
    if (!P.preview) {
      var items = Object.keys(removed);
      if (items.length) send('error', { kind: 'removed', items: items });
      var visible = String(body.textContent || '').trim() || body.querySelector('svg,canvas,img,input,button,select,textarea,video,audio,progress,meter');
      if (!visible) send('error', { kind: 'blank', errorClass: 'other', line: 0 });
    }
    send('ready');
  });
  if (P.mode === 'scripted' && P.js) {
    var s = createEl('script');
    // The internal nonce only: no content attribute to read back.
    s.nonce = P.nonce;
    [w.HTMLElement, w.SVGElement, w.MathMLElement].forEach(function (C) {
      if (!C || !Object.getOwnPropertyDescriptor(C.prototype, 'nonce')) return;
      Object.defineProperty(C.prototype, 'nonce', { get: function () { return ''; }, set: function () {}, configurable: false });
    });
    s.textContent = P.js;
    body.appendChild(s);
  }
})`;

/** Everything the host runtime needs, embedded as a JSON literal. */
interface HostPayload {
  ch: string;
  title: string;
  preview: boolean;
  doc: string;
  flood: number;
  maxErrors: number;
  interval: number;
  maxPrompt: number;
  maxHtml: number;
  maxCss: number;
  items: string[];
}

/**
 * The host runtime: creates the content frame, watches it, relays validated
 * messages. Generated code never runs in this realm, so `stopped` cannot be
 * forged or suppressed by it.
 */
const HOST_RUNTIME = String.raw`(function (H) {
  'use strict';
  var w = window, d = document, parentRef = w.parent;
  var CLASSES = ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'Error', 'other'];
  function send(type, data) {
    var m = { v: 1, ch: H.ch, src: 'octi-ui-host', type: type };
    if (data) for (var k in data) m[k] = data[k];
    parentRef.postMessage(m, '*');
  }
  var f = d.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('title', H.title);
  f.style.cssText = 'border:0;width:100%;height:100%;display:block;background:transparent;color-scheme:normal';
  var loads = 0, stopped = false, invalid = [], errors = 0, lastBridge = 0;
  function stop(reason, host) {
    if (stopped) return;
    stopped = true;
    if (f.parentNode) f.parentNode.removeChild(f);
    send('stopped', { reason: reason, host: host || '' });
  }
  function flood() {
    var now = Date.now();
    invalid.push(now);
    while (invalid.length && now - invalid[0] > 1000) invalid.shift();
    if (invalid.length > H.flood) stop('flood');
  }
  f.addEventListener('load', function () { loads++; if (loads > 1) stop('navigation'); });
  d.addEventListener('securitypolicyviolation', function (e) {
    var host = '';
    try { host = new URL(e.blockedURI).host; } catch (err) { host = ''; }
    stop('navigation', host);
  });
  w.addEventListener('message', function (e) {
    if (stopped) return;
    var m = e.data;
    if (e.source === parentRef) {
      if (H.preview && m && m.v === 1 && m.ch === H.ch && m.type === 'update' && typeof m.html === 'string' && typeof m.css === 'string' && m.html.length <= H.maxHtml && m.css.length <= H.maxCss && f.contentWindow) {
        f.contentWindow.postMessage({ v: 1, ch: H.ch, type: 'update', html: m.html, css: m.css }, '*');
      }
      return;
    }
    if (e.source !== f.contentWindow) return;
    if (!m || typeof m !== 'object' || m.v !== 1 || m.ch !== H.ch) { flood(); return; }
    if (m.type === 'ready') { send('ready'); return; }
    if (m.type === 'height') {
      if (typeof m.height === 'number' && isFinite(m.height)) send('height', { height: Math.max(0, Math.min(100000, Math.ceil(m.height))) });
      else flood();
      return;
    }
    if (m.type === 'error') {
      var kind = m.kind === 'script' || m.kind === 'blank' || m.kind === 'removed' ? m.kind : '';
      if (!kind) { flood(); return; }
      if (errors >= H.maxErrors) return;
      errors++;
      var items = kind === 'removed' && Array.isArray(m.items)
        ? m.items.filter(function (x) { return typeof x === 'string' && H.items.indexOf(x) >= 0; }).slice(0, 20)
        : [];
      send('error', {
        kind: kind,
        errorClass: CLASSES.indexOf(m.errorClass) >= 0 ? m.errorClass : 'other',
        line: typeof m.line === 'number' && isFinite(m.line) ? Math.max(0, Math.min(1000000, Math.floor(m.line))) : 0,
        items: items,
      });
      return;
    }
    if (m.type === 'link' || m.type === 'prompt') {
      var now = Date.now();
      if (now - lastBridge < H.interval) { flood(); return; }
      lastBridge = now;
      if (m.type === 'link') {
        if (typeof m.url === 'string' && m.url.length <= 2048 && /^https:\/\/[^\s]+$/i.test(m.url)) send('link', { url: m.url });
        else flood();
      } else {
        if (typeof m.text === 'string' && m.text.trim().length > 0 && m.text.length <= H.maxPrompt) send('prompt', { text: m.text });
        else flood();
      }
      return;
    }
    flood();
  });
  f.srcdoc = H.doc;
  d.body.appendChild(f);
})`;

/** Codes the content runtime reports for removed parts (shown under the block). */
export const INLINE_UI_REMOVED_ITEMS = ['element', 'cost', 'credential-input', 'inline-handler', 'attribute', 'text-security', 'url', 'remote-resource'] as const;

export interface InlineUiFrameInput {
  /** Correlates messages with one mount; readable by generated code, not a secret. */
  channel: string;
  title: string;
  html: string;
  css: string;
  js: string;
  /** `scripted` attaches `js`; `static` never runs generated code. */
  mode: 'static' | 'scripted';
  /** A streaming preview: static, and accepts `update` messages from the chat page. */
  preview?: boolean;
  theme: InlineUiTheme;
  hostNonce?: string;
  contentNonce?: string;
}

/** The content frame's document (built by the chat page, loaded by the host). */
export function buildContentDocument(input: InlineUiFrameInput, contentNonce: string): string {
  const payload: ContentPayload = {
    ch: input.channel,
    mode: input.preview ? 'static' : input.mode,
    preview: !!input.preview,
    html: input.html,
    css: input.css,
    js: input.preview || input.mode !== 'scripted' ? '' : input.js,
    nonce: contentNonce,
    promptChars: INLINE_UI_LIMITS.promptChars,
  };
  return '<!doctype html><html><head>'
    + `<meta http-equiv="Content-Security-Policy" content="${contentCsp(contentNonce)}">`
    + HEAD_GUARDS
    + `<style>${inlineUiBaseCss(input.theme)}</style>`
    + '</head><body>'
    + `<script nonce="${contentNonce}">${CONTENT_RUNTIME}(${jsonForScript(payload)});</script>`
    + '</body></html>';
}

/** The host frame's document — the `srcdoc` of the iframe the chat page creates. */
export function buildHostDocument(input: InlineUiFrameInput): { doc: string; hostNonce: string; contentNonce: string } {
  const hostNonce = input.hostNonce ?? inlineUiNonce();
  const contentNonce = input.contentNonce ?? inlineUiNonce();
  const payload: HostPayload = {
    ch: input.channel,
    title: input.title,
    preview: !!input.preview,
    doc: buildContentDocument(input, contentNonce),
    flood: INLINE_UI_LIMITS.floodPerSecond,
    maxErrors: INLINE_UI_LIMITS.errorsPerMount,
    interval: INLINE_UI_LIMITS.bridgeIntervalMs,
    maxPrompt: INLINE_UI_LIMITS.promptChars,
    maxHtml: INLINE_UI_LIMITS.htmlChars * 2,
    maxCss: INLINE_UI_LIMITS.cssChars * 2,
    items: [...INLINE_UI_REMOVED_ITEMS],
  };
  const doc = '<!doctype html><html><head>'
    + `<meta http-equiv="Content-Security-Policy" content="${hostCsp(hostNonce, contentNonce)}">`
    + HEAD_GUARDS
    + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent}</style>'
    + '</head><body>'
    + `<script nonce="${hostNonce}">${HOST_RUNTIME}(${jsonForScript(payload)});</script>`
    + '</body></html>';
  return { doc, hostNonce, contentNonce };
}

/** Exposed for tests: the runtime sources are constants (only the JSON payload varies). */
export const INLINE_UI_RUNTIME_SOURCES = { content: CONTENT_RUNTIME, host: HOST_RUNTIME } as const;
