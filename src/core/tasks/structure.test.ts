import { describe, expect, test } from 'vitest';
import { isWaiting, nestTasks, normalizeEstimate, toLookup, waitingOn, waitingReason, wouldCycle } from './structure';

type T = { id: string; title: string; status: string; parentId?: string | null; blockedBy?: string[] };
const mk = (id: string, over: Partial<T> = {}): T => ({ id, title: id, status: 'open', parentId: null, blockedBy: [], ...over });

describe('nestTasks', () => {
  test('nests children under parents in the set and keeps sibling order', () => {
    const tree = nestTasks([mk('p'), mk('c2', { parentId: 'p' }), mk('c1', { parentId: 'p' }), mk('q')]);
    expect(tree.map((t) => t.id)).toEqual(['p', 'q']);
    expect(tree[0].children.map((t) => t.id)).toEqual(['c2', 'c1']);
  });

  test('a child whose parent is not in the set is a root of the set', () => {
    const tree = nestTasks([mk('c', { parentId: 'missing' })]);
    expect(tree.map((t) => t.id)).toEqual(['c']);
    expect(tree[0].children).toEqual([]);
  });

  test('nests to any depth and does not loop on a self-parent', () => {
    const tree = nestTasks([mk('a'), mk('b', { parentId: 'a' }), mk('c', { parentId: 'b' }), mk('self', { parentId: 'self' })]);
    expect(tree.map((t) => t.id)).toEqual(['a', 'self']);
    expect(tree[0].children[0].children[0].id).toBe('c');
  });
});

describe('waitingOn', () => {
  test('only active blockers block; done, archived and unknown ids are inert', () => {
    const rows = [
      mk('t', { blockedBy: ['open', 'doing', 'done', 'archived', 'gone', 't'] }),
      mk('open'),
      mk('doing', { status: 'in_progress' }),
      mk('done', { status: 'done' }),
      mk('archived', { status: 'archived' }),
    ];
    const w = waitingOn(rows[0], toLookup(rows));
    expect(w.blockers.map((b) => b.id)).toEqual(['open', 'doing']);
    expect(w.openChildren).toBe(0);
  });

  test('counts active children only', () => {
    const rows = [mk('p'), mk('a', { parentId: 'p' }), mk('b', { parentId: 'p', status: 'done' }), mk('c', { parentId: 'p', status: 'in_progress' })];
    const lookup = toLookup(rows);
    expect(waitingOn(rows[0], lookup).openChildren).toBe(2);
    expect(isWaiting(rows[0], lookup)).toBe(true);
    expect(isWaiting(rows[1], lookup)).toBe(false);
  });

  test('reason names the first blocker, counts the rest, else counts sub-tasks', () => {
    expect(waitingReason({ blockers: [{ id: 'x', title: 'Ship auth' }], openChildren: 0 })).toBe('blocked by "Ship auth"');
    expect(waitingReason({ blockers: [{ id: 'x', title: 'Ship auth' }, { id: 'y', title: 'B' }], openChildren: 2 })).toBe('blocked by "Ship auth" and 1 more');
    expect(waitingReason({ blockers: [], openChildren: 1 })).toBe('1 sub-task open');
    expect(waitingReason({ blockers: [], openChildren: 3 })).toBe('3 sub-tasks open');
    expect(waitingReason({ blockers: [], openChildren: 0 })).toBeNull();
  });
});

describe('wouldCycle', () => {
  const lookup = toLookup([mk('a'), mk('b', { parentId: 'a' }), mk('c', { parentId: 'b' })]);
  test('re-parenting under a descendant is a cycle', () => {
    expect(wouldCycle('a', 'c', lookup)).toBe(true);
    expect(wouldCycle('a', 'a', lookup)).toBe(true);
  });
  test('re-parenting under an unrelated or ancestor task is fine', () => {
    expect(wouldCycle('c', 'a', lookup)).toBe(false);
    expect(wouldCycle('c', 'unknown', lookup)).toBe(false);
  });
  test('an existing loop in the data trips the depth cap instead of hanging', () => {
    const loop = toLookup([mk('x', { parentId: 'y' }), mk('y', { parentId: 'x' })]);
    expect(wouldCycle('z', 'x', loop)).toBe(true);
  });
});

test('normalizeEstimate trims, caps and nulls empties', () => {
  expect(normalizeEstimate('  M ')).toBe('M');
  expect(normalizeEstimate('')).toBeNull();
  expect(normalizeEstimate(3)).toBeNull();
  expect(normalizeEstimate('x'.repeat(60))).toHaveLength(40);
});
