/**
 * Interactive answers ("inline UI"): the authoring format and the marker that
 * replaces it once the server has stored the block.
 *
 * The root agent writes a fenced block in its reply:
 *
 *     ```octi-ui title="Loan calculator" height=360
 *     <style>…</style>
 *     <div>…</div>
 *     <script>…</script>
 *     ```
 *
 * At the end of the turn the server stores each block (`inline_ui_blocks`) and
 * replaces it with one marker line, `[[octi-ui:<uuid>|<title>]]`, which the web
 * renders as a sandboxed frame and every other surface turns into a plain
 * line (`inlineUiFallbackText`). While the reply streams, the web parses the
 * open fence to show a preview.
 *
 * Shared by the server and the web: no runtime imports (see work-stream.ts).
 * Fence rules follow CommonMark: an opening run of ≥3 backticks or tildes, a
 * closing run of the same character at least as long with nothing else on the
 * line; other fenced blocks are skipped whole, so an example shown inside a
 * ```markdown block is not taken for a real one.
 */

export const INLINE_UI_LANG = 'octi-ui';

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)(.*)$/;

/**
 * The opening line of a fenced block, or null. A backtick fence's info string
 * may not contain backticks (CommonMark): ```` ```npm i``` ```` is inline code
 * on a line, not a fence. The language is compared case-insensitively.
 */
function openingFence(line: string): { char: string; length: number; lang: string; info: string } | null {
  const open = OPEN_RE.exec(line);
  if (!open) return null;
  if (open[1][0] === '`' && open[3].includes('`')) return null;
  return { char: open[1][0], length: open[1].length, lang: open[2].toLowerCase(), info: open[3] };
}

/** Cheap pre-check: could `text` hold an `octi-ui` fence (any letter case)? */
export function mentionsInlineUiLang(text: string): boolean {
  return /octi-ui/i.test(text);
}
const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MARKER_LINE_RE = new RegExp(`^\\[\\[octi-ui:(${UUID_RE_SRC})(?:\\|([^\\]\\n]*))?\\]\\]$`);
const MARKER_GLOBAL_RE = new RegExp(`\\[\\[octi-ui:(${UUID_RE_SRC})(?:\\|([^\\]\\n]*))?\\]\\]`, 'g');

/** One `octi-ui` fence found in a text. Offsets are into the original text. */
export interface InlineUiFence {
  /** Index of the first character of the opening fence line. */
  start: number;
  /** Index just past the closing fence line (or the text end when unclosed). */
  end: number;
  /** Raw attribute text after the language tag. */
  info: string;
  title: string;
  height?: number;
  /** The block body between the fences. */
  body: string;
  /** False when the text ended before a closing fence (a cut-off reply, or still streaming). */
  closed: boolean;
}

interface Line { text: string; start: number; end: number }

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const stop = nl === -1 ? text.length : nl;
    lines.push({ text: text.slice(start, stop).replace(/\r$/, ''), start, end: nl === -1 ? stop : nl + 1 });
    if (nl === -1) break;
    start = nl + 1;
  }
  return lines;
}

function isClosing(line: string, char: string, length: number): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === char && m[1].length >= length;
}

/** Parse `title="…" height=360` (also single quotes, `title=word`). Unknown keys are ignored. */
export function parseInlineUiInfo(info: string): { title: string; height?: number } {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(info)) !== null) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  const height = attrs.height !== undefined && /^\d{1,5}$/.test(attrs.height) ? Number(attrs.height) : undefined;
  return { title: sanitizeInlineUiTitle(attrs.title ?? ''), ...(height !== undefined ? { height } : {}) };
}

/** Control, bidi and zero-width characters: never in a title or suggested text. */
const UNSAFE_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

/** Strip characters that could spoof or break a line of text the user or the model reads. */
export function stripUnsafeChars(text: string): string {
  return text.replace(UNSAFE_CHARS_RE, '');
}

/** A title safe for the marker line and the header: one line, no `]`/`|`, ≤ 80 chars. */
export function sanitizeInlineUiTitle(title: string): string {
  const clean = stripUnsafeChars(title.replace(/[\r\n\t]+/g, ' ')).replace(/[\]|[]/g, '').replace(/\s+/g, ' ').trim();
  return (clean || 'Interactive answer').slice(0, 80);
}

/**
 * Every `octi-ui` fence in `text`, in order. Other fenced blocks are skipped
 * whole. The last fence may be unclosed (`closed: false`).
 */
export function findInlineUiFences(text: string): InlineUiFence[] {
  const lines = splitLines(text);
  const fences: InlineUiFence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = openingFence(lines[i].text);
    if (!open) { i++; continue; }
    const bodyStart = lines[i].end;
    let j = i + 1;
    while (j < lines.length && !isClosing(lines[j].text, open.char, open.length)) j++;
    const closed = j < lines.length;
    if (open.lang === INLINE_UI_LANG) {
      const bodyEnd = closed ? lines[j].start : text.length;
      const { title, height } = parseInlineUiInfo(open.info);
      fences.push({
        start: lines[i].start,
        end: closed ? lines[j].end : text.length,
        info: open.info.trim(),
        title,
        ...(height !== undefined ? { height } : {}),
        body: text.slice(Math.min(bodyStart, bodyEnd), bodyEnd).replace(/\n$/, ''),
        closed,
      });
    }
    i = closed ? j + 1 : lines.length;
  }
  return fences;
}

