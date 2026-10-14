/**
 * Saving an interactive answer as a live artifact (docs/plans/inline-ui-spec.md
 * §7, P3): a static copy — no data refresh, no network — that keeps the
 * answer's look and behaviour where the artifact embed can give it.
 *
 * The markup goes through the content runtime's sanitizer rules, applied here
 * on the server (`sanitizeInlineUiMarkup`), and is written out by a canonical
 * serializer: every text escaped, every attribute quoted and escaped, so the
 * browser parses back the tree the rules saw. What this parser and a browser
 * would read differently is not kept: the elements browsers parse as raw text
 * (`xmp`, `noembed`, …) are refused, and `<style>` elements are moved into the
 * CSS rather than serialized, which also closes the SVG/MathML `<style>`
 * re-parsing tricks. The embed's CSP (no inline script or handler, no network
 * for a saved answer) stands behind all of it.
 *
 * `{` is written as `&#123;` so the artifact template renderer never reads an
 * answer's text as a `{{placeholder}}`.
 *
 * The answer's script becomes the version's bundle (`writeVersion`, the
 * bundler path), after a shim for `octi`: its methods show a visible message
 * and reject — a saved copy has no chat to send to.
 */
import type { AnyNode, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import {
  INLINE_UI_DROPPED_ATTRIBUTES,
  INLINE_UI_ELEMENT_CSS,
  INLINE_UI_REFUSED_ELEMENTS,
} from '@/shared/inline-ui';

export { usesOctiBridge } from '@/shared/inline-ui';

/**
 * Refused on the server only: elements a browser parses as raw text, whose
 * content this parser would read as markup.
 */
const RAW_TEXT_ELEMENTS = ['xmp', 'plaintext', 'noembed', 'noframes'];
const REFUSED = new Set([...INLINE_UI_REFUSED_ELEMENTS, ...RAW_TEXT_ELEMENTS]);
const DROPPED = new Set(INLINE_UI_DROPPED_ATTRIBUTES);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RESOURCE_ATTRS = new Set(['src', 'poster', 'background', 'data', 'lowsrc']);
const TAG_NAME_RE = /^[a-z][a-z0-9-]*$/;
const ATTR_NAME_RE = /^[a-z_][a-z0-9_.:-]*$/;
const TEXT_SECURITY_RE = /-webkit-text-security\s*:[^;}]*;?|text-security\s*:[^;}]*;?/gi;

export interface SanitizedMarkup {
  html: string;
  /** The text of the markup's `<style>` elements, to add to the page CSS. */
  css: string;
  /** What was taken out, by the frame's item names. */
  removed: string[];
}

function cleanCss(css: string): string {
  return css.replace(TEXT_SECURITY_RE, '');
}

/** Script-free CSS for a `<style>` element: no way to close it early. */
export function cssForStyleElement(css: string): string {
  return cleanCss(css).replace(/</g, '\\3c ');
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;');
}

function textOf(node: AnyNode): string {
  if (isText(node)) return node.data;
  if ('children' in node) return (node.children as AnyNode[]).map(textOf).join('');
  return '';
}

