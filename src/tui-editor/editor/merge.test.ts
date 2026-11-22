import { describe, expect, test } from 'vitest';
import { applyHunks } from './hunks';
import { reviewDiff } from './merge';

const apply = (base: string, ours: string, theirs: string, accept: (i: number, conflict: boolean) => boolean) => {
  const d = reviewDiff(base, ours, theirs);
  return applyHunks(d.ops, d.hunks, (h) => accept(h.index, d.conflicts[h.index]));
};

describe('reviewDiff (three-way agent review)', () => {
  test('without unsaved edits it is the plain diff of the buffer against the agent text', () => {
    const d = reviewDiff('a\nb\nc', 'a\nb\nc', 'a\nB\nc');
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ removed: ['b'], added: ['B'] });
    expect(d.conflicts).toEqual([false]);
  });

  test('the user\'s unsaved edits are not hunks, and accepting everything keeps them', () => {
    const base = 'a\nb\nc\nd\ne';
    const ours = 'A\nb\nc\nd\ne';
    const theirs = 'a\nb\nc\nd\nE';
    const d = reviewDiff(base, ours, theirs);
    expect(d.hunks.map((h) => [h.removed, h.added])).toEqual([[['e'], ['E']]]);
    expect(apply(base, ours, theirs, () => true)).toBe('A\nb\nc\nd\nE');
    expect(apply(base, ours, theirs, () => false)).toBe(ours);
  });

  test('lines added or removed by the user shift where the agent change lands', () => {
    const base = 'one\ntwo\nthree\nfour\nfive';
    const ours = 'zero\none\ntwo\nthree\nfour\nfive';
    const theirs = 'one\ntwo\nthree\nfour\nFIVE\nsix';
    expect(apply(base, ours, theirs, () => true)).toBe('zero\none\ntwo\nthree\nfour\nFIVE\nsix');
  });

  test('an agent change over or next to the user\'s lines is a conflict covering both', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng';
    const ours = 'a\nb\nMINE\nd\ne\nf\ng';
    const theirs = 'a\nb\nAGENT\nd\ne\nf\nG';
    const d = reviewDiff(base, ours, theirs);
    expect(d.conflicts).toEqual([true, false]);
    expect(d.hunks[0]).toMatchObject({ removed: ['MINE'], added: ['AGENT'] });
    // Rejecting conflicts keeps the user's line; the other agent change still applies.
    expect(apply(base, ours, theirs, (_i, conflict) => !conflict)).toBe('a\nb\nMINE\nd\ne\nf\nG');
    expect(apply(base, ours, theirs, () => true)).toBe('a\nb\nAGENT\nd\ne\nf\nG');
    // Touching, not overlapping: still a conflict.
    expect(reviewDiff('a\nb\nc\nd', 'a\nB\nc\nd', 'a\nb\nC\nd').conflicts).toEqual([true]);
  });

  test('the same change made by both is nothing to review', () => {
    const d = reviewDiff('a\nb\nc', 'a\nX\nc', 'a\nX\nc');
    expect(d.hunks).toHaveLength(0);
  });

  test('an insertion and a deletion at the edges of the file', () => {
    expect(apply('a\nb', 'a\nb\nmine', 'top\na\nb', () => true)).toBe('top\na\nb\nmine');
    expect(apply('a\nb\nc', 'a\nb\nc!', 'b\nc', () => true)).toBe('b\nc!');
  });
});
