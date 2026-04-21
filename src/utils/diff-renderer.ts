/**
 * Tiny unified-diff renderer. Self-contained — no npm dep.
 *
 * Uses Myers' O(ND) difference algorithm on lines. Good enough for
 * file-sized inputs. Outputs standard unified-diff format with optional
 * ANSI color for terminals.
 */

import { readFile } from 'fs/promises';

const CSI = '\u001b[';
const RED = `${CSI}31m`;
const GREEN = `${CSI}32m`;
const CYAN = `${CSI}36m`;
const BOLD = `${CSI}1m`;
const RESET = `${CSI}0m`;

export interface DiffOptions {
  filename?: string;
  context?: number;
  color?: 'auto' | 'always' | 'never';
}

type Op = 'eq' | 'add' | 'del';
interface DiffLine { op: Op; text: string }

/**
 * Myers O(ND) diff at the line granularity.
 * Returns a script of `{op, text}` entries preserving input order.
 */
function myersDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const v: Record<number, number> = { 1: 0 };
  const trace: Array<Record<number, number>> = [];
  for (let d = 0; d <= max; d++) {
    trace.push({ ...v });
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[k - 1] ?? -1) < (v[k + 1] ?? -1))) {
        x = v[k + 1] ?? 0;
      } else {
        x = (v[k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k] = x;
      if (x >= n && y >= m) {
        return backtrack(a, b, trace);
      }
    }
  }
  return backtrack(a, b, trace);
}

function backtrack(a: string[], b: string[], trace: Array<Record<number, number>>): DiffLine[] {
  let x = a.length, y = b.length;
  const ops: DiffLine[] = [];
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v[k - 1] ?? -1) < (v[k + 1] ?? -1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: 'eq', text: a[x - 1]! });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ op: 'add', text: b[y - 1]! });
        y--;
      } else {
        ops.push({ op: 'del', text: a[x - 1]! });
        x--;
      }
    }
  }
  while (x > 0 && y > 0) { ops.push({ op: 'eq', text: a[x - 1]! }); x--; y--; }
  return ops.reverse();
}

interface Hunk {
  aStart: number; aLen: number;
  bStart: number; bLen: number;
  lines: DiffLine[];
}

function buildHunks(script: DiffLine[], contextLines: number): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let aIdx = 0, bIdx = 0;
  let pendingContext: DiffLine[] = [];

  const flushCurrent = () => { if (current) { hunks.push(current); current = null; } };

  for (let i = 0; i < script.length; i++) {
    const line = script[i]!;
    if (line.op === 'eq') {
      if (current) {
        if (current.lines.filter(l => l.op === 'eq').length < contextLines) {
          current.lines.push(line);
          current.aLen++; current.bLen++;
        } else {
          // look ahead — do we have another change within contextLines?
          let nextChange = -1;
          for (let j = i; j < Math.min(i + contextLines * 2 + 1, script.length); j++) {
            if (script[j]!.op !== 'eq') { nextChange = j; break; }
          }
          if (nextChange !== -1 && nextChange - i <= contextLines) {
            current.lines.push(line);
            current.aLen++; current.bLen++;
          } else {
            flushCurrent();
            pendingContext = [line];
          }
        }
      } else {
        pendingContext.push(line);
        if (pendingContext.length > contextLines) pendingContext.shift();
      }
      aIdx++; bIdx++;
    } else {
      if (!current) {
        const startA = aIdx - pendingContext.length;
        const startB = bIdx - pendingContext.length;
        current = { aStart: startA, aLen: pendingContext.length, bStart: startB, bLen: pendingContext.length, lines: [...pendingContext] };
        pendingContext = [];
      }
      current.lines.push(line);
      if (line.op === 'del') { current.aLen++; aIdx++; }
      else { current.bLen++; bIdx++; }
    }
  }
  flushCurrent();
  return hunks;
}

function shouldColor(opt: DiffOptions['color']): boolean {
  if (opt === 'always') return true;
  if (opt === 'never') return false;
  return !!process.stdout.isTTY;
}

export function renderUnifiedDiff(before: string, after: string, opts: DiffOptions = {}): string {
  const { filename, context = 3, color = 'auto' } = opts;
  if (before === after) return '';

  const a = before.split('\n');
  const b = after.split('\n');
  // Drop the synthetic trailing empty entry produced when input ends in \n
  const trimmed = (arr: string[]) => (arr.length > 0 && arr[arr.length - 1] === '' ? arr.slice(0, -1) : arr);
  const aArr = trimmed(a);
  const bArr = trimmed(b);

  const script = myersDiff(aArr, bArr);
  const hunks = buildHunks(script, context);
  const useColor = shouldColor(color);

  const c = (code: string, s: string) => useColor ? `${code}${s}${RESET}` : s;
  const out: string[] = [];

  if (filename) {
    out.push(c(BOLD, `--- a/${filename}`));
    out.push(c(BOLD, `+++ b/${filename}`));
  }

  for (const h of hunks) {
    out.push(c(CYAN, `@@ -${h.aStart + 1},${h.aLen} +${h.bStart + 1},${h.bLen} @@`));
    for (const line of h.lines) {
      if (line.op === 'eq') out.push(` ${line.text}`);
      else if (line.op === 'del') out.push(c(RED, `-${line.text}`));
      else out.push(c(GREEN, `+${line.text}`));
    }
  }

  return out.join('\n');
}

export async function renderSnapshotDiff(path: string, priorSnapshot: string, opts?: DiffOptions): Promise<string> {
  const current = await readFile(path, 'utf-8');
  return renderUnifiedDiff(priorSnapshot, current, { filename: path, ...opts });
}
