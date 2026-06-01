/**
 * Line diff util — powers the work-stream diff renderer (Thread 1) and the
 * in-chat file view's diff mode (Thread 2). Pure, no I/O.
 */
import { describe, expect, test } from 'bun:test';
import { computeLineDiff } from './diff';

describe('computeLineDiff', () => {
  test('new file: every line is an addition, nothing removed', () => {
    const d = computeLineDiff('', 'a\nb\nc');
    expect(d.added).toBe(3);
    expect(d.removed).toBe(0);
    expect(d.patch).toContain('+a');
    expect(d.patch).toContain('+c');
    expect(d.truncated).toBe(false);
  });

  test('identical content: no adds, no removes', () => {
    const d = computeLineDiff('x\ny', 'x\ny');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  test('single-line change reports +1 −1 and shows both lines', () => {
    const d = computeLineDiff('roses are red\nviolets are blue', 'roses are red\nviolets are green');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.patch).toContain('-violets are blue');
    expect(d.patch).toContain('+violets are green');
    // The unchanged first line is kept as context (space prefix).
    expect(d.patch).toContain(' roses are red');
  });

  test('pure insertion in the middle counts only additions', () => {
    const d = computeLineDiff('a\nb', 'a\nNEW\nb');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.patch).toContain('+NEW');
  });

  test('full deletion counts only removals', () => {
    const d = computeLineDiff('a\nb\nc', '');
    expect(d.added).toBe(0);
    expect(d.removed).toBe(3);
  });

  test('truncates an oversized diff and flags it', () => {
    const before = '';
    const after = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const d = computeLineDiff(before, after, { maxPatchLines: 50 });
    expect(d.truncated).toBe(true);
    expect(d.patch).toContain('diff truncated');
    // Counts reflect the TRUE totals even though the patch text is capped.
    expect(d.added).toBe(500);
  });

  test('falls back to coarse diff past the LCS product budget', () => {
    // Force the coarse path with a tiny budget; result must still reconstruct counts.
    const before = 'a\nb\nc\nd';
    const after = 'w\nx\ny\nz';
    const d = computeLineDiff(before, after, { lcsProductBudget: 1 });
    expect(d.removed).toBe(4);
    expect(d.added).toBe(4);
  });
});
