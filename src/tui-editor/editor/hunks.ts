/**
 * Hunks of a line diff, what accepting some of them gives, and what changed
 * inside a changed line.
 *
 * A hunk is one run of consecutive deleted and added lines. Two runs with
 * even one unchanged line between them are two hunks, so they can be
 * decided apart; lines changed side by side are one hunk (there is no way to
 * keep half of a replacement without inventing text neither side had).
 *
 * `applyHunks` rebuilds the text from the diff: unchanged lines, then for
 * each hunk the agent's lines if it was accepted and the original lines if
 * not. Lines are joined with `\n`; the buffer holds no `\r` (line endings
 * are the file bridge's business), so a CRLF file comes out CRLF on save.
 */
import { diffLineArrays, type LineOp } from './diff';

export interface Hunk {
  index: number;
  /** The hunk's ops: `ops.slice(start, end)`. */
  start: number;
  end: number;
  /** Where the hunk sits in the before and after text (0-based lines). */
  beforeLine: number;
  afterLine: number;
  removed: string[];
  added: string[];
}

export function buildHunks(ops: readonly LineOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (let i = 0; i < ops.length;) {
    const op = ops[i];
    if (op.op === 'keep') { beforeLine++; afterLine++; i++; continue; }
    const hunk: Hunk = { index: hunks.length, start: i, end: i, beforeLine, afterLine, removed: [], added: [] };
    while (i < ops.length && ops[i].op !== 'keep') {
      if (ops[i].op === 'del') { hunk.removed.push(ops[i].text); beforeLine++; } else { hunk.added.push(ops[i].text); afterLine++; }
      i++;
    }
    hunk.end = i;
    hunks.push(hunk);
  }
  return hunks;
}

/** The text with accepted hunks taken from the agent and the others kept as they were. */
export function applyHunks(ops: readonly LineOp[], hunks: readonly Hunk[], accepted: (hunk: Hunk) => boolean): string {
  const out: string[] = [];
  let h = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'keep') { out.push(op.text); continue; }
    while (h < hunks.length && hunks[h].end <= i) h++;
    const take = accepted(hunks[h]);
    if ((op.op === 'add') === take) out.push(op.text);
  }
  return out.join('\n');
}

/** A changed span of a line, in UTF-16 columns: [start, end). */
export interface Span { start: number; end: number }

/** Words, runs of spaces, and single other characters: what an intra-line diff compares. */
const TOKENS = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/**
 * What changed between an old line and its replacement, as spans of each.
 * Null when the lines have too little in common for the spans to help (the
 * whole line is already shown as changed).
 */
export function intraLineChanges(before: string, after: string): { removed: Span[]; added: Span[] } | null {
  if (before === after) return { removed: [], added: [] };
  const a = before.match(TOKENS) ?? [];
  const b = after.match(TOKENS) ?? [];
  const { ops, coarse } = diffLineArrays(a, b, { work: 20_000, edits: 200 });
  if (coarse) return null;
  const removed: Span[] = [];
  const added: Span[] = [];
  let colA = 0;
  let colB = 0;
  let same = 0;
  const push = (spans: Span[], start: number, end: number) => {
    const last = spans.at(-1);
    if (last && last.end === start) last.end = end; else spans.push({ start, end });
  };
  for (const op of ops) {
    const len = op.text.length;
    if (op.op === 'keep') { colA += len; colB += len; if (op.text.trim()) same += len; continue; }
    if (op.op === 'del') { push(removed, colA, colA + len); colA += len; } else { push(added, colB, colB + len); colB += len; }
  }
  // Less than a third in common (spaces aside): highlighting pieces would only be noise.
  if (same * 3 < Math.max(before.trim().length, after.trim().length)) return null;
  return { removed, added };
}