/** True when the text holds at least one `octi-ui` fence (cheap pre-check first). */
export function hasInlineUiFence(text: string): boolean {
  return mentionsInlineUiLang(text) && findInlineUiFences(text).length > 0;
}

/** Replace each fence with `replace(fence, index)`; text outside fences is untouched. */
export function replaceInlineUiFences(text: string, replace: (fence: InlineUiFence, index: number) => string): string {
  const fences = findInlineUiFences(text);
  if (fences.length === 0) return text;
  let out = '';
  let cursor = 0;
  fences.forEach((fence, index) => {
    out += text.slice(cursor, fence.start) + replace(fence, index);
    cursor = fence.end;
    // Keep the line structure: a replacement is one line, re-add the newline the fence consumed.
    if (fence.closed && text[fence.end - 1] === '\n' && !out.endsWith('\n')) out += '\n';
  });
  return out + text.slice(cursor);
}

/**
 * Run `transform` over the text outside `octi-ui` fences, leaving fence bodies
 * byte-for-byte intact. Used for the worker's reply clean-ups (thinking-tag and
 * repetition stripping) that would otherwise corrupt markup.
 */
/** Placeholder delimiter: a private-use character no model writes. */
const HOLD = String.fromCharCode(0xe000);
const HOLD_RE = new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g');

export function transformOutsideInlineUiFences(text: string, transform: (outside: string) => string): string {
  const fences = findInlineUiFences(text);
  if (fences.length === 0) return transform(text);
  const holders: string[] = [];
  let masked = '';
  let cursor = 0;
  for (const fence of fences) {
    masked += text.slice(cursor, fence.start);
    masked += `${HOLD}${holders.length}${HOLD}`;
    holders.push(text.slice(fence.start, fence.end));
    cursor = fence.end;
  }
  masked += text.slice(cursor);
  return transform(masked).replace(HOLD_RE, (_m, n: string) => holders[Number(n)] ?? '');
}

/** The text with every `octi-ui` fence removed: the prose the tool-call recovery parsers may read. */
export function withoutInlineUiFences(text: string): string {
  return mentionsInlineUiLang(text) ? replaceInlineUiFences(text, () => '') : text;
}

// ── Marker ───────────────────────────────────────────────────────────────

export function inlineUiMarker(id: string, title: string): string {
  return `[[octi-ui:${id}|${sanitizeInlineUiTitle(title)}]]`;
}

export interface InlineUiMarker { id: string; title: string }

/** Parse a whole line as a marker, or null. */
export function parseInlineUiMarkerLine(line: string): InlineUiMarker | null {
  const m = MARKER_LINE_RE.exec(line.trim());
  return m ? { id: m[1], title: sanitizeInlineUiTitle(m[2] ?? '') } : null;
}

/** Ids of every marker in a text, in order. */
export function inlineUiMarkerIds(text: string): string[] {
  return [...text.matchAll(MARKER_GLOBAL_RE)].map((m) => m[1]);
}

/** One segment of an assistant message: markdown, or a marker to render as a block. */
export type InlineUiSegment =
  | { kind: 'text'; text: string }
  | { kind: 'block'; id: string; title: string };

/**
 * Split a stored assistant message into markdown and block segments. A marker
 * counts only on a line of its own, and never inside another fenced block.
 */
export function splitInlineUiSegments(text: string): InlineUiSegment[] {
  if (!text.includes('[[octi-ui:')) return [{ kind: 'text', text }];
  const segments: InlineUiSegment[] = [];
  let buffer: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    if (buffer.length) segments.push({ kind: 'text', text: buffer.join('\n') });
    buffer = [];
  };
  for (const line of text.split('\n')) {
    if (fence) {
      buffer.push(line);
      if (isClosing(line, fence.char, fence.length)) fence = null;
      continue;
    }
    const open = openingFence(line);
    if (open) {
      fence = { char: open.char, length: open.length };
      buffer.push(line);
      continue;
    }
    const marker = parseInlineUiMarkerLine(line);
    if (marker) { flush(); segments.push({ kind: 'block', ...marker }); continue; }
    buffer.push(line);
  }
  flush();
  return segments.filter((s) => s.kind === 'block' || s.text.trim() !== '');
}

/** The line a surface that cannot render the block shows instead. */
export function inlineUiFallbackLine(title: string): string {
  return `▸ Interactive answer “${sanitizeInlineUiTitle(title)}” — open this conversation in the Octipus web app to use it.`;
}

/**
 * Text for surfaces that cannot render blocks (TUI, channels, MCP, voice,
 * notifications): markers become a plain line, and an `octi-ui` fence that was
 * never extracted (a streamed draft) becomes the same line.
 */
export function inlineUiFallbackText(text: string): string {
  let out = text.includes('[[octi-ui:')
    ? text.replace(MARKER_GLOBAL_RE, (_m, _id: string, title?: string) => inlineUiFallbackLine(title ?? ''))
    : text;
  if (mentionsInlineUiLang(out)) out = replaceInlineUiFences(out, (f) => inlineUiFallbackLine(f.title));
  return out;
}

