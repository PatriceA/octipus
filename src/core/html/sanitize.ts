/**
 * Allowlist HTML sanitizer (shared). Sanitization is by *construction*: the
 * output is rebuilt by serializing ONLY an allowlist of tags/attributes with
 * escaped text, so no script, style, event handler, `javascript:`/`data:` URL,
 * or private-IP `src` can survive. Safe to render as defense-in-depth alongside
 * a rendering CSP.
 *
 * Extracted from the reader extractor so the email viewer (and anything else
 * that must render untrusted HTML) reuses one vetted implementation instead of
 * hand-rolling a second XSS surface.
 */
import type { AnyNode, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';
import { getElementsByTagName, removeElement } from 'domutils';
import { parseDocument } from 'htmlparser2';

/** Tags whose subtree is chrome / unsafe — removed entirely before serialization. */
export const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form',
  'iframe', 'svg', 'math', 'button', 'input', 'select', 'textarea', 'template',
  // Media/embeds — historically XSS-adjacent, no place in a reader/email view.
  'object', 'embed', 'video', 'audio', 'source', 'track', 'param', 'picture',
]);

/**
 * Base allowlist — tags kept in the output; everything else is unwrapped to its
 * text/children. This matches the reader's original set (no `div`/`span`, which
 * the reader deliberately flattens away as layout chrome).
 */
export const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'em', 'strong', 'b', 'i', 'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'br', 'hr',
]);

/**
 * Email allowlist — the base set plus `div`/`span`, which email HTML uses
 * heavily for line/section structure (dropping them runs lines together).
 * They carry no allowed attributes, so they add no XSS surface.
 */
export const EMAIL_ALLOWED_TAGS = new Set([...ALLOWED_TAGS, 'div', 'span']);

/** Per-tag attribute allowlist (base / reader mode — URL-bearing only). */
export const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt']),
};

/**
 * Presentational (email-mode) per-tag attributes — purely layout, no script
 * surface. Email HTML is table-based and inline-styled; without these the
 * message collapses into unstyled text that looks nothing like the original
 * (the QA: "looks vastly different to … google"). Merged with `ALLOWED_ATTRS`
 * only when `presentational` is set.
 */
const PRESENTATIONAL_ATTRS: Record<string, Set<string>> = {
  img: new Set(['width', 'height', 'align']),
  table: new Set(['width', 'height', 'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing']),
  td: new Set(['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan']),
  th: new Set(['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan']),
  tr: new Set(['align', 'valign', 'bgcolor', 'height']),
  p: new Set(['align']),
  div: new Set(['align']),
  h1: new Set(['align']), h2: new Set(['align']), h3: new Set(['align']),
  h4: new Set(['align']), h5: new Set(['align']), h6: new Set(['align']),
};

/**
 * CSS properties kept from an inline `style` in presentational mode. Strictly
 * cosmetic — no `position` (overlay/clickjacking), no `behavior`/`expression`,
 * no anything that loads a resource. Values are additionally scrubbed by
 * `sanitizeStyle` (rejects `url(...)`, `expression`, `@import`, etc.).
 */
const SAFE_CSS_PROPS = new Set([
  // NOTE: `background-color` only — NOT the `background` shorthand, which
  // subsumes `background-image: url(...)` and would put resource loading one
  // value-pattern check away from working.
  'color', 'background-color',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'text-align', 'text-decoration', 'text-transform', 'text-indent',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'direction',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-style', 'border-width', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
  'display', 'vertical-align', 'text-overflow', 'overflow',
  'list-style', 'list-style-type', 'list-style-position',
]);

/**
 * Any CSS function that can load a resource, run script, or read host context.
 * Matched with optional whitespace before `(` because `url\n(` / `url\t(` are
 * still parsed as the function by browsers — `includes('url(')` would miss them
 * (defense-in-depth: don't let the filter be fooled even where the engine is
 * lenient). Colour/sizing functions (`rgb`/`rgba`/`hsl`/`hsla`/`calc`) are NOT
 * here — they're safe and legitimately used in email styling.
 */
