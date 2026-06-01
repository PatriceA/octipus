/**
 * Dependency-free line diff for the work stream + in-chat file view —
 * `.octipus/end-user-ux-design.md` Threads 1 & 2.
 *
 * Produces a unified-style patch (lines prefixed with `+`/`-`/` `) plus
 * added/removed counts so:
 *   - the server work-stream renderer can title an edit "Edited app.ts (+12 −3)"
 *     and ship a `{ kind: 'diff', patch }` preview, and
 *   - the web FileViewer / message timeline can render colored before/after.
 *
 * Runtime-import-free (no node built-ins) so the browser bundle imports it
 * directly, the same constraint as `src/shared/work-stream.ts`.
 *
 * Algorithm: trim the common prefix/suffix (cheap, and the whole story for a
 * typical few-line edit), then run an LCS diff on the differing middle. The
 * O(n·m) LCS is guarded by a product budget; past it we fall back to a coarse
 * "all removed then all added" so a huge rewrite can't pin a core.
 */

export interface LineDiff {
  /** Unified-style patch: each line starts with `+`, `-`, or a space. */
  patch: string;
  /** Number of added (`+`) lines. */
  added: number;
  /** Number of removed (`-`) lines. */
  removed: number;
  /** True if the patch was capped (more changes than `maxPatchLines`). */
  truncated: boolean;
}

interface DiffOptions {
  /** Context lines kept around the changed region. Default 3. */
  context?: number;
  /** Cap on emitted patch lines before truncating. Default 200. */
  maxPatchLines?: number;
  /** Skip the O(n·m) LCS when `midA.length * midB.length` exceeds this. Default 1e6. */
  lcsProductBudget?: number;
}

type Op = { t: '+' | '-' | ' '; line: string };

/** Minimal LCS-based diff of two line arrays. */
function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: '-', line: a[i] });
      i++;
    } else {
      out.push({ t: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: '-', line: a[i++] });
  while (j < m) out.push({ t: '+', line: b[j++] });
  return out;
}

/**
 * Compute a line diff of `before` → `after`. Always reconstructs (the patch is
 * never lossy in its counts even when the line text is truncated).
 */
export function computeLineDiff(before: string, after: string, opts: DiffOptions = {}): LineDiff {
  const context = opts.context ?? 3;
  const maxPatchLines = opts.maxPatchLines ?? 200;
  const lcsProductBudget = opts.lcsProductBudget ?? 1_000_000;

  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];

  // Trim common prefix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // Trim common suffix (not crossing the prefix).
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const ops: Op[] =
    midA.length * midB.length > lcsProductBudget
      ? [...midA.map((line): Op => ({ t: '-', line })), ...midB.map((line): Op => ({ t: '+', line }))]
      : lcsDiff(midA, midB);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === '+') added++;
    else if (op.t === '-') removed++;
  }

  // Surround with up to `context` unchanged lines for readability.
  const prefixCtx: Op[] = a.slice(Math.max(start - context, 0), start).map((line) => ({ t: ' ', line }));
  const suffixCtx: Op[] = a.slice(endA, Math.min(endA + context, a.length)).map((line) => ({ t: ' ', line }));
  let all: Op[] = [...prefixCtx, ...ops, ...suffixCtx];

  let truncated = false;
  if (all.length > maxPatchLines) {
    all = all.slice(0, maxPatchLines);
    truncated = true;
  }

  const patch = all.map((op) => `${op.t}${op.line}`).join('\n') + (truncated ? '\n… (diff truncated)' : '');
  return { patch, added, removed, truncated };
}
