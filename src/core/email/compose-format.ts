/**
 * The light formatting of the Email page's compose box: the writer marks text
 * with a few plain-text signs (the toolbar inserts them), and the server turns
 * them into the mail's HTML part. Pure.
 *
 *   **bold**   *italic* or _italic_   [text](https://link)
 *   - item / * item      1. item      > quoted line
 *
 * The HTML is built here from these signs alone: every other character is
 * escaped, links must be http(s), and the result still goes through the shared
 * sanitizer. No HTML a browser produced is ever sent.
 */
import { sanitizeHtmlFragment } from '@/core/html/sanitize';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LINK = /\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
const BOLD = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;
const ITALIC_STAR = /(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g;
const ITALIC_UNDERSCORE = /(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g;

/** One line's inline signs as HTML: escaped first, so only the signs make tags. */
function inline(line: string): string {
  // Links are cut out before escaping so their URL is escaped once, as an attribute.
  const links: string[] = [];
  const marked = line.replace(LINK, (_m, text: string, url: string) => {
    links.push(`<a href="${escape(url)}">${escape(text)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  return escape(marked)
    .replace(BOLD, '<strong>$1</strong>')
    .replace(ITALIC_STAR, '$1<em>$2</em>')
    .replace(ITALIC_UNDERSCORE, '$1<em>$2</em>')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? '');
}

type Block = { kind: 'p' | 'ul' | 'ol' | 'quote'; lines: string[] };

const BULLET = /^\s{0,3}[-*]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const kind: Block['kind'] | 'blank' = !line.trim() ? 'blank' : BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : QUOTE.test(line) ? 'quote' : 'p';
    if (kind === 'blank') { out.push({ kind: 'p', lines: [] }); continue; }
    const content = kind === 'ul' ? line.match(BULLET)![1] : kind === 'ol' ? line.match(NUMBERED)![1] : kind === 'quote' ? line.match(QUOTE)![1] : line;
    const last = out.at(-1);
    if (last && last.kind === kind && (kind !== 'p' || last.lines.length > 0)) last.lines.push(content);
    else out.push({ kind, lines: [content] });
  }
  return out.filter((b) => b.lines.length > 0);
}

/** The HTML part of a formatted body. Sanitized with the shared allowlist before it is returned. */
export function formattedHtml(text: string): string {
  const html = blocks(text).map((b) => {
    if (b.kind === 'ul' || b.kind === 'ol') return `<${b.kind}>${b.lines.map((l) => `<li>${inline(l)}</li>`).join('')}</${b.kind}>`;
    if (b.kind === 'quote') return `<blockquote>${b.lines.map(inline).join('<br>')}</blockquote>`;
    return `<p>${b.lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
  return sanitizeHtmlFragment(`<div>${html}</div>`);
}

/** The plain-text part of a formatted body: the signs that only make sense as formatting are taken out. */
export function formattedText(text: string): string {
  return text
    .replace(LINK, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(BOLD, '$1')
    .replace(ITALIC_STAR, '$1$2')
    .replace(ITALIC_UNDERSCORE, '$1$2');
}

/**
 * A quoted or forwarded original as HTML, read as nothing but text: escaped,
 * a reply's "> " quote as one blockquote, line breaks kept.
 */
export function originalHtml(original: string): string {
  const lines = original.replace(/\r\n?/g, '\n').split('\n');
  const quoted = lines.findIndex((l) => /^>/.test(l));
  const plain = (part: string[]) => part.map(escape).join('<br>');
  const html = quoted >= 0 && lines.slice(quoted).every((l) => /^>/.test(l) || !l.trim())
    ? `<p>${plain(lines.slice(0, quoted))}</p><blockquote>${plain(lines.slice(quoted).map((l) => l.replace(/^> ?/, '')))}</blockquote>`
    : `<p>${plain(lines)}</p>`;
  return sanitizeHtmlFragment(`<div>${html}</div>`);
}

/**
 * The text and (for a formatted body) HTML parts of what the writer typed.
 * `originalAt`: where the quoted or forwarded original starts; only what is
 * above it is read as formatting, the original goes as it is.
 */
export function composeParts(body: string, format: 'plain' | 'rich' | undefined, originalAt?: number): { text: string; html?: string } {
  if (format !== 'rich') return { text: body };
  const at = originalAt !== undefined && Number.isInteger(originalAt) && originalAt >= 0 && originalAt <= body.length ? originalAt : body.length;
  const own = body.slice(0, at);
  const original = body.slice(at);
  if (!original) return { text: formattedText(own), html: formattedHtml(own) };
  return { text: formattedText(own) + original, html: `${formattedHtml(own)}\n${originalHtml(original)}` };
}
