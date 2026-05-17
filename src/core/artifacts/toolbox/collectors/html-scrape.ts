/**
 * art_collect_html_scrape — fetch an HTML page and extract repeating rows
 * by a tiny CSS-subset selector. Each row yields one record with named
 * fields, also extracted via the same selector subset.
 *
 *   art_collect_html_scrape({
 *     url: 'https://news.example.com',
 *     row: 'article.post',
 *     fields: {
 *       title: 'h2',           // → text content
 *       href:  'a@href',       // → attribute value
 *       date:  'time@datetime',
 *     }
 *   })
 *   → { items: [{ title, href, date }, …] }
 *
 * Selector grammar (deliberately small):
 *   tag                          — match any element of that tag
 *   tag.class                    — class token match
 *   tag#id                       — id match
 *   tag[attr]                    — attribute presence
 *   tag[attr=value]              — attribute equality (quotes optional)
 *   tag@attr                     — extract attribute instead of text
 *
 * Anything more complex (combinators, pseudoclasses, regex) should go
 * through `art_collect_http_text` + `art_transform_regex_extract` in a
 * later phase.
 */

import { resolveVaultHeaders } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  url: string;
  row: string;
  fields: Record<string, string>;
  headers?: Record<string, string>;
  limit?: number;
}

interface Result {
  items: Record<string, string>[];
  count: number;
}

interface Sel {
  tag: string;
  classes: string[];
  id: string | null;
  attrs: { name: string; value?: string }[];
  extractAttr: string | null;
}

export const htmlScrapeCollector: ToolboxTool<Params, Result> = {
  id: 'art_collect_html_scrape',
  family: 'collect',
  description: 'Fetch an HTML page and extract repeating rows + named fields via a tiny CSS-subset selector.',
  keywords: ['scrape', 'html', 'css', 'selector', 'extract', 'crawl', 'parse'],
  defaultPermission: 'ASK',
  params: {
    url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL of the HTML page.' },
    row: { type: 'string', required: true, description: 'Selector that matches each repeating block (e.g. `article.post`).' },
    fields: {
      type: 'object',
      required: true,
      description: 'Map of `field_name` → selector. Append `@attr` to extract an attribute (e.g. `a@href`).',
    },
    headers: {
      type: 'object',
      description: 'Request headers; `${vault.<key>}` placeholders are resolved.',
    },
    limit: { type: 'number', description: 'Maximum rows to return (default 100, max 500).' },
  },
  returns: '`{ items: [{...fields}], count }`.',
  examples: [
    {
      summary: 'Scrape blog titles + links',
      params: {
        url: 'https://example.com/blog',
        row: 'article.post',
        fields: { title: 'h2', href: 'a@href' },
      },
    },
  ],
  tips: [
    'Only static HTML is supported (no JS-rendered DOM). For SPA pages, use the browser tool via `art_collect_octipus_tool`.',
    'Selector subset: tag, .class, #id, [attr], [attr=value], @attr. No combinators, no nth-child.',
    'Returned values are HTML-decoded (entities like &amp; become &) and whitespace-collapsed.',
  ],

  async execute(params) {
    if (!params.url) throw new Error('art_collect_html_scrape: missing `url`');
    if (!params.row) throw new Error('art_collect_html_scrape: missing `row`');
    if (!params.fields || typeof params.fields !== 'object') {
      throw new Error('art_collect_html_scrape: `fields` must be an object');
    }
    const limit = Math.max(1, Math.min(500, params.limit ?? 100));

    const headers = await resolveVaultHeaders(params.headers ?? {});
    if (!headers.accept) headers.accept = 'text/html, application/xhtml+xml';
    const res = await fetch(params.url, { headers });
    if (!res.ok) throw new Error(`html_scrape ${res.status}: ${res.statusText}`);
    const html = await res.text();

    const rowSel = parseSelector(params.row);
    const fieldSels: Record<string, Sel> = {};
    for (const [name, sel] of Object.entries(params.fields)) {
      fieldSels[name] = parseSelector(sel);
    }

    const items: Record<string, string>[] = [];
    for (const block of findElements(html, rowSel)) {
      const item: Record<string, string> = {};
      for (const [name, sel] of Object.entries(fieldSels)) {
        const matches = findElements(block.outerHtml, sel);
        const first = matches[0];
        if (!first) {
          item[name] = '';
          continue;
        }
        if (sel.extractAttr) {
          item[name] = first.attrs[sel.extractAttr] ?? '';
        } else {
          item[name] = decode(stripTags(first.innerHtml)).trim();
        }
      }
      items.push(item);
      if (items.length >= limit) break;
    }

    return { items, count: items.length };
  },
};

