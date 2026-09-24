/**
 * Triage payload normalization — the QA "Triaged 0" bug. The model replied,
 * but the strict id→object-map + lowercase-only priority check silently dropped
 * every shape a smaller model commonly returns (an array of rows, capitalized
 * or synonym priorities, a wrapped object). These guard the loosened parsing.
 */
import { describe, expect, test } from 'vitest';
import { coercePriority, triageEntries } from './service';

describe('coercePriority', () => {
  test('normalizes case and synonyms to the three buckets', () => {
    expect(coercePriority('High')).toBe('high');
    expect(coercePriority('URGENT')).toBe('high');
    expect(coercePriority('low')).toBe('low');
    expect(coercePriority('fyi')).toBe('low');
    expect(coercePriority('medium')).toBe('normal');
  });
  test('unrecognized / missing falls back to normal (still triaged, not dropped)', () => {
    expect(coercePriority(undefined)).toBe('normal');
    expect(coercePriority('whatever')).toBe('normal');
    expect(coercePriority(2)).toBe('normal');
  });
});

describe('triageEntries', () => {
  test('id→object map (the asked-for shape)', () => {
    const e = triageEntries({ a: { priority: 'high' }, b: { priority: 'low' } });
    expect(e.map(([id]) => id).sort()).toEqual(['a', 'b']);
  });
  test('ARRAY of rows with an id field (common for small models)', () => {
    const e = triageEntries([
      { id: 'a', priority: 'High' },
      { messageId: 'b', priority: 'low' },
    ]);
    expect(e.map(([id]) => id).sort()).toEqual(['a', 'b']);
  });
  test('unwraps a single wrapper key', () => {
    expect(triageEntries({ triage: { a: { priority: 'high' } } })).toHaveLength(1);
    expect(triageEntries({ results: [{ id: 'a', priority: 'low' }] })).toHaveLength(1);
  });
  test('non-object / empty inputs yield nothing', () => {
    expect(triageEntries(null)).toEqual([]);
    expect(triageEntries('nope')).toEqual([]);
  });
});

describe('categories and auto-archive', () => {
  test('categories coerce onto the fixed list', async () => {
    const { coerceCategory } = await import('./service');
    expect(coerceCategory('Spam')).toBe('spam');
    expect(coerceCategory('marketing')).toBe('promotion');
    expect(coerceCategory('shopping')).toBe('other');
    expect(coerceCategory('travel', { travel: 'trips', other: 'x' })).toBe('travel');
    expect(coerceCategory('marketing', { travel: 'trips', other: 'x' })).toBe('other'); // no promotion bucket to alias to
  });
  test('user category lists are validated at the boundary; other is always kept', async () => {
    const { validateCategories } = await import('./service');
    expect(validateCategories({ travel: ' trips\nand  bookings ' })).toEqual({ travel: 'trips and bookings', other: 'none of the above' });
    expect(validateCategories({ 'Bad Name': 'x' })).toMatch(/invalid category name/);
    expect(validateCategories({ ok: '' })).toMatch(/description/);
    expect(validateCategories(['a'])).toMatch(/object/);
    expect(Object.keys(validateCategories(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, 'x']))))).toHaveLength(21); // 20 + other
    expect(validateCategories(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i}`, 'x'])))).toMatch(/at most 20/);
  });
  test('labels group ids by category', async () => {
    const { idsByCategory } = await import('./service');
    expect([...idsByCategory({ a: { priority: 'low', category: 'spam' }, b: { priority: 'high', category: 'work' }, c: { priority: 'low', category: 'spam' }, d: { priority: 'low' } })])
      .toEqual([['spam', ['a', 'c']], ['work', ['b']]]);
  });
  test('only LOW-priority spam/promotion is auto-archived', async () => {
    const { autoArchiveIds } = await import('./service');
    expect(autoArchiveIds({
      a: { priority: 'low', category: 'spam' },
      b: { priority: 'low', category: 'promotion' },
      c: { priority: 'normal', category: 'promotion' }, // a renewal deadline someone waits on
      d: { priority: 'low', category: 'newsletter' },
      e: { priority: 'high', category: 'spam' },
    }).sort()).toEqual(['a', 'b']);
  });
});
