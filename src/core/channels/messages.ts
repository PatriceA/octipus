/**
 * One shape for a message read back out of a chat platform.
 *
 * The channel layer normalises messages *inbound* (the Unified Message
 * Interface) but nothing ever read them back, so "what did the team decide
 * yesterday" was unanswerable. These types are the read-side equivalent: what
 * Slack and Microsoft Teams have in common, flattened enough that a model can
 * quote it.
 */

export interface ChannelMessage {
  /** Platform message id — a Slack `ts`, a Graph message id. */
  id: string;
  /** Conversation the message is in. */
  conversationId: string;
  conversationName?: string;
  /** Display name where the platform gave one, otherwise the raw id. */
  author: string;
  authorId?: string;
  text: string;
  /** ISO-8601, always UTC. */
  at: string;
  /** Set on a reply; the id of the message it replies to. */
  threadId?: string;
  /** Number of replies, when the platform reports it on the parent. */
  replyCount?: number;
  permalink?: string;
}

export interface ChannelHistoryResult {
  channel: 'slack' | 'teams';
  conversationId: string;
  conversationName?: string;
  messages: ChannelMessage[];
  /** True when more messages exist before the oldest one returned. */
  hasMore: boolean;
}

/** Slack timestamps are `seconds.microseconds` strings. */
export function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return new Date(0).toISOString();
  return new Date(seconds * 1000).toISOString();
}

/** The inverse, for `oldest` / `latest` bounds. */
export function isoToSlackTs(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return (ms / 1000).toFixed(6);
}

/**
 * Make Slack's wire format readable.
 *
 * Slack sends mentions as `<@U123>`, channels as `<#C123|name>` and links as
 * `<url|label>`, and HTML-escapes `&`, `<` and `>`. Left as-is, a quoted
 * decision reads as line noise and the model cannot tell who was mentioned.
 */
export function cleanSlackText(text: string, users?: Map<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_all, id: string, label?: string) =>
      `@${label || users?.get(id) || id}`)
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_all, _id: string, name: string) => `#${name}`)
    .replace(/<#([A-Z0-9]+)>/g, (_all, id: string) => `#${id}`)
    .replace(/<!(here|channel|everyone)>/g, (_all, w: string) => `@${w}`)
    .replace(/<([^|>]+)\|([^>]*)>/g, (_all, url: string, label: string) => `${label} (${url})`)
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_all, url: string) => url)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Elements whose *content* is code, not message text, and goes with the tag. */
const DROP_CONTENT = new Set(['script', 'style']);

/** Tags that end a line, and how much whitespace they are worth. */
const BREAK_AFTER: Record<string, string> = {
  p: '\n\n',
  div: '\n',
  li: '\n',
  tr: '\n',
  h1: '\n',
  h2: '\n',
  h3: '\n',
  h4: '\n',
  h5: '\n',
  h6: '\n',
};

interface ScannedTag {
  name: string;
  closing: boolean;
  /** Index just past the tag's `>`. */
  end: number;
}

/**
 * Read one tag starting at `<`, or null when this is a bare `<` in text.
 *
 * The quoted-attribute handling is the point: `<div title="a>b">` contains a
 * `>` that does not end the tag, and a scan that stops at the first one leaves
 * `b">` behind as if it were message text.
 */
function scanTag(html: string, start: number): ScannedTag | null {
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;

  const nameStart = i;
  while (i < html.length && /[a-zA-Z0-9]/.test(html[i])) i++;
  if (i === nameStart) return null; // `<` followed by something that is not a tag name
  const name = html.slice(nameStart, i).toLowerCase();

  let quote: string | null = null;
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { name, closing, end: i + 1 };
    }
    i++;
  }
  // Unterminated tag: treat the rest of the input as markup rather than
  // emitting a half-parsed fragment as if the sender had typed it.
  return { name, closing, end: html.length };
}

/**
 * Strip the HTML Teams sends so a message body reads as text.
 *
 * Scanned rather than regex-replaced. A `<[^>]+>` filter is wrong on three
 * inputs a chat platform really produces — an attribute containing `>`, a
 * comment (whose body and closing `-->` survive), and a `<script>` block
 * (whose source becomes message text) — and quoting a mangled or injected
 * fragment back to a model as "what was said in the channel" is exactly the
 * failure this function exists to prevent.
 */
export function cleanHtml(html: string): string {
  let out = '';
  let i = 0;

  while (i < html.length) {
    if (html[i] !== '<') {
      out += html[i];
      i++;
      continue;
    }

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    // Doctype and processing instructions: `<!doctype …>`, `<?xml …?>`.
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = scanTag(html, i);
    if (!tag) {
      // A bare `<` the sender typed. Keep it — it is their text.
      out += '<';
      i++;
      continue;
    }
    i = tag.end;

    if (!tag.closing && DROP_CONTENT.has(tag.name)) {
      const close = html.toLowerCase().indexOf(`</${tag.name}`, i);
      if (close === -1) {
        i = html.length;
      } else {
        const closeTag = scanTag(html, close);
        i = closeTag ? closeTag.end : html.length;
      }
      continue;
    }

    if (tag.name === 'br') out += '\n';
    else if (tag.closing) out += BREAK_AFTER[tag.name] ?? '';
  }

  return out
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Whether a message satisfies a scan query: every whitespace-separated term
 * appears somewhere in the text or the author's name, case-insensitively.
 *
 * A quoted phrase is matched whole, so `"ship date"` finds the phrase rather
 * than every message containing either word.
 */
export function matchesQuery(message: ChannelMessage, query: string): boolean {
  const haystack = `${message.text}\n${message.author}`.toLowerCase();
  const terms = (query.toLowerCase().match(/"[^"]+"|\S+/g) ?? [])
    .map((term) => term.replace(/^"|"$/g, ''))
    .filter((term) => term.length > 0);
  if (terms.length === 0) return false;
  return terms.every((term) => haystack.includes(term));
}

/** Newest first, which is the order both platforms and every reader expect. */
export function sortNewestFirst(messages: ChannelMessage[]): ChannelMessage[] {
  return [...messages].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Trim a transcript to fit a model's context.
 *
 * Drops whole messages from the oldest end rather than truncating text: half a
 * sentence attributed to a named person is worse than a shorter transcript.
 */
export function capMessages(messages: ChannelMessage[], maxChars: number): ChannelMessage[] {
  let total = 0;
  const kept: ChannelMessage[] = [];
  for (const message of messages) {
    total += message.text.length + message.author.length + 32;
    if (total > maxChars && kept.length > 0) break;
    kept.push(message);
  }
  return kept;
}
