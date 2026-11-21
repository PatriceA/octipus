import type { CalendarEvent, CalendarInfo, CalendarPreferences, CalendarProvider } from '../../../src/shared/calendar';
import { addDays, allDayRange, dayOf, monthGrid, noonOf, weekStart } from '../../../src/shared/calendar-layout';

export type CalendarViewName = 'day' | 'week' | 'month' | 'agenda';
export const VIEWS: ReadonlyArray<{ id: CalendarViewName; label: string; key: string }> = [
  { id: 'day', label: 'Day', key: 'd' },
  { id: 'week', label: 'Week', key: 'w' },
  { id: 'month', label: 'Month', key: 'm' },
  { id: 'agenda', label: 'Agenda', key: 'a' },
];

export interface EventsResponse {
  events: CalendarEvent[];
  providers: CalendarProvider[];
  partial: boolean;
  truncated?: boolean;
  failedCalendars?: string[];
}

export interface CalendarsResponse {
  calendars: CalendarInfo[];
  providers: CalendarProvider[];
  partial: boolean;
  preferences: CalendarPreferences;
  /** null: Microsoft is not connected. false: connected before shared calendars were asked for. */
  microsoftSharedAccess: boolean | null;
}

/** What the event dialog sends. */
export interface EventDraft {
  provider: CalendarProvider;
  /** The connected account of the provider, when it is not the default one. */
  account?: string;
  calendarId?: string;
  title: string;
  allDay: boolean;
  /** ISO instant, or a date for an all-day event. */
  start: string;
  /** ISO instant, or the exclusive end date for an all-day event. */
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
}

/** A time the reader picked on the grid for a new event. */
export interface NewEventSeed { day: string; startMin?: number; endMin?: number; allDay?: boolean }

export const providerName = (provider: CalendarProvider) => (provider === 'google' ? 'Google' : 'Microsoft 365');

/** One event among all calendars: an id is only unique within its calendar. */
export const eventKey = (event: CalendarEvent) => (event.account ? `${event.provider}:${event.account}:${event.calendarId ?? ''}:${event.id}` : `${event.provider}:${event.calendarId ?? ''}:${event.id}`);

/** For calendars the provider gives no colour. */
const FALLBACK_COLORS: Record<CalendarProvider, string> = { google: '#2f7f79', microsoft: '#3f76b5' };
export const colorOf = (item: { color?: string; provider: CalendarProvider }) => item.color ?? FALLBACK_COLORS[item.provider];

/** A tinted block in the calendar's colour that stays readable on a light and a dark surface. */
export const tint = (color: string, strength = 16) => `color-mix(in srgb, ${color} ${strength}%, var(--color-surface))`;

/** First day of the reader's week (0 = Sunday … 6 = Saturday); Monday where the browser cannot say. */
export function firstWeekday(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    return typeof first === 'number' ? first % 7 : 1;
  } catch { return 1; }
}

export const today = () => dayOf(new Date());

/** The days a view shows, starting from the day the reader is on. */
export function viewDays(view: CalendarViewName, anchor: string, firstDay: number): string[] {
  if (view === 'day') return [anchor];
  if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor, firstDay), i));
  if (view === 'month') return monthGrid(anchor, firstDay);
  return Array.from({ length: 14 }, (_, i) => addDays(anchor, i));
}

/** The day to be on after stepping a view back (-1) or forward (+1). */
export function stepAnchor(view: CalendarViewName, anchor: string, direction: 1 | -1): string {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  if (view === 'agenda') return addDays(anchor, 14 * direction);
  const date = noonOf(`${anchor.slice(0, 8)}01`);
  date.setMonth(date.getMonth() + direction);
  return dayOf(date);
}

const fmt = (date: Date, options: Intl.DateTimeFormatOptions) => date.toLocaleDateString(undefined, options);

/** "16 – 22 November 2026", "November 2026", "Wednesday, 18 November 2026". */
export function rangeTitle(view: CalendarViewName, anchor: string, days: string[]): string {
  if (view === 'month') return fmt(noonOf(anchor), { month: 'long', year: 'numeric' });
  if (view === 'day') return fmt(noonOf(anchor), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const first = noonOf(days[0]);
  const last = noonOf(days[days.length - 1]);
  return span(first, last, { day: 'numeric', month: 'long', year: 'numeric' }, () => `${fmt(first, { day: 'numeric', month: 'short' })} – ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`);
}

export const clock = (date: Date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A span in the reader's own style, without repeating what both ends share ("9:00 – 10:00 AM", "15 – 21 November 2026"). */
function span(first: Date, last: Date, options: Intl.DateTimeFormatOptions, fallback: () => string): string {
  try { return new Intl.DateTimeFormat(undefined, options).formatRange(first, last); } catch { return fallback(); }
}

/** "09:00 – 10:00"; the end names its date only when the event runs into another day. */
export function timeLabel(event: CalendarEvent): string {
  if (event.allDay) {
    const { first, end } = allDayRange(event);
    const last = addDays(end, -1);
    const day = (d: string) => fmt(noonOf(d), { weekday: 'short', day: 'numeric', month: 'short' });
    return last > first ? `${day(first)} – ${day(last)}, all day` : `${day(first)}, all day`;
  }
  const start = new Date(event.start);
  if (!event.end) return clock(start);
  const end = new Date(event.end);
  const otherDay = dayOf(end) !== dayOf(start);
  if (otherDay) return `${clock(start)} – ${fmt(end, { weekday: 'short', month: 'short', day: 'numeric' })}, ${clock(end)}`;
  return span(start, end, { hour: 'numeric', minute: '2-digit' }, () => `${clock(start)} – ${clock(end)}`);
}

/** Date and time for the event card: "Wed, 18 Nov · 09:00 – 10:00". */
export function whenLabel(event: CalendarEvent): string {
  if (event.allDay) return timeLabel(event);
  return `${fmt(new Date(event.start), { weekday: 'short', day: 'numeric', month: 'short' })} · ${timeLabel(event)}`;
}

/** Hour labels in the reader's own clock style ("9 AM" or "09:00"). */
export function hourLabel(hour: number): string {
  const date = new Date(2000, 0, 1, hour);
  return date.toLocaleTimeString([], { hour: 'numeric', ...(usesHour12() ? {} : { minute: '2-digit' }) });
}
function usesHour12(): boolean {
  try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true; } catch { return false; }
}

/** `YYYY-MM-DDTHH:mm` in local time, for a datetime-local field. */
export function localInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dayOf(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const RESPONSE_LABEL = { accepted: 'Accepted', declined: 'Declined', tentative: 'Maybe', needsAction: 'Not answered' } as const;

export const buttonQuiet = 'px-3 py-1.5 text-sm border border-outline-variant/40 rounded-full hover:bg-surface-container-high text-on-surface disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer transition-colors';
export const buttonPrimary = 'px-3 py-1.5 text-sm bg-primary text-on-primary rounded-full hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer';
export const buttonDanger = 'px-3 py-1.5 text-sm bg-error text-on-error rounded-full hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer';
export const fieldInput = 'mt-1 block w-full rounded-xs border border-outline-variant/60 bg-surface px-2.5 py-1.5 text-sm text-on-surface';
