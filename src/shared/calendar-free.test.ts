import { describe, expect, test } from 'vitest';
import type { CalendarEvent } from './calendar';
import { daysBetween, durationOf, findFreeSlots, mergeBusy, minutesInto, movedTimes, resizedEnd, shiftAllDay } from './calendar-free';
import { instantAt } from './calendar-layout';

// Local times, so the tests hold in any zone the runner is in.
const at = (day: string, hhmm: string) => instantAt(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const MON = '2026-11-16';
const TUE = '2026-11-17';
const SAT = '2026-11-21';

describe('free time', () => {
  test('overlapping busy stretches merge', () => {
    expect(mergeBusy([{ start: at(MON, '10:00'), end: at(MON, '11:00') }, { start: at(MON, '09:00'), end: at(MON, '10:30') }, { start: 'x', end: 'y' }]))
      .toEqual([[Date.parse(at(MON, '09:00')), Date.parse(at(MON, '11:00'))]]);
  });

  test('the first slots inside working hours that touch nobody\'s busy time, not overlapping each other', () => {
    const busy = [{ start: at(MON, '09:00'), end: at(MON, '10:30') }, { start: at(MON, '11:00'), end: at(MON, '16:00') }];
    const slots = findFreeSlots(busy, { days: [MON, TUE], durationMin: 30 });
    expect(slots).toEqual([
      { start: at(MON, '10:30'), end: at(MON, '11:00') },
      { start: at(MON, '16:00'), end: at(MON, '16:30') },
      { start: at(MON, '16:30'), end: at(MON, '17:00') },
    ]);
  });

  test('a longer meeting skips gaps too short for it, and the weekend', () => {
    const busy = [{ start: at(MON, '09:00'), end: at(MON, '16:30') }];
    expect(findFreeSlots(busy, { days: [MON, SAT, TUE], durationMin: 60, limit: 1 })).toEqual([{ start: at(TUE, '09:00'), end: at(TUE, '10:00') }]);
  });

  test('nothing before now, and nothing when the meeting is longer than the working day', () => {
    expect(findFreeSlots([], { days: [MON], durationMin: 60, notBefore: Date.parse(at(MON, '15:20')), limit: 5 })).toEqual([{ start: at(MON, '15:30'), end: at(MON, '16:30') }]);
    expect(findFreeSlots([], { days: [MON], durationMin: 9 * 60 })).toEqual([]);
  });
});

describe('dragging', () => {
  const event = (start: string, end: string): CalendarEvent => ({ id: 'e', title: 'E', start, end, allDay: false, attendees: [], provider: 'google' });

  test('a moved event keeps its length, also across midnight', () => {
    const late = event(at(MON, '23:00'), at(TUE, '01:00'));
    expect(durationOf(late)).toBe(120);
    expect(minutesInto(TUE, late.start)).toBe(-60);
    expect(movedTimes(late, TUE, 22 * 60 + 30)).toEqual({ start: at(TUE, '22:30'), end: instantAt(TUE, 24 * 60 + 30) });
    // The evening segment can be dragged to start the day before.
    expect(movedTimes(late, TUE, -30)).toEqual({ start: instantAt(TUE, -30), end: at(TUE, '01:30') });
  });

  test('a move keeps at least 15 minutes inside the day it is dropped on', () => {
    expect(movedTimes(event(at(MON, '09:00'), at(MON, '10:00')), MON, 24 * 60)).toEqual({ start: at(MON, '23:45'), end: instantAt(MON, 24 * 60 + 45) });
    expect(movedTimes(event(at(MON, '09:00'), at(MON, '10:00')), MON, -120).start).toBe(instantAt(MON, -45));
  });

  test('a resized event is at least 15 minutes long and ends no later than midnight', () => {
    const e = event(at(MON, '09:00'), at(MON, '10:00'));
    expect(resizedEnd(e, MON, 11 * 60 + 30)).toBe(at(MON, '11:30'));
    expect(resizedEnd(e, MON, 9 * 60)).toBe(at(MON, '09:15'));
    expect(resizedEnd(e, MON, 26 * 60)).toBe(instantAt(MON, 24 * 60));
  });

  test('an all-day event moves by whole days', () => {
    const trip: CalendarEvent = { id: 't', title: 'Trip', start: '2026-11-16T00:00:00.000Z', end: '2026-11-19T00:00:00.000Z', allDay: true, attendees: [], provider: 'google' };
    expect(shiftAllDay(trip, 2)).toEqual({ start: '2026-11-18', end: '2026-11-21' });
    expect(shiftAllDay(trip, -16)).toEqual({ start: '2026-10-31', end: '2026-11-03' });
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3);
  });
});
