import { describe, expect, test } from 'vitest';
import { NEXT_BUCKET_ORDER, dateOnlyToEndOfDay, isValidTimezone, rankTasks } from './rank';

const NOW = new Date('2026-09-07T10:00:00'); // local time, a Monday

type T = { id: string; title: string; status: string; priority: number; dueAt?: string | null; createdAt: string; source?: string };
const mk = (over: Partial<T> & { id: string }): T => ({
  title: over.id,
  status: 'open',
  priority: 0,
  dueAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  source: 'user',
  ...over,
});

describe('rankTasks', () => {
  test('orders overdue → today → high → inbound → upcoming → backlog', () => {
    const tasks = [
      mk({ id: 'backlog' }),
      mk({ id: 'upcoming', dueAt: '2026-09-10T09:00:00' }),
      mk({ id: 'inbound', source: 'email', createdAt: '2026-09-07T08:00:00' }),
      mk({ id: 'high', priority: 3 }),
      mk({ id: 'today', dueAt: '2026-09-07T17:00:00' }),
      mk({ id: 'overdue', dueAt: '2026-09-05T09:00:00' }),
    ];
    const ranked = rankTasks(tasks, NOW);
    expect(ranked.map((r) => r.task.id)).toEqual(['overdue', 'today', 'high', 'inbound', 'upcoming', 'backlog']);
    expect(ranked.map((r) => r.bucket)).toEqual([...NEXT_BUCKET_ORDER]);
  });

  test('drops done and archived tasks', () => {
    const ranked = rankTasks([mk({ id: 'a', status: 'done' }), mk({ id: 'b', status: 'archived' }), mk({ id: 'c' })], NOW);
    expect(ranked.map((r) => r.task.id)).toEqual(['c']);
  });

  test('most overdue first, then earliest due today', () => {
    const ranked = rankTasks(
      [
        mk({ id: 'late1', dueAt: '2026-09-06T09:00:00' }),
        mk({ id: 'late3', dueAt: '2026-09-04T09:00:00' }),
        mk({ id: 'pm', dueAt: '2026-09-07T18:00:00' }),
        mk({ id: 'noon', dueAt: '2026-09-07T12:00:00' }),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.task.id)).toEqual(['late3', 'late1', 'noon', 'pm']);
    expect(ranked[0].reason).toBe('was due 3 days ago');
    expect(ranked[1].reason).toBe('was due yesterday');
    expect(ranked[2].reason).toBe('due today');
  });

  test('overdue earlier today reads as "today"; last night reads as "yesterday"', () => {
    const ranked = rankTasks([mk({ id: 'x', dueAt: '2026-09-07T08:00:00' }), mk({ id: 'y', dueAt: '2026-09-06T22:00:00' })], NOW);
    const byId = Object.fromEntries(ranked.map((r) => [r.task.id, r]));
    expect(byId.x.bucket).toBe('overdue');
    expect(byId.x.reason).toBe('was due today');
    expect(byId.y.reason).toBe('was due yesterday');
    // Most overdue first.
    expect(ranked.map((r) => r.task.id)).toEqual(['y', 'x']);
  });

  test('day boundaries follow the caller\'s timezone, not the process zone', () => {
    // 20:00 on Sep 7 in Los Angeles is 03:00Z on Sep 8.
    const nowLA = new Date('2026-09-08T03:00:00Z');
    const tz = 'America/Los_Angeles';
    const ranked = rankTasks(
      [
        mk({ id: 'tonight', dueAt: '2026-09-08T05:30:00Z' }), // 22:30 local Sep 7 → today
        mk({ id: 'tomorrow-morning', dueAt: '2026-09-08T16:00:00Z' }), // 09:00 local Sep 8 → upcoming
        mk({ id: 'eighth-day', dueAt: '2026-09-15T06:59:00Z' }), // 23:59 local Sep 14 → still this week
        mk({ id: 'ninth-day', dueAt: '2026-09-15T07:01:00Z' }), // 00:01 local Sep 15 → backlog
      ],
      nowLA,
      { timezone: tz },
    );
    expect(ranked.map((r) => [r.task.id, r.bucket])).toEqual([
      ['tonight', 'today'],
      ['tomorrow-morning', 'upcoming'],
      ['eighth-day', 'upcoming'],
      ['ninth-day', 'backlog'],
    ]);
    expect(ranked[1].reason).toBe('due in 1 day');
    expect(ranked[2].reason).toBe('due in 7 days');
    // In UTC it is already Sep 8, so "tomorrow morning" (16:00Z) is due today.
    expect(rankTasks([mk({ id: 'tomorrow-morning', dueAt: '2026-09-08T16:00:00Z' })], nowLA, { timezone: 'UTC' })[0].bucket).toBe('today');
  });

  test('day boundaries are exact on DST transition days', () => {
    // Berlin springs forward 2026-03-29 at 02:00 (+1 → +2). At 10:00Z that
    // day the offset is +2, but midnight was at +1 (23:00Z the day before).
    const spring = new Date('2026-03-29T10:00:00Z');
    const lateLastNight = rankTasks([mk({ id: 'x', dueAt: '2026-03-28T23:30:00Z' })], spring, { timezone: 'Europe/Berlin' })[0];
    expect(lateLastNight.reason).toBe('was due today');
    const justBeforeMidnight = rankTasks([mk({ id: 'y', dueAt: '2026-03-28T22:59:00Z' })], spring, { timezone: 'Europe/Berlin' })[0];
    expect(justBeforeMidnight.reason).toBe('was due yesterday');
    // Falls back 2026-10-25 at 03:00 (+2 → +1): midnight was 22:00Z.
    const fall = new Date('2026-10-25T10:00:00Z');
    expect(rankTasks([mk({ id: 'z', dueAt: '2026-10-24T22:30:00Z' })], fall, { timezone: 'Europe/Berlin' })[0].reason).toBe('was due today');
    expect(rankTasks([mk({ id: 'w', dueAt: '2026-10-24T21:59:00Z' })], fall, { timezone: 'Europe/Berlin' })[0].reason).toBe('was due yesterday');
  });

  test('a task due at a past midnight counts whole days, not one extra', () => {
    const noonUtc = new Date('2026-09-07T12:00:00Z');
    const two = rankTasks([mk({ id: 'a', dueAt: '2026-09-05T00:00:00Z' })], noonUtc, { timezone: 'UTC' })[0];
    expect(two.reason).toBe('was due 2 days ago');
    const one = rankTasks([mk({ id: 'b', dueAt: '2026-09-06T23:59:00Z' })], noonUtc, { timezone: 'UTC' })[0];
    expect(one.reason).toBe('was due yesterday');
  });

  test('an invalid timezone falls back instead of throwing', () => {
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(() => rankTasks([mk({ id: 'x' })], NOW, { timezone: 'Mars/Olympus' })).not.toThrow();
  });

  test('a due date beats priority; priority beats provenance', () => {
    const ranked = rankTasks(
      [
        mk({ id: 'email', source: 'email', createdAt: '2026-09-07T09:00:00', priority: 3 }),
        mk({ id: 'due', dueAt: '2026-09-07T15:00:00', priority: 0 }),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.task.id)).toEqual(['due', 'email']);
    // priority 3 wins over the inbound bucket
    expect(ranked[1].bucket).toBe('high');
  });

  test('inbound only counts within 48 hours; older provenance falls to backlog', () => {
    const ranked = rankTasks(
      [
        mk({ id: 'old-email', source: 'email', createdAt: '2026-09-01T09:00:00' }),
        mk({ id: 'fresh-research', source: 'research', createdAt: '2026-09-06T09:00:00' }),
      ],
      NOW,
    );
    expect(ranked.map((r) => [r.task.id, r.bucket])).toEqual([
      ['fresh-research', 'inbound'],
      ['old-email', 'backlog'],
    ]);
    expect(ranked[0].reason).toBe('came in from a research report');
  });

  test('upcoming runs to the end of the 7th day, with the day count in the reason', () => {
    const ranked = rankTasks(
      [mk({ id: 'far', dueAt: '2026-09-15T00:30:00' }), mk({ id: 'soon', dueAt: '2026-09-09T09:00:00' }), mk({ id: 'edge', dueAt: '2026-09-14T23:30:00' })],
      NOW,
    );
    expect(ranked.map((r) => [r.task.id, r.bucket])).toEqual([
      ['soon', 'upcoming'],
      ['edge', 'upcoming'],
      ['far', 'backlog'],
    ]);
    expect(ranked[0].reason).toBe('due in 2 days');
    expect(ranked[1].reason).toBe('due in 7 days');
  });

  test('upcoming (legacy shape)', () => {
    const ranked = rankTasks(
      [mk({ id: 'far', dueAt: '2026-09-20T09:00:00' }), mk({ id: 'soon', dueAt: '2026-09-09T09:00:00' })],
      NOW,
    );
    expect(ranked.map((r) => [r.task.id, r.bucket])).toEqual([
      ['soon', 'upcoming'],
      ['far', 'backlog'],
    ]);
    expect(ranked[0].reason).toBe('due in 2 days');
  });

  test('backlog orders by priority then newest', () => {
    const ranked = rankTasks(
      [
        mk({ id: 'p1-old', priority: 1, createdAt: '2026-08-01T00:00:00Z' }),
        mk({ id: 'p0-new', priority: 0, createdAt: '2026-09-06T00:00:00Z' }),
        mk({ id: 'p2', priority: 2 }),
        mk({ id: 'p1-new', priority: 1, createdAt: '2026-09-05T00:00:00Z' }),
      ],
      NOW,
    );
    expect(ranked.map((r) => r.task.id)).toEqual(['p2', 'p1-new', 'p1-old', 'p0-new']);
    expect(ranked[3].reason).toBe('no date, no priority');
  });

  test('accepts Date objects and ignores unparseable due dates', () => {
    const ranked = rankTasks(
      [
        { id: 'd', title: 'd', status: 'open', priority: 0, dueAt: new Date('2026-09-05T09:00:00'), createdAt: new Date('2026-09-01T00:00:00Z') },
        { id: 'garbage', title: 'g', status: 'open', priority: 0, dueAt: 'not a date', createdAt: '2026-09-01T00:00:00Z' },
      ],
      NOW,
    );
    expect(ranked.map((r) => [r.task.id, r.bucket])).toEqual([
      ['d', 'overdue'],
      ['garbage', 'backlog'],
    ]);
  });
});

