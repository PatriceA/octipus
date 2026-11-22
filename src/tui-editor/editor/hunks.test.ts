import { describe, expect, test } from 'vitest';
import { diffLines } from './diff';
import { applyHunks, buildHunks, intraLineChanges } from './hunks';

function review(before: string, after: string) {
  const { ops } = diffLines(before, after);
  const hunks = buildHunks(ops);
  /** The text with the hunks at `indexes` accepted. */
  const accept = (...indexes: number[]) => applyHunks(ops, hunks, (h) => indexes.includes(h.index));
  return { hunks, accept };
}

describe('hunks', () => {
  test('changes separated by an unchanged line are separate hunks; side-by-side changes are one', () => {
    const { hunks } = review('a\nb\nc\nd\ne', 'a\nB\nc\nD\nE');
    expect(hunks.map((h) => [h.removed, h.added])).toEqual([[['b'], ['B']], [['d', 'e'], ['D', 'E']]]);
    expect(hunks.map((h) => [h.beforeLine, h.afterLine])).toEqual([[1, 1], [3, 3]]);
  });

  test('accepting all gives the agent text, none gives the original, each subset gives each mix', () => {
    const before = 'one\ntwo\nthree\nfour\nfive';
    const after = 'one\nTWO\nthree\nFOUR\nfive';
    const { accept, hunks } = review(before, after);
    expect(hunks).toHaveLength(2);
    expect(accept(0, 1)).toBe(after);
    expect(accept()).toBe(before);
    expect(accept(0)).toBe('one\nTWO\nthree\nfour\nfive');
    expect(accept(1)).toBe('one\ntwo\nthree\nFOUR\nfive');
  });

  test('adjacent hunks (one line apart) with insertions and deletions decide independently', () => {
    const before = 'keep\ndel me\nmid\nold\nend';
    const after = 'keep\nmid\nnew 1\nnew 2\nend';
    const { accept, hunks } = review(before, after);
    expect(hunks.map((h) => [h.removed, h.added])).toEqual([[['del me'], []], [['old'], ['new 1', 'new 2']]]);
    expect(accept(0)).toBe('keep\nmid\nold\nend');
    expect(accept(1)).toBe('keep\ndel me\nmid\nnew 1\nnew 2\nend');
  });

  test('edits at the start and the end of the file, and the final newline', () => {
    const before = 'first\nmiddle\nlast\n';
    const after = 'FIRST\nmiddle\nlast\nadded';
    const { accept, hunks } = review(before, after);
    expect(hunks).toHaveLength(2);
    expect(accept(0)).toBe('FIRST\nmiddle\nlast\n');
    expect(accept(1)).toBe('first\nmiddle\nlast\nadded');
    expect(accept(0, 1)).toBe(after);
    // Into an empty file, and emptying one.
    expect(review('', 'new\n').accept(0)).toBe('new\n');
    expect(review('gone\n', '').accept()).toBe('gone\n');
    expect(review('gone\n', '').accept(0)).toBe('');
  });

  test('every subset of hunks on random edits gives each hunk from one side, the rest unchanged', () => {
    let seed = 11;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let n = 0; n < 100; n++) {
      const before = Array.from({ length: 12 }, (_, i) => `l${i}`);
      const after = before.flatMap((line) => { const r = rand(); return r < 0.15 ? [] : r < 0.3 ? [`${line}!`] : r < 0.4 ? [line, 'ins'] : [line]; });
      const { accept, hunks } = review(before.join('\n'), after.join('\n'));
      expect(accept(...hunks.map((h) => h.index))).toBe(after.join('\n'));
      expect(accept()).toBe(before.join('\n'));
      // Accepting hunk k alone changes exactly its lines.
      for (const h of hunks) {
        const lines = accept(h.index).split('\n');
        expect(lines.slice(h.beforeLine, h.beforeLine + h.added.length)).toEqual(h.added);
        expect(lines.length).toBe(before.length - h.removed.length + h.added.length);
      }
    }
  });
});

describe('intraLineChanges', () => {
  test('marks the changed words of a line and its replacement', () => {
    const before = 'const greeting = "hello";';
    const after = 'const greeting = "goodbye";';
    const spans = intraLineChanges(before, after);
    expect(spans?.removed.map((s) => before.slice(s.start, s.end))).toEqual(['hello']);
    expect(spans?.added.map((s) => after.slice(s.start, s.end))).toEqual(['goodbye']);
  });

  test('a line rewritten completely gets no spans', () => {
    expect(intraLineChanges('alpha beta gamma', 'totally different words here')).toBeNull();
  });

  test('columns are UTF-16 offsets of the line, through emoji and accents', () => {
    const before = 'say 😀 then é';
    const after = 'say 🐙 then é';
    const spans = intraLineChanges(before, after);
    expect(spans?.removed.map((s) => before.slice(s.start, s.end))).toEqual(['😀']);
    expect(spans?.added.map((s) => after.slice(s.start, s.end))).toEqual(['🐙']);
  });
});
