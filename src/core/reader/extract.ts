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
import type { Element } from 'domhandler';
import { getElementsByTagName, removeElement, textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';
import { STRIP_TAGS, safeUrl, serialize } from '@/core/html/sanitize';
import type { ReaderDoc } from './types';

/** Class/id substrings that mark a node as non-article chrome. */
const CHROME_RE = /(^|[\s_-])(nav|menu|footer|header|sidebar|comment|share|social|promo|advert|ad|cookie|banner|related|newsletter|subscribe)([\s_-]|$)/i;

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
