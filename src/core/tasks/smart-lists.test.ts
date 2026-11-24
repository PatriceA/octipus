import { describe, expect, test } from 'vitest';
import { isAllDayDue, isListKey, listCounts, listMembers, listTitle, orderBetween, plannedGroup, renumbered, splitList, todayParts, type ListableTask } from './smart-lists';

const TODAY = '2026-11-23';
type Row = ListableTask & { title: string };
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, title: id, status: 'open', parentId: null, category: null, important: false, myDayOn: null, dueAt: null,
  sortOrder: 0, createdAt: '2026-11-01T00:00:00Z', completedAt: null, ...over,
});

const rows: Row[] = [
  row('picked', { myDayOn: TODAY, sortOrder: 2 }),
  row('stale-pick', { myDayOn: '2026-11-22', sortOrder: 1 }),
  row('star', { important: true, category: 'Work', sortOrder: -5 }),
  row('due', { dueAt: '2026-11-24T22:59:59.999Z', category: 'Work' }),
  row('step', { parentId: 'due', important: true }),
  row('orphan-step', { parentId: 'gone', category: 'Work' }),
  row('done-today', { status: 'done', myDayOn: TODAY, completedAt: '2026-11-23T09:00:00Z' }),
  row('done-earlier', { status: 'done', completedAt: '2026-11-20T09:00:00Z' }),
  row('deleted', { status: 'archived', important: true }),
];
const ids = (xs: Row[]) => xs.map((x) => x.id);

describe('listMembers', () => {
  test.each([
    ['my-day', ['picked', 'done-today']],
    ['important', ['star']],
    ['planned', ['due']],
    ['all', ['picked', 'stale-pick', 'star', 'due', 'orphan-step', 'done-today', 'done-earlier']],
    ['completed', ['done-today', 'done-earlier']],
    ['archived', ['deleted']],
    ['list:Work', ['star', 'due', 'orphan-step']],
  ] as const)('%s', (key, expected) => {
    expect(ids(listMembers(rows, key, TODAY))).toEqual(expected);
  });

  test('My Day rolls over: yesterday\'s pick is not in today\'s list', () => {
    expect(ids(listMembers(rows, 'my-day', '2026-11-24'))).toEqual([]);
    expect(ids(listMembers(rows, 'my-day', '2026-11-22'))).toEqual(['stale-pick']);
  });
});

test('splitList puts active rows in manual order and done ones latest first', () => {
  const { active, done } = splitList(listMembers(rows, 'all', TODAY));
  expect(ids(active)).toEqual(['star', 'due', 'orphan-step', 'stale-pick', 'picked']);
  expect(ids(done)).toEqual(['done-today', 'done-earlier']);
});

test('ties in manual order fall back to newest first', () => {
  const a = row('a', { createdAt: '2026-11-01T00:00:00Z' });
  const b = row('b', { createdAt: '2026-11-02T00:00:00Z' });
  expect(ids(splitList([a, b]).active)).toEqual(['b', 'a']);
});

test('listCounts counts active top-level rows', () => {
  const { smart, lists } = listCounts(rows, TODAY);
  expect(smart).toEqual({ 'my-day': 1, important: 1, planned: 1, all: 5, completed: 2, archived: 1 });
  expect([...lists]).toEqual([['Work', 3]]);
});

test('orderBetween finds a value strictly between, or says there is none', () => {
  expect(orderBetween(1, 3)).toBe(2);
  expect(orderBetween(null, 3)).toBe(2);
  expect(orderBetween(5, null)).toBe(6);
  expect(orderBetween(null, null)).toBe(0);
  expect(orderBetween(4, 4)).toBeNull();
  // Real values are about -1.8e12, where doubles run out of room after a dozen halvings.
  const hi = -1_795_000_000_000;
  let lo: number | null = hi - 1;
  let halvings = 0;
  for (let next = orderBetween(lo, hi); next !== null; next = orderBetween(lo, hi)) {
    expect(next).toBeGreaterThan(lo as number);
    expect(next).toBeLessThan(hi);
    lo = next;
    halvings += 1;
  }
  expect(halvings).toBeGreaterThan(5);
  expect(renumbered(3, -10.6)).toEqual([-11, 1013, 2037]);
});

test('plannedGroup is by calendar day in the zone', () => {
  const now = new Date('2026-11-23T09:00:00Z');
  const tz = 'Europe/Berlin';
  expect(plannedGroup('2026-11-22T22:59:59.999Z', now, tz)).toBe('earlier');
  expect(plannedGroup('2026-11-23T22:59:59.999Z', now, tz)).toBe('today');
  expect(plannedGroup('2026-11-23T23:30:00Z', now, tz)).toBe('tomorrow');
  expect(plannedGroup('2026-11-30T12:00:00Z', now, tz)).toBe('week');
  expect(plannedGroup('2026-12-01T12:00:00Z', now, tz)).toBe('later');
});

test('isAllDayDue tells a due day from a due time', () => {
  expect(isAllDayDue('2026-11-24T22:59:59.999Z')).toBe(true);
  expect(isAllDayDue('2026-11-24T14:00:00.000Z')).toBe(false);
  expect(isAllDayDue('2026-11-24T22:59:00.000Z')).toBe(false);
});

test('list keys and titles', () => {
  expect(isListKey('my-day')).toBe(true);
  expect(isListKey('list:Shopping')).toBe(true);
  expect(isListKey('list:')).toBe(false);
  expect(isListKey('next')).toBe(false);
  expect(listTitle('list:Shopping')).toBe('Shopping');
  expect(listTitle('planned')).toBe('Planned');
});

describe('todayParts', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  test('overdue, due today and picked, each to-do once; finished today of those', () => {
    const parts = todayParts([
      row('late', { dueAt: '2026-11-20T23:59:59.999Z', myDayOn: TODAY }),
      row('later-late', { dueAt: '2026-11-22T10:00:00Z' }),
      row('due-now', { dueAt: '2026-11-23T15:00:00Z', myDayOn: TODAY }),
      row('picked-b', { myDayOn: TODAY, sortOrder: 5 }),
      row('picked-a', { myDayOn: TODAY, sortOrder: 1 }),
      row('yesterday-pick', { myDayOn: '2026-11-22' }),
      row('tomorrow', { dueAt: '2026-11-24T23:59:59.999Z' }),
      row('step', { parentId: 'picked-a', myDayOn: TODAY }),
      row('done-picked', { status: 'done', myDayOn: TODAY, completedAt: '2026-11-23T08:00:00Z' }),
      row('done-due', { status: 'done', dueAt: '2026-11-23T23:59:59.999Z', completedAt: '2026-11-23T10:00:00Z' }),
      row('done-other', { status: 'done', completedAt: '2026-11-23T11:00:00Z' }),
      row('done-yesterday', { status: 'done', myDayOn: '2026-11-22', completedAt: '2026-11-22T11:00:00Z' }),
      row('deleted', { status: 'archived', myDayOn: TODAY }),
    ], now, 'UTC');
    expect(ids(parts.overdue)).toEqual(['late', 'later-late']);
    expect(ids(parts.due)).toEqual(['due-now']);
    expect(ids(parts.picked)).toEqual(['picked-a', 'picked-b']);
    expect(ids(parts.done)).toEqual(['done-due', 'done-picked']);
  });

  test('the day is the user\'s: late evening in their zone is still today', () => {
    const evening = new Date('2026-11-24T02:00:00Z');
    const parts = todayParts([row('due', { dueAt: '2026-11-23T23:59:59.999-05:00' })], evening, 'America/New_York');
    expect(ids(parts.due)).toEqual(['due']);
  });
});
