import { describe, expect, test } from 'vitest';
import { nextOccurrence, normalizeRepeat, repeatLabel, type TaskRepeat } from './repeat';

const BERLIN = 'Europe/Berlin';
/** End of a Berlin day in November (UTC+1): what a bare due date is stored as. */
const endOfDay = (date: string) => new Date(`${date}T22:59:59.999Z`);
const next = (rule: TaskRepeat, due: Date | null, now: string, tz = BERLIN) => nextOccurrence(rule, due, new Date(now), tz).toISOString();

describe('normalizeRepeat', () => {
  test('accepts presets and rules; absent is no repeat', () => {
    expect(normalizeRepeat(null)).toBeNull();
    expect(normalizeRepeat(undefined)).toBeNull();
    expect(normalizeRepeat('daily')).toEqual({ unit: 'day', interval: 1 });
    expect(normalizeRepeat('Weekdays')).toEqual({ unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] });
    expect(normalizeRepeat({ unit: 'month' })).toEqual({ unit: 'month', interval: 1 });
    expect(normalizeRepeat({ unit: 'week', interval: 2, weekdays: [4, 2, 2] })).toEqual({ unit: 'week', interval: 2, weekdays: [2, 4] });
  });

  test.each([
    ['hourly', /Invalid repeat "hourly"/],
    [{ unit: 'fortnight' }, /Invalid repeat unit/],
    [{ unit: 'day', interval: 0 }, /interval/],
    [{ unit: 'day', interval: 1.5 }, /interval/],
    [{ unit: 'day', weekdays: [1] }, /weekdays go with unit "week"/],
    [{ unit: 'week', weekdays: [7] }, /weekdays must be/],
    [[1], /must be an object/],
  ])('refuses %j', (value, error) => {
    expect(() => normalizeRepeat(value)).toThrow(error);
  });
});

describe('repeatLabel', () => {
  test.each([
    [{ unit: 'day', interval: 1 }, 'Daily'],
    [{ unit: 'day', interval: 3 }, 'Every 3 days'],
    [{ unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }, 'Weekdays'],
    [{ unit: 'week', interval: 1 }, 'Weekly'],
    [{ unit: 'week', interval: 1, weekdays: [1, 3] }, 'Weekly on Mon, Wed'],
    [{ unit: 'week', interval: 2, weekdays: [5] }, 'Every 2 weeks on Fri'],
    [{ unit: 'month', interval: 1 }, 'Monthly'],
    [{ unit: 'year', interval: 2 }, 'Every 2 years'],
  ] as [TaskRepeat, string][])('%j → %s', (rule, label) => {
    expect(repeatLabel(rule)).toBe(label);
  });
});

describe('nextOccurrence', () => {
  // Monday 23 November 2026, mid-morning in Berlin.
  const NOW = '2026-11-23T09:00:00Z';

  test('daily from today\'s due date is tomorrow, still at the end of the day', () => {
    expect(next({ unit: 'day', interval: 1 }, endOfDay('2026-11-23'), NOW)).toBe(endOfDay('2026-11-24').toISOString());
  });

  test('a to-do finished late comes back today, not overdue', () => {
    expect(next({ unit: 'day', interval: 1 }, endOfDay('2026-11-18'), NOW)).toBe(endOfDay('2026-11-23').toISOString());
    // Weekly keeps its weekday: due Wednesday the 11th, next on or after today is Wednesday the 25th.
    expect(next({ unit: 'week', interval: 1 }, endOfDay('2026-11-11'), NOW)).toBe(endOfDay('2026-11-25').toISOString());
  });

  test('no due date counts from today', () => {
    expect(next({ unit: 'week', interval: 1 }, null, NOW)).toBe(endOfDay('2026-11-30').toISOString());
  });

  test('weekdays skip the weekend', () => {
    // Friday 27th → Monday 30th.
    expect(next({ unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }, endOfDay('2026-11-27'), NOW)).toBe(endOfDay('2026-11-30').toISOString());
    // Monday 23rd → Tuesday 24th.
    expect(next({ unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }, endOfDay('2026-11-23'), NOW)).toBe(endOfDay('2026-11-24').toISOString());
  });

  test('every 2 weeks on Tue and Thu: Thursday goes to Tuesday of the week after next', () => {
    const rule: TaskRepeat = { unit: 'week', interval: 2, weekdays: [2, 4] };
    expect(next(rule, endOfDay('2026-11-24'), NOW)).toBe(endOfDay('2026-11-26').toISOString());
    expect(next(rule, endOfDay('2026-11-26'), NOW)).toBe(endOfDay('2026-12-08').toISOString());
  });

  test('monthly clamps to the end of a shorter month; yearly handles 29 February', () => {
    expect(next({ unit: 'month', interval: 1 }, new Date('2027-01-31T10:00:00Z'), '2027-01-30T09:00:00Z')).toBe('2027-02-28T10:00:00.000Z');
    expect(next({ unit: 'year', interval: 1 }, new Date('2028-02-29T10:00:00Z'), '2028-02-28T09:00:00Z')).toBe('2029-02-28T10:00:00.000Z');
  });

  test('a timed to-do keeps its local time across a DST change', () => {
    // 09:00 in Berlin on Saturday 24 October (UTC+2) → Saturday 31 October, 09:00 at UTC+1.
    expect(next({ unit: 'week', interval: 1 }, new Date('2026-10-24T07:00:00Z'), '2026-10-24T08:00:00Z')).toBe('2026-10-31T08:00:00.000Z');
  });
});