const UNSAFE_CSS_FN = /(?:url|expression|image|image-set|cross-fade|element|attr|var|-moz-binding)\s*\(/i;

/**
 * Scrub an inline `style` value to only safe, cosmetic declarations. Drops any
 * declaration whose property isn't in `SAFE_CSS_PROPS` or whose value carries a
 * resource load / script / host-context vector (any `UNSAFE_CSS_FN`,
 * `javascript:`, `@import`, comments, angle brackets, backslash escapes).
 * Returns '' if nothing safe survives.
 */
export function sanitizeStyle(raw: string | undefined): string {
  if (!raw) return '';
  const out: string[] = [];
  for (const decl of raw.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!SAFE_CSS_PROPS.has(prop) || !value) continue;
    const lv = value.toLowerCase();
    if (UNSAFE_CSS_FN.test(lv) || lv.includes('javascript:')
      || lv.includes('@import') || lv.includes('/*') || lv.includes('<') || lv.includes('\\')) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

export const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;');

/** True for a private/loopback/link-local IP *literal* host (pure check). */
export function isPrivateHostLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  if (h === '::1' || /^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 loopback/link-local/ULA
  return false;
}

/**
 * Allow only http(s) and relative/anchor URLs, rejecting private-IP hosts.
 * Parses with the WHATWG URL API (against a base) so percent-encoded scheme
 * tricks (`javascript%3a…`) and protocol-relative private hosts can't slip the
 * regex; the ORIGINAL string is returned so relative links stay relative.
 */
export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  let u: URL;
  try {
    u = new URL(v, 'https://sanitize.invalid/');
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined; // drops javascript:, data:, vbscript:, …
  if (isPrivateHostLiteral(u.hostname)) return undefined; // drops http://169.254.169.254 etc.
  return v;
}

function attr(el: Element, name: string): string | undefined {
  const v = el.attribs?.[name];
  return v == null ? undefined : v;
}

export interface SerializeOptions {
  /** Tags kept in the output (defaults to the base reader set). */
  allowed?: Set<string>;
  /**
   * Keep cosmetic presentation — sanitized inline `style` plus layout
   * attributes (table widths, align, bgcolor, …). On for the email viewer so
   * messages render close to how the sender built them; off for the reader,
   * which deliberately flattens to clean prose.
   */
  presentational?: boolean;
}

/**
 * Serialize a node subtree to sanitized HTML using the tag/attr allowlist.
 * `opts.allowed` defaults to the base (reader) set; callers that need a wider
 * set (e.g. email, with div/span) pass it explicitly. `opts.presentational`
 * additionally keeps cosmetic style/layout attributes.
 */
export function serialize(node: AnyNode, opts: SerializeOptions = {}): string {
  if (isText(node)) return escapeText(node.data);
  if (!isTag(node)) return '';
  const allowed = opts.allowed ?? ALLOWED_TAGS;
  const tag = node.name.toLowerCase();
  const inner = node.children.map((c) => serialize(c, opts)).join('');
  if (!allowed.has(tag)) return inner; // unwrap unknown tags, keep their text/children

  let attrs = '';
  const allowedAttrs = ALLOWED_ATTRS[tag];
  if (allowedAttrs) {
    for (const name of allowedAttrs) {
      let val = attr(node, name);
      if ((name === 'href' || name === 'src') && val) val = safeUrl(val);
      if (val) attrs += ` ${name}="${escapeAttr(val)}"`;
    }
  }
  if (opts.presentational) {
    // Sanitized inline style.
    const style = sanitizeStyle(attr(node, 'style'));
    if (style) attrs += ` style="${escapeAttr(style)}"`;
    // Cosmetic layout attributes (no URL/script surface, used verbatim).
    const layout = PRESENTATIONAL_ATTRS[tag];
    if (layout) {
      for (const name of layout) {
        const val = attr(node, name);
        if (val) attrs += ` ${name}="${escapeAttr(val)}"`;
      }
    }
  }
  if (tag === 'br' || tag === 'hr') return `<${tag}${attrs}>`;
  if (tag === 'img') return `<img${attrs}>`;
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Sanitize a full HTML fragment to a safe string. Parses the input, removes
 * STRIP_TAGS subtrees, then serializes the remaining tree through the
 * allowlist. Use this to render untrusted HTML (e.g. an email body).
 *
 * `opts` may be the wider tag set directly (back-compat) or a
 * `SerializeOptions` bag. The email viewer passes `{ presentational: true }`.
 */
export function sanitizeHtmlFragment(
  html: string,
  opts: Set<string> | SerializeOptions = EMAIL_ALLOWED_TAGS,
): string {
  if (!html) return '';
  // Copy (never mutate the caller's opts object).
  const options: SerializeOptions = opts instanceof Set ? { allowed: opts } : { ...opts };
  if (!options.allowed) options.allowed = EMAIL_ALLOWED_TAGS;
  const doc = parseDocument(html);
  for (const tag of STRIP_TAGS) {
    for (const el of getElementsByTagName(tag, doc, true)) removeElement(el);
  }
  return doc.children.map((c) => serialize(c, options)).join('').trim();
}
