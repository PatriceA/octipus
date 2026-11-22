/**
 * The streaming reply's display text, sanitised as it grows.
 *
 * `displayText` over the whole reply on every delta made streaming
 * quadratic: 154 KB in 2,000 deltas cost seconds of CPU. Its replacements are
 * local, so the text splits at a *settled* point — one where sanitising the
 * two halves apart gives what sanitising them together does — and only what
 * follows it is sanitised again. A settled point is after a newline, or
 * between two printable ASCII characters, and never inside an escape
 * sequence that is still open (an OSC or a DCS runs until its terminator,
 * which a later delta may bring; an ESC at the very end may start a CSI).
 */
import { displayText } from '@/tui-kit';

/** The sanitised text of `raw.slice(0, cut)`, kept between deltas. */
export interface SettledText { readonly raw: string; readonly cut: number; readonly text: string }

export interface StreamingText {
  /** `displayText(raw)`, exactly. */
  text: string;
  settled: SettledText;
  /** Characters sanitised this time (the structural cost; tests bound it). */
  work: number;
}

const plainAscii = (code: number) => code >= 0x20 && code < 0x7f;

/** Whether the last escape sequence in `segment` could still grow with text appended after it. */
function escapeOpen(segment: string): boolean {
  const at = segment.lastIndexOf('\x1b');
  if (at < 0) return false;
  const rest = segment.slice(at);
  if (rest.length === 1) return true;
  const kind = rest[1] as string;
  if (kind === '\\') return false; // a string terminator, or the two-byte ESC \ — complete either way
  if (kind === '[') return !/^\x1b\[[0-?]*[ -/]*[@-~]/.test(rest);
  if (kind === ']') return !rest.includes('\x07');
  if (kind === 'P' || kind === 'X' || kind === '^' || kind === '_') return true; // ends only with ESC \
  return !/^\x1b[ -/]*[0-~]/.test(rest);
}

/** The last settled point of `raw` after `from`, or `from` when there is none. */
function settledPoint(raw: string, from: number): number {
  for (let at = raw.length - 1; at > from; at--) {
    const before = raw.charCodeAt(at - 1);
    const safe = before === 0x0a || (plainAscii(before) && plainAscii(raw.charCodeAt(at)));
    if (!safe) continue;
    const segment = raw.slice(from, at);
    if (!escapeOpen(segment)) return at;
    // Inside an open sequence: only a point before it can be settled.
    at = from + segment.lastIndexOf('\x1b') + 1;
  }
  return from;
}

/**
 * `displayText(raw)`, reusing what `previous` settled when `raw` still starts
 * with it (a reply that only grew). Anything else is sanitised from scratch.
 */
export function sanitizeStreaming(previous: SettledText | null, raw: string): StreamingText {
  const reuse = previous !== null && previous.cut <= raw.length && raw.startsWith(previous.raw);
  const from = reuse ? previous.cut : 0;
  const head = reuse ? previous.text : '';
  const cut = settledPoint(raw, from);
  const middle = displayText(raw.slice(from, cut));
  const tail = displayText(raw.slice(cut));
  return { text: head + middle + tail, settled: { raw: raw.slice(0, cut), cut, text: head + middle }, work: raw.length - from };
}
