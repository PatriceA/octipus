import { describe, expect, test } from 'vitest';
import type { CalendarEvent } from './calendar';
import { addDays, allDayRange, daysFrom, instantAt, layoutAllDay, layoutDay, monthGrid, onDay, segmentsForDay, snapMinutes, weekStart } from './calendar-layout';

const DAY = '2026-11-18'; // a Wednesday
/** A timed event on DAY in the test machine's own zone, so the cases hold anywhere. */
const timed = (id: string, from: string, to: string, day = DAY, endDay = day): CalendarEvent => ({
  id, title: id, provider: 'google', allDay: false, attendees: [],
  start: new Date(`${day}T${from}:00`).toISOString(), end: new Date(`${endDay}T${to}:00`).toISOString(),
});
const allDay = (id: string, first: string, end?: string): CalendarEvent => ({
  id, title: id, provider: 'google', allDay: true, attendees: [], start: `${first}T00:00:00.000Z`, ...(end ? { end: `${end}T00:00:00.000Z` } : {}),
});
const columns = (events: CalendarEvent[]) => Object.fromEntries(layoutDay(segmentsForDay(events, DAY)).map((p) => [p.event.id, `${p.column}/${p.columns}`]));

describe('days and weeks', () => {
  test('a week starts on the reader\'s first weekday', () => {
    expect(weekStart(DAY, 1)).toBe('2026-11-16');
    expect(weekStart(DAY, 0)).toBe('2026-11-15');
    expect(weekStart('2026-11-16', 1)).toBe('2026-11-16');
    expect(weekStart('2026-11-15', 1)).toBe('2026-11-09');
  });
  test('adding days crosses months, years and clock changes', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(daysFrom('2026-02-27', 3)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
  test('a month view is six whole weeks from the week of the 1st', () => {
    const grid = monthGrid(DAY, 1);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-10-26');
    expect(grid[41]).toBe('2026-12-06');
  });
});

describe('overlapping events', () => {
  test('events that do not overlap keep the full width', () => {
    expect(columns([timed('a', '09:00', '10:00'), timed('b', '10:00', '11:00')])).toEqual({ a: '0/1', b: '0/1' });
  });
  test('two at once sit side by side', () => {
    expect(columns([timed('a', '09:00', '10:30'), timed('b', '10:00', '11:00')])).toEqual({ a: '0/2', b: '1/2' });
  });
  test('a column is reused once free, and the group is as wide as its busiest moment', () => {
    expect(columns([timed('long', '09:00', '12:00'), timed('b', '09:30', '10:00'), timed('c', '10:00', '11:00'), timed('d', '10:15', '10:45')]))
      .toEqual({ long: '0/3', b: '1/3', c: '1/3', d: '2/3' });
  });
  test('an event widens into columns that are empty while it runs', () => {
    const placed = layoutDay(segmentsForDay([timed('long', '09:00', '12:00'), timed('b', '09:30', '10:00'), timed('c', '10:00', '11:00'), timed('d', '10:15', '10:45')], DAY));
    expect(Object.fromEntries(placed.map((p) => [p.event.id, p.span]))).toEqual({ long: 1, b: 2, c: 1, d: 1 });
  });
  test('a later, separate group is laid out on its own', () => {
    expect(columns([timed('a', '09:00', '10:00'), timed('b', '09:00', '10:00'), timed('c', '14:00', '15:00')])).toEqual({ a: '0/2', b: '1/2', c: '0/1' });
  });
  test('a very short event still takes room, so the next one moves aside', () => {
    expect(columns([timed('blip', '09:00', '09:05'), timed('b', '09:10', '10:00')])).toEqual({ blip: '0/2', b: '1/2' });
  });
});

describe('events across days', () => {
  test('an event over midnight is cut at the day\'s edge on both days', () => {
    const night = timed('night', '22:00', '02:00', DAY, addDays(DAY, 1));
    expect(segmentsForDay([night], DAY)[0]).toMatchObject({ startMin: 22 * 60, endMin: 24 * 60, continuesBefore: false, continuesAfter: true });
    expect(segmentsForDay([night], addDays(DAY, 1))[0]).toMatchObject({ startMin: 0, endMin: 120, continuesBefore: true, continuesAfter: false });
  });
  test('an event ending at midnight does not reach into the next day', () => {
    const late = timed('late', '22:00', '00:00', DAY, addDays(DAY, 1));
    expect(onDay(late, DAY)).toBe(true);
    expect(onDay(late, addDays(DAY, 1))).toBe(false);
  });
  test('an all-day event is its named date for every reader; its end is exclusive', () => {
    const holiday = allDay('holiday', DAY, addDays(DAY, 1));
    expect(allDayRange(holiday)).toEqual({ first: DAY, end: '2026-11-19' });
    expect(onDay(holiday, DAY)).toBe(true);
    expect(onDay(holiday, '2026-11-19')).toBe(false);
    expect(onDay(holiday, '2026-11-17')).toBe(false);
    expect(allDayRange(allDay('no-end', DAY))).toEqual({ first: DAY, end: '2026-11-19' });
    expect(segmentsForDay([holiday], DAY)).toEqual([]);
  });
});

describe('all-day bars', () => {
  const week = daysFrom('2026-11-16', 7);
  test('bars span their days, are clipped to the week and stack without overlap', () => {
    const spans = layoutAllDay([
      allDay('trip', '2026-11-14', '2026-11-18'),
      allDay('fair', '2026-11-17', '2026-11-25'),
      allDay('holiday', '2026-11-19', '2026-11-20'),
      timed('meeting', '09:00', '10:00'),
    ], week);
    expect(spans.map((s) => [s.event.id, s.start, s.length, s.row, s.continuesBefore, s.continuesAfter])).toEqual([
      ['trip', 0, 2, 0, true, false],
      ['fair', 1, 6, 1, false, true],
      ['holiday', 3, 1, 0, false, false],
    ]);
  });
  test('events outside the shown days are left out', () => {
    expect(layoutAllDay([allDay('before', '2026-11-10', '2026-11-16'), allDay('after', '2026-11-23')], week)).toEqual([]);
  });
});

test('times snap to the quarter hour and stay within the day', () => {
  expect(snapMinutes(548)).toBe(555);
  expect(snapMinutes(-20)).toBe(0);
  expect(snapMinutes(2000)).toBe(1440);
  expect(instantAt(DAY, 9 * 60 + 30)).toBe(new Date(`${DAY}T09:30:00`).toISOString());
});