describe('dateOnlyToEndOfDay', () => {
  test('a bare date becomes the last ms of that day in the zone', () => {
    expect(dateOnlyToEndOfDay('2026-09-07', 'Europe/Berlin')?.toISOString()).toBe('2026-09-07T21:59:59.999Z');
    expect(dateOnlyToEndOfDay('2026-09-07', 'America/Los_Angeles')?.toISOString()).toBe('2026-09-08T06:59:59.999Z');
    expect(dateOnlyToEndOfDay('2026-09-07', 'UTC')?.toISOString()).toBe('2026-09-07T23:59:59.999Z');
  });
  test('DST-day dates still end at local midnight', () => {
    expect(dateOnlyToEndOfDay('2026-03-29', 'Europe/Berlin')?.toISOString()).toBe('2026-03-29T21:59:59.999Z');
    expect(dateOnlyToEndOfDay('2026-03-28', 'Europe/Berlin')?.toISOString()).toBe('2026-03-28T22:59:59.999Z');
  });
  test('non-bare values are left to ISO parsing; bad zones fall back to UTC', () => {
    expect(dateOnlyToEndOfDay('2026-09-07T10:00:00Z', 'UTC')).toBeNull();
    expect(dateOnlyToEndOfDay('next tuesday', 'UTC')).toBeNull();
    expect(dateOnlyToEndOfDay('2026-09-07', 'Mars/Olympus')?.toISOString()).toBe('2026-09-07T23:59:59.999Z');
  });
  test('a task due "today" by date ranks as due today, not overdue, all day long', () => {
    const berlinMorning = new Date('2026-09-07T06:00:00Z'); // 08:00 Berlin
    const due = dateOnlyToEndOfDay('2026-09-07', 'Europe/Berlin')!;
    expect(rankTasks([mk({ id: 't', dueAt: due.toISOString() })], berlinMorning, { timezone: 'Europe/Berlin' })[0].bucket).toBe('today');
  });
});