// ── selector grammar ───────────────────────────────────────────────
function parseSelector(raw: string): Sel {
  const sel: Sel = { tag: '', classes: [], id: null, attrs: [], extractAttr: null };
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`html_scrape: empty selector`);

  // @attr extraction comes after everything else.
  let body = trimmed;
  const attrMatch = body.match(/@([\w:-]+)$/);
  if (attrMatch) {
    sel.extractAttr = attrMatch[1];
    body = body.slice(0, -attrMatch[0].length);
  }

  // tag is everything up to the first .|#|[ or end.
  const tagMatch = body.match(/^([a-zA-Z][\w-]*)/);
  if (!tagMatch) throw new Error(`html_scrape: selector missing tag in "${raw}"`);
  sel.tag = tagMatch[1].toLowerCase();
  let rest = body.slice(sel.tag.length);

  while (rest.length > 0) {
    if (rest[0] === '.') {
      const m = rest.match(/^\.([\w-]+)/);
      if (!m) throw new Error(`html_scrape: bad class in "${raw}"`);
      sel.classes.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '#') {
      const m = rest.match(/^#([\w-]+)/);
      if (!m) throw new Error(`html_scrape: bad id in "${raw}"`);
      sel.id = m[1];
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = rest.match(/^\[([\w:-]+)(?:=("([^"]*)"|'([^']*)'|([^\]]+)))?\]/);
      if (!m) throw new Error(`html_scrape: bad attribute filter in "${raw}"`);
      sel.attrs.push({ name: m[1], value: m[3] ?? m[4] ?? m[5] });
      rest = rest.slice(m[0].length);
    } else {
      throw new Error(`html_scrape: unsupported selector token at "${rest}" in "${raw}"`);
    }
  }
  return sel;
}

// ── HTML element finder ────────────────────────────────────────────
interface ElementMatch {
  outerHtml: string;
  innerHtml: string;
  attrs: Record<string, string>;
}

/**
 * Find every element matching the selector. Walks the source with a
 * minimal stack-based parser — enough for the static pages this collector
 * is meant to handle. Void elements (br, img, hr…) are skipped.
 */
function findElements(html: string, sel: Sel): ElementMatch[] {
  const matches: ElementMatch[] = [];
  const tagRe = new RegExp(`<${sel.tag}\\b([^>]*)>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const openEnd = m.index + m[0].length;
    const attrs = parseAttrs(m[1]);
    if (!matchesAttrs(attrs, sel)) continue;
    const close = findCloseTag(html, sel.tag, openEnd);
    if (close === -1) continue;
    const inner = html.slice(openEnd, close);
    matches.push({
      outerHtml: html.slice(m.index, close + `</${sel.tag}>`.length),
      innerHtml: inner,
      attrs,
    });
  }
  return matches;
}

function matchesAttrs(attrs: Record<string, string>, sel: Sel): boolean {
  if (sel.id && attrs.id !== sel.id) return false;
  if (sel.classes.length > 0) {
    const tokens = (attrs.class ?? '').split(/\s+/).filter(Boolean);
    for (const c of sel.classes) {
      if (!tokens.includes(c)) return false;
    }
  }
  for (const a of sel.attrs) {
    if (!(a.name in attrs)) return false;
    if (a.value !== undefined && attrs[a.name] !== a.value) return false;
  }
  return true;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** Find the matching closing tag, accounting for nested same-name tags. */
function findCloseTag(html: string, tag: string, from: number): number {
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 1;
  openRe.lastIndex = from;
  closeRe.lastIndex = from;
  while (depth > 0) {
    const next = nextMatch(openRe, closeRe, html);
    if (!next) return -1;
    if (next.kind === 'open') depth++;
    else depth--;
    if (depth === 0) return next.index;
  }
  return -1;
}

function nextMatch(openRe: RegExp, closeRe: RegExp, src: string): { kind: 'open' | 'close'; index: number } | null {
  const openMatch = openRe.exec(src);
  const closeMatch = closeRe.exec(src);
  if (!openMatch && !closeMatch) return null;
  if (!openMatch) return { kind: 'close', index: closeMatch!.index };
  if (!closeMatch) return { kind: 'open', index: openMatch.index };
  if (openMatch.index < closeMatch.index) {
    // Rewind closeRe lastIndex to before this position so we re-check it next iteration.
    closeRe.lastIndex = closeMatch.index;
    return { kind: 'open', index: openMatch.index };
  }
  openRe.lastIndex = openMatch.index;
  return { kind: 'close', index: closeMatch.index };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

export default htmlScrapeCollector;