export function sanitizeInlineUiMarkup(html: string): SanitizedMarkup {
  const doc = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true });
  const removed = new Set<string>();
  const styles: string[] = [];
  let uses = 0;
  let filters = 0;

  const attrs = (el: Element, svg: boolean): string => {
    const name = el.name;
    const out: Array<[string, string]> = [];
    let link: Array<[string, string]> | null = null;
    for (const [rawName, rawValue] of Object.entries(el.attribs)) {
      const an = rawName.toLowerCase();
      const v = String(rawValue);
      if (!ATTR_NAME_RE.test(an)) { removed.add('attribute'); continue; }
      if (an.startsWith('on')) { removed.add('inline-handler'); continue; }
      if (DROPPED.has(an)) { removed.add('attribute'); continue; }
      if (an === 'name' && name === 'img') continue;
      if (an === 'style' && /text-security/i.test(v)) { out.push([an, cleanCss(v)]); removed.add('text-security'); continue; }
      if (an === 'href' || an === 'xlink:href') {
        const vt = v.trim();
        if (!svg && (name === 'a' || name === 'area')) {
          if (/^https:\/\//i.test(vt)) link = [['data-octi-href', vt]];
          else if (vt.startsWith('#')) link = [['data-octi-anchor', vt.slice(1)]];
          else removed.add('url');
          continue;
        }
        if (svg && name !== 'a' && vt.startsWith('#')) { out.push([an, v]); continue; }
        removed.add('url');
        continue;
      }
      if (RESOURCE_ATTRS.has(an) && !/^\s*(data:|blob:)/i.test(v)) { removed.add('remote-resource'); continue; }
      out.push([an, v]);
    }
    if (link) {
      const kept = out.filter(([n]) => n !== 'role');
      out.length = 0;
      out.push(...kept, ...link, ['role', 'link']);
      if (!out.some(([n]) => n === 'tabindex')) out.push(['tabindex', '0']);
    }
    if (name === 'video' && !out.some(([n]) => n === 'disablepictureinpicture')) out.push(['disablepictureinpicture', '']);
    return out.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join('');
  };

  const isRefused = (el: Element): boolean => {
    if (REFUSED.has(el.name)) return true;
    if (el.name.startsWith('animate')) {
      const a = String(el.attribs.attributename ?? '').toLowerCase();
      if (a === 'href' || a === 'xlink:href' || a === 'src') return true;
    }
    return false;
  };

  const serialize = (node: AnyNode, svg: boolean): string => {
    if (isText(node)) return escapeText(node.data);
    if (!isTag(node)) return ''; // comments, CDATA, directives
    const el = node;
    const name = el.name;
    if (name === 'style') { styles.push(textOf(el)); return ''; }
    if (!TAG_NAME_RE.test(name)) { removed.add('element'); return ''; }
    if (isRefused(el)) { removed.add('element'); return ''; }
    if (name === 'use' && ++uses > 200) { removed.add('cost'); return ''; }
    if (name === 'filter' && ++filters > 20) { removed.add('cost'); return ''; }
    if (name === 'input') {
      const t = String(el.attribs.type ?? '').toLowerCase();
      const ac = String(el.attribs.autocomplete ?? '').toLowerCase();
      if (t === 'password' || t === 'file' || ac.includes('password')) {
        removed.add('credential-input');
        return '<span>[field removed: interactive answers never ask for passwords or files]</span>';
      }
    }
    const inSvg = svg || name === 'svg';
    const open = `<${name}${attrs(el, inSvg)}>`;
    if (VOID.has(name) && !inSvg) return open;
    // A browser reads title/textarea content as text: write it as text.
    const textOnly = name === 'textarea' || (name === 'title' && !inSvg);
    const inner = textOnly
      ? escapeText(textOf(el))
      : el.children.map((c) => serialize(c, inSvg && name !== 'foreignobject')).join('');
    return `${open}${inner}</${name}>`;
  };

  const out = doc.children.map((c) => serialize(c, false)).join('');
  return { html: out, css: styles.join('\n'), removed: [...removed] };
}

/**
 * Runs before the answer's script, in the same bundle scope. `octi` keeps its
 * shape; each method says on the page that it works only in the chat, and
 * rejects. Links the sanitizer kept (`data-octi-href`) show their address
 * instead of navigating; in-page anchors still scroll.
 */
export const PROMOTED_OCTI_SHIM = String.raw`var octi = (function () {
  var box = null, timer = 0;
  function notice(text) {
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:var(--octi-surface-container-high,#2b2930);color:var(--octi-on-surface,#e6e1e5);border:1px solid var(--octi-outline,#49454f);font:13px/1.4 var(--octi-sans,system-ui,sans-serif);overflow-wrap:anywhere;z-index:2147483647';
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { box.hidden = true; }, 8000);
  }
  function unavailable(what) {
    notice(what + ' works only in the chat this answer came from — not available here.');
    return Promise.reject(new Error('not available here'));
  }
  function onActivate(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-octi-href],[data-octi-anchor]') : null;
    if (!el) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    var anchor = el.getAttribute('data-octi-anchor');
    if (anchor !== null) {
      var target = document.getElementById(anchor);
      if (target) target.scrollIntoView({ block: 'nearest' });
      return;
    }
    notice('Link (opens only from the chat): ' + el.getAttribute('data-octi-href'));
  }
  document.addEventListener('click', onActivate, true);
  document.addEventListener('keydown', onActivate, true);
  var api = Object.freeze({
    version: 1,
    openLink: function () { return unavailable('Opening links'); },
    prompt: function () { return unavailable('Sending a message'); },
  });
  try { Object.defineProperty(window, 'octi', { value: api, writable: false, configurable: false }); } catch (e) {}
  return api;
})();
`;

export interface PromotedPage {
  template: string;
  css: string;
  /** Bundle source: the shim, then the answer's script. Empty when there is no script. */
  script: string;
  removed: string[];
}

/** The artifact page for a stored answer. */
export function promotedPage(block: { html: string; css: string; js: string; scripts: boolean }): PromotedPage {
  const markup = sanitizeInlineUiMarkup(block.html);
  const css = cssForStyleElement([
    INLINE_UI_ELEMENT_CSS,
    'body { padding: 16px; overflow-wrap: anywhere; }',
    markup.css,
    block.css,
  ].filter(Boolean).join('\n'));
  const hasLinks = /data-octi-(?:href|anchor)=/.test(markup.html);
  const js = block.scripts ? block.js.trim() : '';
  const script = js || hasLinks ? `${PROMOTED_OCTI_SHIM}\n;\n${js}\n` : '';
  return { template: markup.html, css, script, removed: markup.removed };
}
