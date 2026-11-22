/**
 * Three-way review of an agent edit: what the agent changed, applied to
 * what the user has.
 *
 *   base   — the file as the buffer last read or saved it (`savedText`)
 *   ours   — the buffer now, unsaved edits included
 *   theirs — the agent's text, written against the file on disk (base)
 *
 * A two-way diff of the buffer against the agent's text shows the user's own
 * unsaved edits as hunks too (the agent's file does not have them), so
 * accepting everything reverted them. Here only the agent's changes
 * (base → theirs) become hunks, placed in the buffer's lines: the result of
 * accepting one is the buffer with that change made, the user's edits kept.
 *
 * An agent change that overlaps or touches lines the user changed is a
 * conflict: one block covering both, shown as the buffer's lines replaced by
 * the agent's, and flagged so the review rejects it unless the user accepts
 * it. Where the user and the agent made the same change there is nothing to
 * review.
 *
 * The result has the shape `DiffOverlay` and `applyHunks` work on: ops over
 * the buffer's lines (keep / del / add) and the hunks over them.
 */
import { diffLines, type LineOp } from './diff';
import { buildHunks, type Hunk } from './hunks';

export interface ReviewDiff {
  ops: LineOp[];
  hunks: Hunk[];
  /** Per hunk: it overlaps the user's unsaved edits. */
  conflicts: boolean[];
  /** A diff was too large to compare line by line (its changes are one block). */
  coarse: boolean;
}

/** A changed range of base lines, [start, end). */
interface Range { start: number; end: number; agent: boolean }

export function reviewDiff(base: string, ours: string, theirs: string): ReviewDiff {
  const agent = diffLines(base, theirs);
  const user = diffLines(base, ours);
  const ranges: Range[] = [
    ...buildHunks(agent.ops).map((h) => ({ start: h.beforeLine, end: h.beforeLine + h.removed.length, agent: true })),
    ...buildHunks(user.ops).map((h) => ({ start: h.beforeLine, end: h.beforeLine + h.removed.length, agent: false })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  // Blocks: ranges that overlap or touch, joined. Touching counts, so two blocks always have an unchanged line between them.
  const blocks: Array<{ start: number; end: number; agent: boolean; user: boolean }> = [];
  for (const r of ranges) {
    const last = blocks.at(-1);
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      if (r.agent) last.agent = true; else last.user = true;
    } else {
      blocks.push({ start: r.start, end: r.end, agent: r.agent, user: !r.agent });
    }
  }

  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');
  const ops: LineOp[] = [];
  const conflicts: boolean[] = [];
  let o = 0;
  for (const block of blocks) {
    if (!block.agent) continue;
    const os = startIn(user.ops, block.start);
    const oe = endIn(user.ops, block.end);
    const ts = startIn(agent.ops, block.start);
    const te = endIn(agent.ops, block.end);
    const mine = oursLines.slice(os, oe);
    const agents = theirsLines.slice(ts, te);
    if (mine.length === agents.length && mine.every((line, i) => line === agents[i])) continue;
    for (; o < os; o++) ops.push({ op: 'keep', beforeLine: o, afterLine: null, text: oursLines[o] });
    for (; o < oe; o++) ops.push({ op: 'del', beforeLine: o, afterLine: null, text: oursLines[o] });
    for (const line of agents) ops.push({ op: 'add', beforeLine: null, afterLine: null, text: line });
    conflicts.push(block.user);
  }
  for (; o < oursLines.length; o++) ops.push({ op: 'keep', beforeLine: o, afterLine: null, text: oursLines[o] });
  // Line numbers in the text with every hunk accepted.
  let after = 0;
  for (const op of ops) if (op.op !== 'del') op.afterLine = after++;
  const hunks = buildHunks(ops);
  return { ops, hunks, conflicts, coarse: agent.coarse || user.coarse };
}

/** Where base line `line` starts in the other text of `ops` (lines inserted at it included after). */
function startIn(ops: readonly LineOp[], line: number): number {
  let base = 0;
  let other = 0;
  for (const op of ops) {
    if (base >= line) return other;
    if (op.op !== 'add') base++;
    if (op.op !== 'del') other++;
  }
  return other;
}

/** Where base line `line` starts in the other text of `ops`, after the lines inserted before it. */
function endIn(ops: readonly LineOp[], line: number): number {
  let base = 0;
  let other = 0;
  for (const op of ops) {
    if (op.op !== 'add' && base >= line) return other;
    if (op.op !== 'add') base++;
    if (op.op !== 'del') other++;
  }
  return other;
}
