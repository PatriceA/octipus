/**
 * Line diff for reviewing the agent's edits.
 *
 * Myers' O((N+M)·D) algorithm over the lines that differ: the common prefix
 * and suffix are taken off first (an agent edit usually touches a few lines
 * of a long file), lines are compared as interned numbers, and the search
 * for the shortest edit stops at a budget. The quadratic LCS table this
 * replaces needed N·M cells and seconds of blocking on a file of a few
 * thousand lines; a budget keeps every diff within a frame or two.
 *
 * When the budget runs out the differing middle is reported as one
 * replacement (`coarse: true`) and the caller says so; the result is still a
 * correct diff, only not the shortest one.
 */
export type LineOpKind = 'keep' | 'add' | 'del';

export interface LineOp {
  op: LineOpKind;
  /** Line index in the BEFORE text (null for an addition). */
  beforeLine: number | null;
  /** Line index in the AFTER text (null for a deletion). */
  afterLine: number | null;
  text: string;
}

export interface LineDiff {
  ops: LineOp[];
  /** True when the budget ran out and the changed middle is one replacement. */
  coarse: boolean;
}

/** Edit-graph steps searched before giving up on the shortest diff. */
export const DIFF_WORK_BUDGET = 4_000_000;
/** The most edits (insertions plus deletions) searched for; traceback memory grows with its square. */
export const DIFF_MAX_EDITS = 2_000;

export function diffLines(before: string, after: string, budget: { work?: number; edits?: number } = {}): LineDiff {
  return diffLineArrays(before.split('\n'), after.split('\n'), budget);
}

export function diffLineArrays(a: readonly string[], b: readonly string[], budget: { work?: number; edits?: number } = {}): LineDiff {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const ops: LineOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: 'keep', beforeLine: i, afterLine: i, text: a[i] });
  const middle = myers(a, b, start, endA, start, endB, budget.work ?? DIFF_WORK_BUDGET, budget.edits ?? DIFF_MAX_EDITS);
  const coarse = middle === null;
  if (middle) ops.push(...middle);
  else {
    for (let i = start; i < endA; i++) ops.push({ op: 'del', beforeLine: i, afterLine: null, text: a[i] });
    for (let j = start; j < endB; j++) ops.push({ op: 'add', beforeLine: null, afterLine: j, text: b[j] });
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ op: 'keep', beforeLine: i, afterLine: j, text: a[i] });
  return { ops, coarse };
}

/**
 * The shortest edit script from a[a0..a1) to b[b0..b1), deletions before
 * insertions within a change; null when the budget runs out.
 */
function myers(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, workBudget: number, maxEdits: number): LineOp[] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 && m === 0) return [];
  // Intern: comparing numbers, not strings, in the inner loop.
  const ids = new Map<string, number>();
  const intern = (line: string) => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id); } return id; };
  const x = Int32Array.from({ length: n }, (_, i) => intern(a[a0 + i]));
  const y = Int32Array.from({ length: m }, (_, j) => intern(b[b0 + j]));

  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds V for k in [-d, d] before step d (2d+1 values).
  const trace: Int32Array[] = [];
  let work = 0;
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    const snapshot = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k++) snapshot[k + d] = v[k + offset];
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) { i++; j++; work++; }
      v[k + offset] = i;
      work++;
      if (i >= n && j >= m) { found = d; break outer; }
    }
    if (work > workBudget) return null;
  }
  if (found < 0) return null;

  // Walk back from (n, m) through the snapshots.
  const reversed: LineOp[] = [];
  let i = n;
  let j = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const get = (k: number) => (k < -(d - 1) || k > d - 1 ? -1 : prev[k + d]);
    const k = i - j;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevI = get(prevK);
    const prevJ = prevI - prevK;
    const startI = down ? prevI : prevI + 1;
    const startJ = down ? prevJ + 1 : prevJ;
    while (i > startI && j > startJ) { i--; j--; reversed.push({ op: 'keep', beforeLine: a0 + i, afterLine: b0 + j, text: a[a0 + i] }); }
    if (down) { j--; reversed.push({ op: 'add', beforeLine: null, afterLine: b0 + j, text: b[b0 + j] }); }
    else { i--; reversed.push({ op: 'del', beforeLine: a0 + i, afterLine: null, text: a[a0 + i] }); }
  }
  while (i > 0 && j > 0) { i--; j--; reversed.push({ op: 'keep', beforeLine: a0 + i, afterLine: b0 + j, text: a[a0 + i] }); }
  return orderChanges(reversed.reverse());
}

/** Within each run of changes, deletions first: `- old` above `+ new`, as a reader expects. */
function orderChanges(ops: LineOp[]): LineOp[] {
  const out: LineOp[] = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i].op === 'keep') { out.push(ops[i]); i++; continue; }
    const dels: LineOp[] = [];
    const adds: LineOp[] = [];
    while (i < ops.length && ops[i].op !== 'keep') { (ops[i].op === 'del' ? dels : adds).push(ops[i]); i++; }
    out.push(...dels, ...adds);
  }
  return out;
}

/** Aggregate stats for the overlay header. */
export function diffStats(ops: readonly LineOp[]): { adds: number; dels: number } {
  let adds = 0; let dels = 0;
  for (const h of ops) {
    if (h.op === 'add') adds++;
    else if (h.op === 'del') dels++;
  }
  return { adds, dels };
}
