/**
 * Finding free time, and the times a dragged event lands on. Pure, so the
 * page and the tests share them.
 */
import type { BusyInterval, CalendarEvent } from './calendar';
import { addDays, allDayRange, instantAt } from './calendar-layout';

export interface FreeSlot { start: string; end: string }

export interface FindSlotsOptions {
  /** Days (`YYYY-MM-DD`, the reader's local dates) to look in, in order. */
  days: string[];
  /** Length of the event, in minutes. */
  durationMin: number;
  /** Working hours, minutes after local midnight. */
  dayStartMin?: number;
  dayEndMin?: number;
  /** Candidate starts are this far apart. */
  stepMin?: number;
  /** No slot starts before this instant (ms; usually now). */
  notBefore?: number;
  /** How many slots to return. */
  limit?: number;
  /** Skip Saturdays and Sundays. */
  weekdaysOnly?: boolean;
}

/** Merge overlapping intervals into sorted, disjoint ones (ms). */
export function mergeBusy(intervals: BusyInterval[]): Array<[number, number]> {
  const spans = intervals
    .map((i) => [Date.parse(i.start), Date.parse(i.end)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

/** The first free slots of `durationMin` within working hours that touch no busy interval. */
export function findFreeSlots(busy: BusyInterval[], options: FindSlotsOptions): FreeSlot[] {
  const { durationMin, dayStartMin = 9 * 60, dayEndMin = 17 * 60, stepMin = 15, notBefore = -Infinity, limit = 3, weekdaysOnly = true } = options;
  if (durationMin <= 0 || dayEndMin - dayStartMin < durationMin) return [];
  const merged = mergeBusy(busy);
  const free = (from: number, to: number) => !merged.some(([a, b]) => a < to && b > from);
  const out: FreeSlot[] = [];
  for (const day of options.days) {
    if (weekdaysOnly && [0, 6].includes(new Date(`${day}T12:00:00`).getDay())) continue;
    for (let minute = dayStartMin; minute + durationMin <= dayEndMin; minute += stepMin) {
      const start = Date.parse(instantAt(day, minute));
      const end = start + durationMin * 60_000;
      if (start < notBefore || !free(start, end)) continue;
      out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      if (out.length >= limit) return out;
      // The next suggestion starts after this one ends: different times, not overlapping ones.
      minute += durationMin - stepMin;
    }
  }
  return out;
}

/** `count` days from `first`. */
export const nextDays = (first: string, count: number) => Array.from({ length: count }, (_, i) => addDays(first, i));

// ── Dragging ──────────────────────────────────────────────────────────────

const DAY_MIN = 24 * 60;

/** Minutes from local midnight of `day` to an instant; negative before that day, past 1440 after it. */
export function minutesInto(day: string, iso: string): number {
  return Math.round((Date.parse(iso) - Date.parse(instantAt(day, 0))) / 60_000);
}

/** Length of a timed event in minutes (an hour when it names no end). */
export const durationOf = (event: Pick<CalendarEvent, 'start' | 'end'>) =>
  event.end ? Math.max(1, Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000)) : 60;

/**
 * Where a timed event lands when its start is dropped `startMin` minutes after
 * midnight of `day`. The length stays; an event may start the evening before
 * or run past midnight, but it keeps at least 15 minutes inside `day`.
 */
export function movedTimes(event: Pick<CalendarEvent, 'start' | 'end'>, day: string, startMin: number): { start: string; end: string } {
  const length = durationOf(event);
  const clamped = Math.max(15 - length, Math.min(DAY_MIN - 15, startMin));
  const start = instantAt(day, clamped);
  return { start, end: new Date(Date.parse(start) + length * 60_000).toISOString() };
}

/** The new end of a timed event whose bottom edge is dropped at `endMin` on `day`: at least 15 minutes long. */
export function resizedEnd(event: Pick<CalendarEvent, 'start'>, day: string, endMin: number): string {
  const end = Date.parse(instantAt(day, Math.min(DAY_MIN, endMin)));
  return new Date(Math.max(end, Date.parse(event.start) + 15 * 60_000)).toISOString();
}

/** An all-day event moved by whole days: its new first day and exclusive end. */
export function shiftAllDay(event: CalendarEvent, days: number): { start: string; end: string } {
  const { first, end } = allDayRange(event);
  return { start: addDays(first, days), end: addDays(end, days) };
}

/** Whole days between two local dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000);
}
