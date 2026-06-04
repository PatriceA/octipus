/**
 * Pure HTML → ReaderDoc extraction (feature #4). Given raw page HTML and a URL,
 * find the main article content, strip chrome (nav/ads/scripts), and emit a
 * sanitized, reader-formatted document. No I/O — fully testable on fixtures.
 *
 * Sanitization is by construction: contentHtml is rebuilt by serializing ONLY
 * an allowlist of tags/attributes with escaped text, so no script, style,
 * event handler, or `javascript:` URL can survive — the output is safe to
 * render (defense-in-depth alongside the rendering CSP).
 */
import type { AnyNode, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';
import { getElementsByTagName, removeElement, textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';
import type { ReaderDoc } from './types';

/** Tags whose subtree is page chrome / unsafe — removed before extraction. */
const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form',
  'iframe', 'svg', 'math', 'button', 'input', 'select', 'textarea', 'template',
  // Media/embeds — no place in a reader view and historically XSS-adjacent.
  'object', 'embed', 'video', 'audio', 'source', 'track', 'param', 'picture',
]);

/** Tags we keep in the reader output. Everything else is unwrapped to its text. */
const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'em', 'strong', 'b', 'i', 'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'br', 'hr',
]);

/** Per-tag attribute allowlist. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt']),
};

/** Class/id substrings that mark a node as non-article chrome. */
const CHROME_RE = /(^|[\s_-])(nav|menu|footer|header|sidebar|comment|share|social|promo|advert|ad|cookie|banner|related|newsletter|subscribe)([\s_-]|$)/i;

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/** True for a private/loopback/link-local IP *literal* host (pure check). */
function isPrivateHostLiteral(host: string): boolean {
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
function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  let u: URL;
  try {
    u = new URL(v, 'https://reader.invalid/');
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

/** First <meta> whose `key` attribute equals one of `values`, returning content. */
function metaContent(metas: Element[], key: 'name' | 'property', values: string[]): string | undefined {
  for (const m of metas) {
    const k = (attr(m, key) ?? '').toLowerCase();
    if (values.includes(k)) {
      const c = attr(m, 'content');
      if (c?.trim()) return c.trim();
    }
  }
  return undefined;
}

/** Serialize a node subtree to sanitized HTML using the tag/attr allowlist. */
function serialize(node: AnyNode): string {
  if (isText(node)) return escapeText(node.data);
  if (!isTag(node)) return '';
  const tag = node.name.toLowerCase();
  const inner = node.children.map(serialize).join('');
  if (!ALLOWED_TAGS.has(tag)) return inner; // unwrap unknown tags, keep their text/children
  if (tag === 'br' || tag === 'hr') return `<${tag}>`;

  let attrs = '';
  const allowed = ALLOWED_ATTRS[tag];
  if (allowed) {
    for (const name of allowed) {
      let val = attr(node, name);
      if ((name === 'href' || name === 'src') && val) val = safeUrl(val);
      if (val) attrs += ` ${name}="${escapeAttr(val)}"`;
    }
  }
  if (tag === 'img') return `<img${attrs}>`;
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** Visible-text length of a node, used to score candidate containers. */
function scoreNode(el: Element): number {
  return textContent(el).replace(/\s+/g, ' ').trim().length;
}

/** Remove chrome-y descendants (by class/id heuristic) in place. */
function pruneChrome(root: Element): void {
  for (const el of getElementsByTagName('*', root, true)) {
    const sig = `${attr(el, 'class') ?? ''} ${attr(el, 'id') ?? ''}`;
    if (sig.trim() && CHROME_RE.test(sig)) removeElement(el);
  }
}

/**
 * Extract a ReaderDoc from raw HTML. `url` is echoed back and used as the
 * canonical link. Never throws on malformed HTML (the parser is lenient).
 */
export function extractReaderDoc(html: string, url: string): ReaderDoc {
  const doc = parseDocument(html);
  const metas = getElementsByTagName('meta', doc, true);

  // Metadata (prefer Open Graph / article meta, fall back to document tags).
  const titleTag = getElementsByTagName('title', doc, true)[0];
  const title =
    metaContent(metas, 'property', ['og:title']) ||
    metaContent(metas, 'name', ['twitter:title']) ||
    (titleTag ? textContent(titleTag).trim() : '') ||
    (getElementsByTagName('h1', doc, true)[0] ? textContent(getElementsByTagName('h1', doc, true)[0]).trim() : '') ||
    url;
  const byline = metaContent(metas, 'name', ['author']) || metaContent(metas, 'property', ['article:author']);
  const siteName = metaContent(metas, 'property', ['og:site_name']);
  const publishedAt =
    metaContent(metas, 'property', ['article:published_time']) ||
    metaContent(metas, 'name', ['date', 'pubdate', 'publishdate']);
  const leadImage = safeUrl(metaContent(metas, 'property', ['og:image']) || metaContent(metas, 'name', ['twitter:image']));

  // Strip unsafe / chrome tags everywhere before choosing the main content.
  for (const tag of STRIP_TAGS) {
    for (const el of getElementsByTagName(tag, doc, true)) removeElement(el);
  }

  // Pick the main content container: prefer semantic tags, else the highest-
  // scoring <div>/<section>; fall back to <body>.
  const semantic = [
    ...getElementsByTagName('article', doc, true),
    ...getElementsByTagName('main', doc, true),
    ...getElementsByTagName('*', doc, true).filter((e) => attr(e, 'role') === 'main'),
  ];
  let main: Element | undefined = semantic.sort((a, b) => scoreNode(b) - scoreNode(a))[0];
  if (!main || scoreNode(main) < 200) {
    const candidates = [
      ...getElementsByTagName('section', doc, true),
      ...getElementsByTagName('div', doc, true),
    ];
    const best = candidates.sort((a, b) => scoreNode(b) - scoreNode(a))[0];
    // Only promote a div/section candidate if it's a meaningfully better pick
    // than the semantic one (or there was none) — avoids selecting an empty
    // wrapper when the page has little text.
    if (best && scoreNode(best) > (main ? scoreNode(main) : 0)) main = best;
  }
  if (!main) main = getElementsByTagName('body', doc, true)[0];

  if (main) pruneChrome(main);

  const contentHtml = main ? serialize(main).replace(/\s+\n/g, '\n').trim() : '';
  const textContentStr = main ? textContent(main).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : '';
  const wordCount = textContentStr ? textContentStr.split(/\s+/).filter(Boolean).length : 0;

  return {
    url,
    title: title.trim() || url,
    byline,
    siteName,
    publishedAt,
    leadImage,
    contentHtml,
    textContent: textContentStr,
    wordCount,
    estReadMinutes: Math.max(1, Math.ceil(wordCount / 200)),
  };
}
