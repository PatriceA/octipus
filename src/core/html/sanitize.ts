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

/** Per-tag attribute allowlist. */
export const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt']),
};

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

/**
 * Serialize a node subtree to sanitized HTML using the tag/attr allowlist.
 * `allowed` defaults to the base (reader) set; callers that need a wider set
 * (e.g. email, with div/span) pass it explicitly.
 */
export function serialize(node: AnyNode, allowed: Set<string> = ALLOWED_TAGS): string {
  if (isText(node)) return escapeText(node.data);
  if (!isTag(node)) return '';
  const tag = node.name.toLowerCase();
  const inner = node.children.map((c) => serialize(c, allowed)).join('');
  if (!allowed.has(tag)) return inner; // unwrap unknown tags, keep their text/children
  if (tag === 'br' || tag === 'hr') return `<${tag}>`;

  let attrs = '';
  const allowedAttrs = ALLOWED_ATTRS[tag];
  if (allowedAttrs) {
    for (const name of allowedAttrs) {
      let val = attr(node, name);
      if ((name === 'href' || name === 'src') && val) val = safeUrl(val);
      if (val) attrs += ` ${name}="${escapeAttr(val)}"`;
    }
  }
  if (tag === 'img') return `<img${attrs}>`;
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Sanitize a full HTML fragment to a safe string. Parses the input, removes
 * STRIP_TAGS subtrees, then serializes the remaining tree through the
 * allowlist. Use this to render untrusted HTML (e.g. an email body).
 */
export function sanitizeHtmlFragment(html: string, allowed: Set<string> = EMAIL_ALLOWED_TAGS): string {
  if (!html) return '';
  const doc = parseDocument(html);
  for (const tag of STRIP_TAGS) {
    for (const el of getElementsByTagName(tag, doc, true)) removeElement(el);
  }
  return doc.children.map((c) => serialize(c, allowed)).join('').trim();
}
