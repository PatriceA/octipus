/**
 * Triage payload normalization — the QA "Triaged 0" bug. The model replied,
 * but the strict id→object-map + lowercase-only priority check silently dropped
 * every shape a smaller model commonly returns (an array of rows, capitalized
 * or synonym priorities, a wrapped object). These guard the loosened parsing.
 */
import { describe, expect, test } from 'bun:test';
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
