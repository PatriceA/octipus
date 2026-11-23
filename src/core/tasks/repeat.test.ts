import { describe, expect, test } from 'vitest';
import { nextOccurrence, normalizeRepeat, occurrenceStarted, repeatLabel, stampSeries, type TaskRepeat } from './repeat';

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

describe('series over several occurrences (review findings)', () => {
  /** Run a series: each occurrence is completed on its own due day, the next computed from it. */
  const series = (rule: TaskRepeat, first: Date, count: number, fallbackTz = 'UTC') => {
    const out = [first];
    for (let i = 1; i < count; i += 1) {
      const prev = out[i - 1];
      out.push(nextOccurrence(rule, prev, new Date(prev.getTime() - 60_000), fallbackTz));
    }
    return out;
  };
  const berlinDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const berlinTime = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: BERLIN, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);

  test('a Berlin all-day daily series keeps one occurrence per day across the DST change, in the zone stamped on the rule', () => {
    const rule = stampSeries({ unit: 'day', interval: 1 }, null, BERLIN);
    // Due Friday 23 October 2026 (summer time), end of day Berlin; the clocks go back on the 25th.
    const days = series(rule, new Date('2026-10-23T21:59:59.999Z'), 6, 'UTC');
    expect(days.map(berlinDay)).toEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
    expect(new Set(days.map(berlinTime))).toEqual(new Set(['23:59:59']));
  });

  test('a 09:00 daily series stays at 09:00 local across DST, whatever the fallback zone', () => {
    const rule = stampSeries({ unit: 'day', interval: 1 }, null, BERLIN);
    const days = series(rule, new Date('2026-03-27T08:00:00Z'), 5, 'America/New_York');
    expect(days.map(berlinTime)).toEqual(['09:00:00', '09:00:00', '09:00:00', '09:00:00', '09:00:00']);
    expect(days.map(berlinDay)).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
  });

  test('a monthly series started on the 31st keeps the 31st whenever a month has one', () => {
    const first = new Date('2027-01-31T10:00:00Z');
    const rule = stampSeries({ unit: 'month', interval: 1 }, first, 'UTC');
    expect(rule.anchorDay).toBe(31);
    const days = series(rule, first, 6);
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
  });

  test('a yearly series on 29 February comes back on the 29th in leap years', () => {
    const first = new Date('2028-02-29T10:00:00Z');
    const rule = stampSeries({ unit: 'year', interval: 1 }, first, 'UTC');
    const days = series(rule, first, 5);
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });

  test('stampSeries keeps a series in the zone it was set up in, and re-anchors on a new due date', () => {
    const rule = stampSeries({ unit: 'month', interval: 1, tz: 'Asia/Tokyo' }, new Date('2026-11-14T20:00:00Z'), BERLIN);
    expect(rule).toEqual({ unit: 'month', interval: 1, tz: 'Asia/Tokyo', anchorDay: 15 });
    expect(stampSeries({ unit: 'week', interval: 1 }, null, 'nowhere/zone')).toEqual({ unit: 'week', interval: 1, tz: 'UTC' });
  });

  test('normalizeRepeat keeps a valid echoed zone and anchor, drops bad ones', () => {
    expect(normalizeRepeat({ unit: 'month', tz: BERLIN, anchorDay: 31 })).toEqual({ unit: 'month', interval: 1, tz: BERLIN, anchorDay: 31 });
    expect(normalizeRepeat({ unit: 'day', tz: 'Mars/Base', anchorDay: 31 })).toEqual({ unit: 'day', interval: 1 });
  });

  test('occurrenceStarted: from the start of the due day in the series zone', () => {
    const rule = { unit: 'day', interval: 1, tz: BERLIN } as TaskRepeat;
    const due = new Date('2026-11-24T22:59:59.999Z'); // end of Tuesday in Berlin
    expect(occurrenceStarted({ repeat: rule, dueAt: due }, new Date('2026-11-23T22:30:00Z'))).toBe(false); // Monday 23:30 Berlin
    expect(occurrenceStarted({ repeat: rule, dueAt: due }, new Date('2026-11-23T23:30:00Z'))).toBe(true); // Tuesday 00:30 Berlin
    expect(occurrenceStarted({ repeat: null, dueAt: due }, new Date('2020-01-01'))).toBe(true);
    expect(occurrenceStarted({ repeat: rule, dueAt: null }, new Date('2020-01-01'))).toBe(true);
  });
});
