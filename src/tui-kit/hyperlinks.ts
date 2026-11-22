/**
 * OSC 8 hyperlinks for URLs and `path:line` references, made safe.
 *
 * Outside text never carries its own sequences to the screen
 * (`displayText` removes them); the links here are added by the app, after
 * that, and only for `http`, `https` and `file` URLs — a `file` URL only for
 * this machine (no host, `localhost` or its own name: `file://attacker/share`
 * is a UNC path, and opening one hands Windows' NTLM credentials to that
 * host). pi-tui's Markdown also
 * links `[text](href)` with whatever href the reply wrote, so
 * `sanitizeHyperlinks` runs over rendered rows and drops any link whose URL
 * is not one of those schemes, or that holds a control character or a
 * space — the text stays, unlinked.
 *
 * Links are written only where the terminal shows them: pi-tui's detection
 * (kitty, Ghostty, WezTerm, iTerm2, Windows Terminal, VS Code, Alacritty, and
 * tmux when it forwards them) plus VTE 0.50 and newer (GNOME Terminal,
 * Tilix), which pi-tui leaves out. Elsewhere the text is left as it is.
 */
import { getCapabilities, setCapabilityOverrides } from '@earendil-works/pi-tui';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE_SCHEMES = new Set(['http:', 'https:', 'file:']);

/** Whether a `file:` URL's host is this machine: none, `localhost`, or its own name (what `fileUrlFor` writes). */
export function isLocalFileHost(host: string, self: string = hostname()): boolean {
  const name = host.toLowerCase();
  return name === '' || name === 'localhost' || name === self.toLowerCase();
}

/**
 * The URL as a link may carry it, or null: an allowed scheme, nothing that
 * could end or extend the sequence, and for `file:` a file of this machine.
 */
export function safeUrl(url: string): string | null {
  if (!url || /[\x00-\x20\x7f-\x9f]/.test(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; } // not a URL: no link, the text stays
  if (!SAFE_SCHEMES.has(parsed.protocol)) return null;
  if (parsed.protocol === 'file:' && !isLocalFileHost(parsed.hostname)) return null;
  return parsed.href;
}

/** `text` linked to `url`, or `text` alone when the URL is not safe. */
export function hyperlink(text: string, url: string): string {
  const href = safeUrl(url);
  return href ? `\x1b]8;;${href}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

/** Whether this terminal shows OSC 8 links. VTE ≥ 0.50 does; pi-tui does not list it, so it is added here, once. */
export function hyperlinksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (getCapabilities().hyperlinks) return true;
  const vte = Number(env.VTE_VERSION ?? 0);
  if (vte >= 5000 && !env.TMUX && !(env.TERM ?? '').startsWith('screen')) {
    setCapabilityOverrides({ hyperlinks: true });
    return true;
  }
  return false;
}

const OSC8 = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(\x07|\x1b\\)/g;

/** Drop every link in a rendered row whose URL is not safe; its text stays. Closing sequences (empty URL) stay. */
export function sanitizeHyperlinks(line: string): string {
  if (!line.includes('\x1b]8;')) return line;
  return line.replace(OSC8, (whole, _params: string, url: string) => (url === '' || safeUrl(url) ? whole : ''));
}

/** A URL in text: up to whitespace or a quote/bracket, without trailing sentence punctuation. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`\x1b]+/g;
/** `path/to/file.ext:12` or `file.ext:12:5`; a path needs a dot-extension and a line. */
const PATH_PATTERN = /(?<![\w/.~-])(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?(?![\w/])/g;

function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0 && /[.,;:!?)\]}]/.test(url[end - 1] as string)) {
    // Keep a closing bracket that has its opening one inside the URL (Wikipedia-style).
    const char = url[end - 1] as string;
    const open = char === ')' ? '(' : char === ']' ? '[' : char === '}' ? '{' : null;
    if (open) {
      const head = url.slice(0, end);
      const count = (c: string) => head.split(c).length - 1;
      if (count(open) >= count(char)) break;
    }
    end--;
  }
  return url.slice(0, end);
}

/** The `file://` URL a `path:line` reference opens: the file (terminals have no common way to name a line). */
export function fileUrlFor(reference: string, cwd: string): string {
  const path = reference.replace(/:\d+(?::\d+)?$/, '');
  const absolute = path.startsWith('~/') ? resolve(process.env.HOME ?? '/', path.slice(2)) : isAbsolute(path) ? path : resolve(cwd, path);
  const url = pathToFileURL(absolute);
  url.hostname = hostname();
  return url.href;
}

/**
 * Link the URLs and `path:line` references in plain text (no escape
 * sequences in it: `displayText` output). Links survive wrapping: pi-tui's
 * wrap and truncation reopen a link on the next row.
 */
export function linkify(text: string, cwd: string): string {
  if (!text.includes(':')) return text;
  const spans: Array<{ start: number; end: number; url: string }> = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (safeUrl(url)) spans.push({ start: match.index, end: match.index + url.length, url });
  }
  for (const match of text.matchAll(PATH_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (spans.some(span => start < span.end && end > span.start)) continue;
    spans.push({ start, end, url: fileUrlFor(match[0], cwd) });
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + hyperlink(text.slice(span.start, span.end), span.url);
    at = span.end;
  }
  return out + text.slice(at);
}

/**
 * Link `path:line` references in a row that is already styled (Markdown):
 * only in its text runs, and not where a link is open already.
 */
export function linkifyStyled(line: string, cwd: string): string {
  if (!line.includes(':')) return line;
  let out = '';
  let inLink = false;
  // Split into escape sequences and the text between them.
  for (const part of line.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\)/)) {
    if (part.startsWith('\x1b')) {
      const link = /^\x1b\]8;[^;]*;([^\x07\x1b]*)/.exec(part);
      if (link) inLink = link[1] !== '';
      out += part;
      continue;
    }
    out += inLink ? part : linkify(part, cwd);
  }
  return out;
}
