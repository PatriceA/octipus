import { describe, expect, test } from 'vitest';
import { Buffer } from './buffer';
import { matchBracket } from './brackets';
import { colInSegment, lineSegments, rowsBetween, segmentAt, stepRows } from './view';

describe('lineSegments', () => {
  test('without wrap a line is one row', () => {
    expect(lineSegments('a'.repeat(30), 10, false)).toEqual([{ start: 0, end: 30, startCell: 0, endCell: 30 }]);
  });

  test('with wrap rows are at most the width, and a wide character is never split', () => {
    const segs = lineSegments('abcd世界ef', 5, true);
    expect(segs.map((s) => 'abcd世界ef'.slice(s.start, s.end))).toEqual(['abcd', '世界e', 'f']);
    for (const s of segs) expect(s.endCell - s.startCell).toBeLessThanOrEqual(5);
  });

  test('tabs are measured from the start of the line, as the editor draws them', () => {
    const segs = lineSegments('ab\tcdefgh', 6, true);
    expect(segs[0]).toEqual({ start: 0, end: 5, startCell: 0, endCell: 6 }); // ab, the tab to cell 4, c, d
    expect(lineSegments('', 6, true)).toEqual([{ start: 0, end: 0, startCell: 0, endCell: 0 }]);
  });

  test('a column maps to its row and a cell back to a column', () => {
    const line = 'abcdefghij';
    const segs = lineSegments(line, 4, true);
    expect(segmentAt(segs, 0)).toBe(0);
    expect(segmentAt(segs, 4)).toBe(1);
    expect(segmentAt(segs, 10)).toBe(2);
    expect(colInSegment(line, segs[1], 2, false)).toBe(6);
    expect(colInSegment(line, segs[1], 9, false)).toBe(7); // past the end of a wrapped row: its last character
    expect(colInSegment(line, segs[2], 9, true)).toBe(10); // past the end of the line: the end
  });
});

describe('row stepping', () => {
  const rows = [1, 3, 1, 2];
  const rowsOf = (line: number) => rows[line];
  test('steps through wrapped rows and stops at the ends', () => {
    expect(stepRows({ line: 0, sub: 0 }, 2, 4, rowsOf)).toEqual({ line: 1, sub: 1 });
    expect(stepRows({ line: 1, sub: 1 }, -2, 4, rowsOf)).toEqual({ line: 0, sub: 0 });
    expect(stepRows({ line: 3, sub: 0 }, 9, 4, rowsOf)).toEqual({ line: 3, sub: 1 });
    expect(stepRows({ line: 0, sub: 0 }, -3, 4, rowsOf)).toEqual({ line: 0, sub: 0 });
    expect(rowsBetween({ line: 0, sub: 0 }, { line: 3, sub: 1 }, rowsOf, 100)).toBe(6);
    expect(rowsBetween({ line: 3, sub: 1 }, { line: 0, sub: 0 }, rowsOf, 100)).toBe(-6);
  });
});

describe('matchBracket', () => {
  test('finds the mate of the bracket under or just before the cursor, across lines and nesting', () => {
    const buf = new Buffer('f(a, [b]) {\n  g(1);\n}');
    expect(matchBracket(buf, { line: 0, col: 1 })).toEqual([{ line: 0, col: 1 }, { line: 0, col: 8 }]);
    expect(matchBracket(buf, { line: 0, col: 9 })).toEqual([{ line: 0, col: 8 }, { line: 0, col: 1 }]);
    expect(matchBracket(buf, { line: 0, col: 10 })).toEqual([{ line: 0, col: 10 }, { line: 2, col: 0 }]);
    expect(matchBracket(buf, { line: 2, col: 0 })).toEqual([{ line: 2, col: 0 }, { line: 0, col: 10 }]);
    expect(matchBracket(buf, { line: 1, col: 0 })).toBeNull();
  });

  test('an unmatched bracket has no mate', () => {
    expect(matchBracket(new Buffer('(()'), { line: 0, col: 0 })).toBeNull();
  });
});
