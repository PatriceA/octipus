/**
 * Text on its way to being spoken — the one shaper every voice surface uses
 * (the web conversation, the mobile app through the server, channel voice
 * replies, phone calls, the TUI, the `speak` tool), so a reply sounds the
 * same wherever it is heard.
 *
 * Shared by the server and the web: no runtime imports beyond the inline-UI
 * fence parser (see work-stream.ts).
 */
import { inlineUiSpeechText } from './inline-ui/fence';

/**
 * What a spoken reply should be like. Appended to the system prompt of a turn
 * whose answer is read aloud, and the base of the phone prompt.
 */
export const SPOKEN_REPLY_DIRECTIVE =
  'This reply is SPOKEN aloud to the person, not read. Answer the way you would say it to someone in the room: ' +
  'start with the answer, in short natural sentences, usually one to three. ' +
  'No markdown, headings, bullet lists, tables, code blocks, links or emoji, and do not read out URLs, file paths or long identifiers; ' +
  'say what they are instead. Write numbers, dates and units the way they are spoken. ' +
  'When the full answer is long or is something to look at (code, a table, a document), say the gist in a sentence or two ' +
  'and offer the rest in writing. Keep the language the person is speaking.';

/** A sources or citations footer, in the forms the root agent and models write it. */
const SOURCES_FOOTER = /(?:^|\n)[ \t]*[#>*_\-]*[ \t]*(?:sources?|quellen?)(?:[ \t]*[*_]*[ \t]*:[\s\S]*|[ \t]*[*_]*[ \t]*\r?\n[\s\S]*)$/i;
const SOURCES_INLINE = /([.!?])[ \t]+[*_]*(?:sources?|quellen?)[*_]*[ \t]*:[^\r\n]*/gi;

/** Remove citation and provenance sections: nobody wants a list of sources read out. */
export function stripSpeechSources(text: string): string {
  return text.replace(SOURCES_FOOTER, '').replace(SOURCES_INLINE, '$1').trim();
}

/**
 * Make a reply speakable: interactive blocks, sources, code, markup, links
 * and emoji go; the prose stays.
 */
export function forSpeech(text: string): string {
  const prose = stripSpeechSources(inlineUiSpeechText(text))
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, ' ') // code blocks are not read aloud (an unclosed one runs to the end)
    .replace(/`([^`]+)`/g, '$1') // inline code → its text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → their label
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their label
    .replace(/<https?:\/\/[^>\s]+>/g, ' ')
    .replace(/https?:\/\/(?:www\.)?([^\s/)]+)[^\s)]*/g, '$1') // a bare URL → its host
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, ''); // emoji
  return prose
    .split('\n')
    .map((line) => {
      if (/^[ \t|:-]*-{3,}[ \t|:-]*$/.test(line)) return ''; // a table rule or a divider
      const heading = /^[ \t]*#{1,6}[ \t]+\S/.test(line);
      const item = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/.test(line);
      const said = line
        .replace(/^[ \t]*(?:#{1,6}|>+|[-*+](?=\s))[ \t]*/, '') // heading, quote and bullet markers
        .replace(/[*_~|]/g, ' ') // emphasis, table pipes
        .trim();
      // A heading or a list item is its own breath: without punctuation it would run into the next line.
      return said && (heading || item) && !/[.!?:,;…]$/.test(said) ? `${said}${heading ? '.' : ','}` : said;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/[ \t]+([.,!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/,$/, '')
    .trim();
}

export interface SentenceChunkerOptions {
  /** A first piece this long is spoken at once, so the reply starts sooner. */
  firstMinChars?: number;
  /** Later pieces are at least this long: very short sentences ride with the next. */
  minChars?: number;
  /** A run with no sentence end is cut at a clause or a space past this length. */
  maxChars?: number;
}

/**
 * Cuts a reply into speakable pieces while it is still being written: text
 * goes in as it streams, whole sentences come out as soon as they are
 * complete, already shaped by `forSpeech`. Code blocks are skipped whole, and
 * everything after a sources footer is dropped.
 */
export class SentenceChunker {
  private buffer = '';
  private fence: string | null = null;
  private line = '';
  private done = false;
  private emitted = 0;
  private readonly firstMin: number;
  private readonly min: number;
  private readonly max: number;

  constructor(options: SentenceChunkerOptions = {}) {
    this.firstMin = options.firstMinChars ?? 8;
    this.min = options.minChars ?? 24;
    this.max = options.maxChars ?? 320;
  }

  /** Add streamed text; returns the pieces that are now complete. */
  push(delta: string): string[] {
    if (this.done) return [];
    for (const char of delta) {
      this.line += char;
      if (char !== '\n') continue;
      this.takeLine(this.line);
      this.line = '';
      if (this.done) return this.drain(true);
    }
    return this.drain(false, this.fence ? '' : this.line);
  }

  /** The reply is complete: returns what is left. */
  flush(): string[] {
    if (this.done) return [];
    if (this.line) { this.takeLine(this.line); this.line = ''; }
    this.done = true;
    return this.drain(true);
  }

  /** A whole line has arrived: prose joins the buffer; fences and a sources footer do not. */
  private takeLine(line: string): void {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (this.fence) {
      if (fence && fence[1][0] === this.fence[0] && fence[1].length >= this.fence.length && !line.trim().slice(fence[1].length).trim()) this.fence = null;
      return;
    }
    if (fence) { this.fence = fence[1]; return; }
    if (/^[ \t]*[#>*_\-]*[ \t]*(?:sources?|quellen?)[ \t]*[*_]*[ \t]*(?::|$)/i.test(line.trimEnd())) { this.done = true; return; }
    this.buffer += line;
  }

  /**
   * Cut complete sentences off the buffer. `pending` is the unfinished
   * current line: its complete sentences may go out too, without waiting for
   * the line to end (a paragraph can be long).
   */
  private drain(all: boolean, pending = ''): string[] {
    const out: string[] = [];
    let text = this.buffer + pending;
    let consumedPending = 0;
    for (;;) {
      const min = this.emitted === 0 ? this.firstMin : this.min;
      const cut = all ? text.length : cutPoint(text, min, this.max, pending.length === 0);
      if (cut <= 0) break;
      const piece = forSpeech(text.slice(0, cut));
      const taken = Math.max(0, cut - this.buffer.length);
      this.buffer = this.buffer.slice(cut);
      if (taken) { this.line = this.line.slice(taken); consumedPending += taken; }
      text = text.slice(cut);
      if (piece) { out.push(piece); this.emitted += 1; }
      if (all) break;
    }
    void consumedPending;
    return out;
  }
}

/**
 * Where the first complete piece of `text` ends, or 0 when there is none yet:
 * a sentence end (`.`, `!`, `?`, `…`, `:` before a line break) followed by
 * white space, or a line break, once the piece is at least `min` long; else
 * a clause or word boundary past `max`.
 */
function cutPoint(text: string, min: number, max: number, lineComplete: boolean): number {
  const end = /([.!?…]+["')\]]*)(\s+)|(\n+)/g;
  let match: RegExpExecArray | null;
  while ((match = end.exec(text))) {
    const at = match.index + match[0].length;
    // The white space must be followed by something, or be a line break: "3." at the very end may be "3.5".
    if (at >= text.length && !match[0].includes('\n') && !lineComplete) break;
    // Not a sentence end: a number ("3. item", "v1. 2"), an initial or a short abbreviation ("e.g. this", "Dr. Who").
    if (match[1] && /(?:^|[\s(])(?:\d+|[A-Za-z]|[A-Za-z]\.[A-Za-z]|Dr|Mr|Mrs|Ms|Prof|St|vs|etc|bzw|ca|Nr|z\.B|d\.h)\.$/.test(text.slice(0, match.index + match[1].length)) && !match[0].includes('\n')) continue;
    if (forSpeech(text.slice(0, at)).length >= min) return at;
  }
  if (text.length > max) {
    const window = text.slice(0, max);
    const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' – '), window.lastIndexOf(' — '));
    if (clause > max / 2) return clause + 2;
    const space = window.lastIndexOf(' ');
    return space > 0 ? space + 1 : max;
  }
  return 0;
}