/** Text for speech: markers and fences are dropped instead of described. */
export function inlineUiSpeechText(text: string): string {
  let out = text.includes('[[octi-ui:') ? text.replace(MARKER_GLOBAL_RE, '') : text;
  if (mentionsInlineUiLang(out)) out = replaceInlineUiFences(out, () => '');
  return out;
}

/**
 * Split an authored block body into its parts: the content of every `<style>`
 * element, the content of every inline `<script>` element, and the remaining
 * markup. A `<script src>` is reported and dropped (no network, §4). An
 * unclosed `<style>`/`<script>` at the end means the body was cut off.
 */
export interface InlineUiParts {
  css: string;
  html: string;
  js: string;
  /** Problems found while splitting, e.g. `script-src`, `unclosed-script`. */
  issues: string[];
}

type RawTextTag = 'style' | 'script';

/** Ends a tag name: whitespace, `/`, `>` or the end of the text. */
function endsTagName(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/** The first `<style` or `<script` start tag at or after `from` in lowercased text. */
function nextRawTextTag(lower: string, from: number): { at: number; name: RawTextTag } | null {
  for (let lt = lower.indexOf('<', from); lt >= 0; lt = lower.indexOf('<', lt + 1)) {
    for (const name of ['style', 'script'] as const) {
      if (lower.startsWith(name, lt + 1) && endsTagName(lower[lt + 1 + name.length])) return { at: lt, name };
    }
  }
  return null;
}

/** The end tag closing a raw-text element: `</name` then anything up to `>` (as browsers read it). */
function rawTextEnd(lower: string, name: RawTextTag, from: number): { start: number; end: number } | null {
  for (let k = lower.indexOf(`</${name}`, from); k >= 0; k = lower.indexOf(`</${name}`, k + 2)) {
    if (!endsTagName(lower[k + 2 + name.length])) continue;
    const gt = lower.indexOf('>', k);
    return gt < 0 ? null : { start: k, end: gt + 1 };
  }
  return null;
}

const NON_JS_TYPE_RE = /\btype\s*=\s*["']?(?!text\/javascript|application\/javascript|module)[^"'\s>]+/i;

/**
 * One pass in document order, as a browser reads it: a `<style>` or `<script>`
 * element runs to its own end tag, so a `<style>` inside a script's string
 * stays script. Returns the markup left; an element without its end tag
 * means the body was cut off, and the rest is dropped.
 */
function splitPass(body: string, out: { css: string[]; js: string[]; issues: string[] }): string {
  const lower = body.toLowerCase();
  let html = '';
  let cursor = 0;
  for (let tag = nextRawTextTag(lower, 0); tag; tag = nextRawTextTag(lower, cursor)) {
    html += body.slice(cursor, tag.at);
    const openEnd = lower.indexOf('>', tag.at);
    const close = openEnd < 0 ? null : rawTextEnd(lower, tag.name, openEnd + 1);
    if (!close) { out.issues.push(`unclosed-${tag.name}`); return html; }
    const attrs = body.slice(tag.at + 1 + tag.name.length, openEnd);
    const inner = body.slice(openEnd + 1, close.start);
    if (tag.name === 'style') out.css.push(inner);
    else if (/\bsrc\s*=/i.test(attrs)) out.issues.push('script-src');
    else if (NON_JS_TYPE_RE.test(attrs)) out.issues.push('script-type');
    else out.js.push(inner);
    cursor = close.end;
  }
  return html + body.slice(cursor);
}

/** Passes before a body whose leftovers keep forming new tags is cut at the first one. */
const MAX_SPLIT_PASSES = 4;

export function splitInlineUiBody(body: string): InlineUiParts {
  const out = { css: [] as string[], js: [] as string[], issues: [] as string[] };
  let html = body;
  // Text around a removed element can join into a new tag
  // (`<scr<style></style>ipt>`): split again until nothing is removed. The
  // markup is sanitized again where it is shown; this keeps the parts honest.
  for (let pass = 0; pass < MAX_SPLIT_PASSES; pass++) {
    const next = splitPass(html, out);
    if (next === html) break;
    html = next;
  }
  const left = nextRawTextTag(html.toLowerCase(), 0);
  if (left) {
    out.issues.push(`unclosed-${left.name}`);
    html = html.slice(0, left.at);
  }
  return { css: out.css.join('\n').trim(), html: html.trim(), js: out.js.join('\n;\n').trim(), issues: [...new Set(out.issues)] };
}

/**
 * What a streaming preview may show of a half-written body: complete styles
 * and the markup so far, without any script, a trailing partial tag or a
 * trailing partial entity. The content runtime sanitizes it again; scripts
 * never run in a preview.
 */
export function previewInlineUiBody(body: string): { css: string; html: string } {
  const parts = splitInlineUiBody(body);
  const html = parts.html.replace(/<[^>]*$/, '').replace(/&[a-zA-Z0-9#]*$/, '');
  return { css: parts.css, html };
}
