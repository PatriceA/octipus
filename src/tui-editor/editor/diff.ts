/**
 * Minimal line-level diff for the agent-edit overlay.
 *
 * Implements an LCS-based diff that returns a flat list of hunks
 * — `keep` / `add` / `del` operations on whole lines. Sufficient
 * for the in-buffer diff overlay; for inline character-level
 * granularity a future iteration can layer a word-diff on top.
 */
export type HunkOp = 'keep' | 'add' | 'del';

export interface Hunk {
  op: HunkOp;
  /** Line index in the BEFORE buffer (or null for pure additions). */
  beforeLine: number | null;
  /** Line index in the AFTER buffer (or null for pure deletions). */
  afterLine: number | null;
  text: string;
}

export function diffLines(before: string, after: string): Hunk[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;

  // LCS length matrix.
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: Hunk[] = [];
  let i = 0; let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: 'keep', beforeLine: i, afterLine: j, text: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: 'del', beforeLine: i, afterLine: null, text: a[i] });
      i++;
    } else {
      out.push({ op: 'add', beforeLine: null, afterLine: j, text: b[j] });
      j++;
    }
  }
  while (i < m) { out.push({ op: 'del', beforeLine: i, afterLine: null, text: a[i] }); i++; }
  while (j < n) { out.push({ op: 'add', beforeLine: null, afterLine: j, text: b[j] }); j++; }
  return out;
}

/** Aggregate stats for the overlay header. */
export function diffStats(hunks: readonly Hunk[]): { adds: number; dels: number } {
  let adds = 0; let dels = 0;
  for (const h of hunks) {
    if (h.op === 'add') adds++;
    else if (h.op === 'del') dels++;
  }
  return { adds, dels };
}
