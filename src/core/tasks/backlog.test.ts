import { describe, expect, test } from 'vitest';
import { parseBacklog } from './backlog';

describe('parseBacklog', () => {
  test('flattens phases and children depth-first, children inherit the phase as category', () => {
    const parsed = parseBacklog([
      { title: 'Phase 1: auth', category: 'Auth', estimate: 'L', children: ['Login form', { title: 'Session cookie', estimate: 'S' }] },
      { title: 'Phase 2: billing', children: [{ title: 'Stripe', category: 'Payments' }] },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items.map((i) => [i.index, i.title, i.parentIndex, i.category, i.estimate])).toEqual([
      [1, 'Phase 1: auth', null, 'Auth', 'L'],
      [2, 'Login form', 1, 'Auth', null],
      [3, 'Session cookie', 1, 'Auth', 'S'],
      [4, 'Phase 2: billing', null, null, null],
      [5, 'Stripe', 4, 'Payments', null],
    ]);
  });

  test('resolves blockedBy by title (case-insensitive), by #position, and by task id; forward refs allowed', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const parsed = parseBacklog([
      { title: 'Design schema', blockedBy: ['write api', '#3', id, '#1'] },
      { title: 'Write API', blockedBy: ['Design Schema'] },
      { title: 'Deploy', blocked_by: '2' },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items[0].blockedByIndexes).toEqual([2, 3]);
    expect(parsed.items[0].blockedByIds).toEqual([id]);
    expect(parsed.items[1].blockedByIndexes).toEqual([1]);
    expect(parsed.items[2].blockedByIndexes).toEqual([2]);
  });

  test('an unresolvable reference fails the whole batch with the item named', () => {
    const parsed = parseBacklog([{ title: 'A', blockedBy: ['nope'] }]);
    expect(parsed).toEqual({ ok: false, error: expect.stringContaining('Item 1 ("A") is blocked by "nope"') });
  });

  test('rejects empty lists, untitled items, and out-of-range positions', () => {
    expect(parseBacklog([])).toMatchObject({ ok: false });
    expect(parseBacklog(['ok', { detail: 'no title' }])).toMatchObject({ ok: false, error: 'Item 2 has no title.' });
    expect(parseBacklog([{ title: 'A', blockedBy: ['#9'] }])).toMatchObject({ ok: false });
  });

  test('normalizes priority, notes/detail aliases and whitespace in titles', () => {
    const parsed = parseBacklog([{ title: '  Two   words ', notes: ' n ', priority: 9 }, { title: 'x', detail: 'd', priority: -1 }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items[0]).toMatchObject({ title: 'Two words', notes: 'n', priority: 3 });
    expect(parsed.items[1]).toMatchObject({ notes: 'd', priority: 0 });
  });
});
