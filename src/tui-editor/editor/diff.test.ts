import { describe, expect, test } from 'vitest';
import { diffLines, diffStats, type LineOp } from './diff';

/** Rebuild both sides from the ops: a diff is correct when it gives back what it compared. */
function sides(ops: readonly LineOp[]): { before: string; after: string } {
  return {
    before: ops.filter((o) => o.op !== 'add').map((o) => o.text).join('\n'),
    after: ops.filter((o) => o.op !== 'del').map((o) => o.text).join('\n'),
  };
}

function lcsLength(a: string[], b: string[]): number {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[b.length];
}

describe('diffLines', () => {
  test('identical inputs produce all keeps', () => {
    const { ops } = diffLines('a\nb\nc', 'a\nb\nc');
    expect(ops.every((x) => x.op === 'keep')).toBe(true);
  });

  test('pure addition', () => {
    const { ops } = diffLines('a\nb', 'a\nb\nc');
    expect(ops.length).toBe(3);
    expect(ops[2]).toEqual({ op: 'add', beforeLine: null, afterLine: 2, text: 'c' });
  });

  test('pure deletion', () => {
    const { ops } = diffLines('a\nb\nc', 'a\nc');
    expect(ops.find((x) => x.op === 'del')).toEqual({ op: 'del', beforeLine: 1, afterLine: null, text: 'b' });
  });

  test('replacement = del then add', () => {
    const { ops } = diffLines('a\nb\nc', 'a\nX\nc');
    expect(ops.map((x) => `${x.op}:${x.text}`)).toEqual(['keep:a', 'del:b', 'add:X', 'keep:c']);
  });

  test('handles empty before', () => {
    const { ops } = diffLines('', 'hello');
    expect(sides(ops)).toEqual({ before: '', after: 'hello' });
  });

  test('diffStats counts adds + dels', () => {
    const { ops } = diffLines('a\nb\nc', 'a\nX\nY\nc');
    expect(diffStats(ops)).toEqual({ adds: 2, dels: 1 });
  });

  test('random inputs: both sides come back, and the diff is the shortest (as many keeps as the LCS)', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let n = 0; n < 300; n++) {
      const a = Array.from({ length: Math.floor(rand() * 14) }, () => 'abcde'[Math.floor(rand() * 5)]);
      const b = Array.from({ length: Math.floor(rand() * 14) }, () => 'abcde'[Math.floor(rand() * 5)]);
      const { ops, coarse } = diffLines(a.join('\n'), b.join('\n'));
      expect(coarse).toBe(false);
      expect(sides(ops)).toEqual({ before: a.join('\n'), after: b.join('\n') });
      const keeps = ops.filter((o) => o.op === 'keep').length;
      // split('') of an empty join is [''], one line either side.
      expect(keeps).toBe(lcsLength(a.join('\n').split('\n'), b.join('\n').split('\n')));
    }
  });

  test('line numbers refer to each side', () => {
    const { ops } = diffLines('x\na\nb', 'a\nb\ny');
    for (const o of ops) {
      if (o.beforeLine !== null) expect(['x', 'a', 'b'][o.beforeLine]).toBe(o.text);
      if (o.afterLine !== null) expect(['a', 'b', 'y'][o.afterLine]).toBe(o.text);
    }
  });

  test('a large file with a few edits is fast; one rewritten throughout falls back to one replacement within the budget', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const edited = [...big];
    edited[10] = 'changed'; edited.splice(25_000, 0, 'inserted'); edited[49_000] = 'also changed';
    let started = performance.now();
    const small = diffLines(big.join('\n'), edited.join('\n'));
    expect(performance.now() - started).toBeLessThan(500);
    expect(small.coarse).toBe(false);
    expect(diffStats(small.ops)).toEqual({ adds: 3, dels: 2 });

    const rewritten = big.map((line, i) => (i % 2 ? line : `${line}!`));
    started = performance.now();
    const coarse = diffLines(big.join('\n'), rewritten.join('\n'));
    expect(performance.now() - started).toBeLessThan(1500);
    expect(coarse.coarse).toBe(true);
    expect(sides(coarse.ops)).toEqual({ before: big.join('\n'), after: rewritten.join('\n') });
  });
});
