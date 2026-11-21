/**
 * Where events go on a calendar grid. Pure and dependency-free: the Calendar
 * page draws from this, and the unit tests need no browser.
 *
 * A "day" is a local calendar date as `YYYY-MM-DD`. Timed events are placed by
 * the reader's local clock; an all-day event is the date its ISO start names
 * (see CalendarEvent.start), the same for every reader.
 */
import type { CalendarEvent } from './calendar';

const pad = (n: number) => String(n).padStart(2, '0');

/** The local date of an instant. */
export const dayOf = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Local noon of a day: safe to add days to across a clock change. */
export const noonOf = (day: string): Date => new Date(`${day}T12:00:00`);

export function addDays(day: string, amount: number): string {
  const date = noonOf(day);
  date.setDate(date.getDate() + amount);
  return dayOf(date);
}

/** The first day of the week `day` falls in. `firstDay`: 0 = Sunday … 6 = Saturday. */
export function weekStart(day: string, firstDay: number): string {
  const date = noonOf(day);
  if (!Number.isFinite(+date)) return day;
  return addDays(day, -((date.getDay() - firstDay + 7) % 7));
}

/** `count` consecutive days from `first`. */
export const daysFrom = (first: string, count: number): string[] => Array.from({ length: count }, (_, i) => addDays(first, i));

/** The six weeks a month view shows: from the week holding the 1st. */
export function monthGrid(day: string, firstDay: number): string[] {
  return daysFrom(weekStart(`${day.slice(0, 8)}01`, firstDay), 42);
}

/** First and last (exclusive) day of an all-day event. */
export function allDayRange(event: CalendarEvent): { first: string; end: string } {
  const first = event.start.slice(0, 10);
  const end = event.end ? event.end.slice(0, 10) : '';
  return { first, end: end > first ? end : addDays(first, 1) };
}

/** Whether an event touches a day. */
export function onDay(event: CalendarEvent, day: string): boolean {
  if (event.allDay) {
    const { first, end } = allDayRange(event);
    return day >= first && day < end;
  }
  const dayStart = +new Date(`${day}T00:00:00`);
  const dayEnd = +new Date(`${addDays(day, 1)}T00:00:00`);
  const start = Date.parse(event.start);
  const end = event.end ? Date.parse(event.end) : start;
  // An event ending exactly at midnight does not reach into the next day.
  return start < dayEnd && (end > dayStart || start >= dayStart);
}

/** The part of a timed event that falls on one day, in minutes from that day's midnight. */
export interface Segment<E extends CalendarEvent = CalendarEvent> {
  event: E;
  startMin: number;
  endMin: number;
  /** The event began on an earlier day / runs on into a later one. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Shown at least this tall, so a five-minute event can still be read and pressed. */
export const MIN_SEGMENT_MIN = 20;

export function segmentsForDay<E extends CalendarEvent>(events: E[], day: string): Segment<E>[] {
  const dayStart = +new Date(`${day}T00:00:00`);
  const dayEnd = +new Date(`${addDays(day, 1)}T00:00:00`);
  const dayMinutes = Math.round((dayEnd - dayStart) / 60_000);
  const out: Segment<E>[] = [];
  for (const event of events) {
    if (event.allDay || !onDay(event, day)) continue;
    const start = Date.parse(event.start);
    const end = Math.max(event.end ? Date.parse(event.end) : start, start);
    const startMin = Math.max(0, Math.round((start - dayStart) / 60_000));
    const endMin = Math.min(dayMinutes, Math.round((end - dayStart) / 60_000));
    out.push({ event, startMin, endMin: Math.max(endMin, Math.min(dayMinutes, startMin + MIN_SEGMENT_MIN)), continuesBefore: start < dayStart, continuesAfter: end > dayEnd });
  }
  return out.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
}

/** A segment with its column among the events it overlaps. */
export interface Placed<E extends CalendarEvent = CalendarEvent> extends Segment<E> {
  /** 0-based column, and how many columns its group of overlapping events needs. */
  column: number;
  columns: number;
  /** Columns it may fill: its own, plus the ones to its right that are empty while it runs. */
  span: number;
}

/**
 * Overlapping events side by side. Events that overlap, directly or through
 * a chain of others, form a group; each takes the first column free at its
 * start, and the whole group is as wide as its busiest moment.
 */
export function layoutDay<E extends CalendarEvent>(segments: Segment<E>[]): Placed<E>[] {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: Placed<E>[] = [];
  let group: Placed<E>[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const close = () => {
    const columns = columnEnds.length;
    for (const item of group) {
      item.columns = columns;
      // Widen into the columns on the right that nothing occupies during this event.
      while (item.column + item.span < columns && !group.some((o) => o.column === item.column + item.span && o.startMin < item.endMin && o.endMin > item.startMin)) item.span++;
    }
    placed.push(...group);
    group = [];
    columnEnds = [];
  };
  for (const segment of sorted) {
    if (group.length && segment.startMin >= groupEnd) close();
    let column = columnEnds.findIndex((end) => end <= segment.startMin);
    if (column < 0) column = columnEnds.length;
    columnEnds[column] = segment.endMin;
    groupEnd = Math.max(groupEnd, segment.endMin);
    group.push({ ...segment, column, columns: 1, span: 1 });
  }
  close();
  return placed;
}

/** An all-day event across the shown days: which day it starts at, how many it spans, which row. */
export interface Span<E extends CalendarEvent = CalendarEvent> {
  event: E;
  /** Index into the shown days. */
  start: number;
  length: number;
  row: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** All-day events as bars over consecutive `days`, stacked without overlap. */
export function layoutAllDay<E extends CalendarEvent>(events: E[], days: string[]): Span<E>[] {
  if (!days.length) return [];
  const firstShown = days[0];
  const endShown = addDays(days[days.length - 1], 1);
  const bars = events.filter((e) => e.allDay).map((event) => ({ event, ...allDayRange(event) }))
    .filter((b) => b.first < endShown && b.end > firstShown)
    .sort((a, b) => a.first.localeCompare(b.first) || b.end.localeCompare(a.end) || a.event.title.localeCompare(b.event.title));
  const rowEnds: number[] = [];
  return bars.map(({ event, first, end }) => {
    const start = Math.max(0, days.indexOf(first < firstShown ? firstShown : first));
    const last = end > endShown ? days.length : days.indexOf(end) < 0 ? days.length : days.indexOf(end);
    let row = rowEnds.findIndex((taken) => taken <= start);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = last;
    return { event, start, length: Math.max(1, last - start), row, continuesBefore: first < firstShown, continuesAfter: end > endShown };
  });
}

/** Snap minutes from midnight to the grid (15 minutes by default), within the day. */
export const snapMinutes = (minutes: number, step = 15): number => Math.max(0, Math.min(24 * 60, Math.round(minutes / step) * step));

/** The instant `minutes` after local midnight of `day`, as an ISO string. */
export function instantAt(day: string, minutes: number): string {
  const date = new Date(`${day}T00:00:00`);
  date.setMinutes(minutes);
  return date.toISOString();
}
