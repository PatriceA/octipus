import { describe, expect, test } from 'vitest';
import {
  googleRecurrence, googleReminders, graphRecurrence, graphReminders, instantInZone, parseGoogleRecurrence, parseGoogleReminder, parseGraphRecurrence,
  shiftWallTime, validateRecurrence, validReminder, validTimeZone, wallTime, weekdayOf, zoned,
} from './recurrence';

describe('validateRecurrence', () => {
  test('a clean rule passes; an interval of 1 is dropped and weekdays are put in order', () => {
    expect(validateRecurrence({ frequency: 'weekly', interval: 1, byDay: ['FR', 'MO'], until: '2027-01-31' })).toEqual({ frequency: 'weekly', byDay: ['MO', 'FR'], until: '2027-01-31' });
    expect(validateRecurrence({ frequency: 'monthly', interval: 2, count: 6 })).toEqual({ frequency: 'monthly', interval: 2, count: 6 });
  });
  test.each([
    [{ frequency: 'hourly' }, /frequency/],
    [{ frequency: 'daily', interval: 0 }, /interval/],
    [{ frequency: 'daily', byDay: ['MO'] }, /only for weekly/],
    [{ frequency: 'weekly', byDay: ['XX'] }, /weekdays/],
    [{ frequency: 'daily', until: '2027-01-31', count: 3 }, /not both/],
    [{ frequency: 'daily', until: '31.01.2027' }, /until/],
    [{ frequency: 'daily', count: 10_000 }, /count/],
    [[], /object/],
  ])('%j is refused', (input, message) => {
    expect(validateRecurrence(input)).toMatch(message);
  });
});

describe('time zones', () => {
  test('wall clock, weekday and the instant a wall time names, across a clock change', () => {
    expect(zoned('2026-11-16T08:00:00Z', 'Europe/Berlin')).toEqual({ date: '2026-11-16', time: '09:00:00', weekday: 'MO' });
    expect(wallTime('2026-07-01T07:00:00Z', 'Europe/Berlin')).toBe('2026-07-01T09:00:00');
    expect(new Date(instantInZone('2026-12-31', '23:59:59', 'Europe/Berlin')).toISOString()).toBe('2026-12-31T22:59:59.000Z');
    expect(new Date(instantInZone('2026-07-31', '23:59:59', 'America/New_York')).toISOString()).toBe('2026-08-01T03:59:59.000Z');
    expect(weekdayOf('2026-11-21')).toBe('SA');
  });
  test('only real IANA names count as a zone', () => {
    expect(validTimeZone('Europe/Berlin')).toBe(true);
    expect(validTimeZone('UTC')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
    expect(validTimeZone('Europe/Berlin; DROP')).toBe(false);
  });
});

describe('Google RRULE', () => {
  test('weekly on chosen days, ending at the end of the until day in the event\'s zone (in UTC)', () => {
    expect(googleRecurrence({ frequency: 'weekly', interval: 2, byDay: ['MO', 'WE'], until: '2026-12-31' }, { allDay: false, timeZone: 'Europe/Berlin' }))
      .toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z']);
  });
  test('all-day series end on a plain date; a count ends it after n times', () => {
    expect(googleRecurrence({ frequency: 'yearly', until: '2030-05-01' }, { allDay: true, timeZone: 'UTC' })).toEqual(['RRULE:FREQ=YEARLY;UNTIL=20300501']);
    expect(googleRecurrence({ frequency: 'daily', count: 5 }, { allDay: false, timeZone: 'UTC' })).toEqual(['RRULE:FREQ=DAILY;COUNT=5']);
  });
  test('read back: rules the page makes come back the same, others are custom', () => {
    expect(parseGoogleRecurrence(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z'])).toEqual({ frequency: 'weekly', interval: 2, byDay: ['MO', 'WE'], until: '2026-12-31' });
    expect(parseGoogleRecurrence(['RRULE:FREQ=DAILY;COUNT=5'])).toEqual({ frequency: 'daily', count: 5 });
    expect(parseGoogleRecurrence(['RRULE:FREQ=MONTHLY;BYDAY=2TU'])).toBe('custom');
    expect(parseGoogleRecurrence(['RRULE:FREQ=WEEKLY', 'EXDATE;VALUE=DATE:20261201'])).toBe('custom');
    expect(parseGoogleRecurrence(['RRULE:FREQ=MINUTELY'])).toBe('custom');
    expect(parseGoogleRecurrence(undefined)).toBeUndefined();
  });
});

describe('Graph patternedRecurrence', () => {
  test('weekly defaults to the start\'s weekday; monthly and yearly repeat on the start date', () => {
    expect(graphRecurrence({ frequency: 'weekly' }, { startDate: '2026-11-18', timeZone: 'Europe/Berlin' })).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'], firstDayOfWeek: 'monday' },
      range: { type: 'noEnd', startDate: '2026-11-18', recurrenceTimeZone: 'Europe/Berlin' },
    });
    expect(graphRecurrence({ frequency: 'monthly', count: 3 }, { startDate: '2026-11-18', timeZone: 'UTC' })).toMatchObject({
      pattern: { type: 'absoluteMonthly', dayOfMonth: 18 }, range: { type: 'numbered', numberOfOccurrences: 3 },
    });
    expect(graphRecurrence({ frequency: 'yearly', until: '2030-11-18' }, { startDate: '2026-11-18', timeZone: 'UTC' })).toMatchObject({
      pattern: { type: 'absoluteYearly', dayOfMonth: 18, month: 11 }, range: { type: 'endDate', endDate: '2030-11-18' },
    });
  });
  test('read back', () => {
    expect(parseGraphRecurrence({ pattern: { type: 'weekly', interval: 1, daysOfWeek: ['friday', 'monday'] }, range: { type: 'endDate', endDate: '2027-01-01' } }))
      .toEqual({ frequency: 'weekly', byDay: ['MO', 'FR'], until: '2027-01-01' });
    expect(parseGraphRecurrence({ pattern: { type: 'relativeMonthly', daysOfWeek: ['tuesday'], index: 'second' }, range: { type: 'noEnd' } })).toBe('custom');
    expect(parseGraphRecurrence(null)).toBeUndefined();
  });
});

describe('reminders', () => {
  test('in each provider\'s words, and read back', () => {
    expect(googleReminders(10)).toEqual({ useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
    expect(googleReminders(null)).toEqual({ useDefault: false, overrides: [] });
    expect(graphReminders(0)).toEqual({ isReminderOn: true, reminderMinutesBeforeStart: 0 });
    expect(graphReminders(null)).toEqual({ isReminderOn: false });
    expect(parseGoogleReminder({ useDefault: true })).toBeUndefined();
    expect(parseGoogleReminder({ useDefault: false, overrides: [{ minutes: 30 }, { minutes: 10 }] })).toBe(10);
    expect(parseGoogleReminder({ useDefault: false, overrides: [] })).toBeNull();
    expect(validReminder(null)).toBe(true);
    expect(validReminder(-1)).toBe(false);
    expect(validReminder(1.5)).toBe(false);
  });
});

test('a zone-less Graph wall time is shifted as wall time', () => {
  expect(shiftWallTime('2026-11-16T09:00:00.0000000', 60 * 60_000)).toBe('2026-11-16T10:00:00');
  expect(shiftWallTime('2026-11-16T23:30:00', 60 * 60_000)).toBe('2026-11-17T00:30:00');
});
