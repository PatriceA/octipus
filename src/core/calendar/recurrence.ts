/**
 * Repeat rules, reminders and time zones in each provider's own words. Pure:
 * every function here is unit-tested without a provider.
 *
 * Google takes an RFC 5545 RRULE line; Microsoft Graph a `patternedRecurrence`
 * (a pattern and a range). Both need the event's time zone: a weekly meeting
 * at 09:00 stays at 09:00 across a clock change only when the series is
 * anchored to the reader's zone, not to UTC.
 */
import { type CalendarRecurrence, type RecurrenceFrequency, type Weekday, WEEKDAYS } from '@/shared/calendar';

const FREQUENCIES: readonly RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 730;
const MAX_INTERVAL = 99;

/** Whether a string names a time zone this runtime knows (IANA, e.g. `Europe/Berlin`). */
export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** Validate a repeat rule at the trust boundary. Returns an error string or the clean rule. */
export function validateRecurrence(input: unknown): CalendarRecurrence | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'recurrence must be an object';
  const raw = input as Record<string, unknown>;
  if (!FREQUENCIES.includes(raw.frequency as RecurrenceFrequency)) return 'recurrence.frequency is daily, weekly, monthly or yearly';
  const out: CalendarRecurrence = { frequency: raw.frequency as RecurrenceFrequency };
  if (raw.interval !== undefined) {
    if (!Number.isInteger(raw.interval) || (raw.interval as number) < 1 || (raw.interval as number) > MAX_INTERVAL) return `recurrence.interval is a whole number from 1 to ${MAX_INTERVAL}`;
    if (raw.interval !== 1) out.interval = raw.interval as number;
  }
  if (raw.byDay !== undefined) {
    if (out.frequency !== 'weekly') return 'recurrence.byDay is only for weekly repeats';
    if (!Array.isArray(raw.byDay) || raw.byDay.length === 0 || raw.byDay.some((d) => !WEEKDAYS.includes(d as Weekday))) return 'recurrence.byDay lists weekdays: SU, MO, TU, WE, TH, FR, SA';
    out.byDay = WEEKDAYS.filter((d) => (raw.byDay as string[]).includes(d));
  }
  if (raw.until !== undefined && raw.count !== undefined) return 'a repeat ends on a date or after a number of times, not both';
  if (raw.until !== undefined) {
    if (typeof raw.until !== 'string' || !DATE.test(raw.until) || !Number.isFinite(Date.parse(raw.until))) return 'recurrence.until is a date (YYYY-MM-DD)';
    out.until = raw.until;
  }
  if (raw.count !== undefined) {
    if (!Number.isInteger(raw.count) || (raw.count as number) < 1 || (raw.count as number) > MAX_COUNT) return `recurrence.count is a whole number from 1 to ${MAX_COUNT}`;
    out.count = raw.count as number;
  }
  return out;
}

// ── Time zones ──────────────────────────────────────────────────────────────

interface Zoned { date: string; time: string; weekday: Weekday }

/** The wall-clock date, time and weekday of an instant in a zone. */
export function zoned(iso: string, zone: string): Zoned {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const weekday = (parts.weekday as string).slice(0, 2).toUpperCase() as Weekday;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}`, weekday };
}

/** `YYYY-MM-DDTHH:mm:ss` on the wall clock of `zone`: how Graph takes a time with a zone beside it. */
export const wallTime = (iso: string, zone: string) => { const z = zoned(iso, zone); return `${z.date}T${z.time}`; };

/** The instant a wall-clock time in `zone` names. Around a clock change the earlier reading wins. */
export function instantInZone(date: string, time: string, zone: string): number {
  const guess = Date.parse(`${date}T${time}Z`);
  const offset = (at: number) => Date.parse(`${wallTime(new Date(at).toISOString(), zone)}Z`) - at;
  let instant = guess - offset(guess);
  instant = guess - offset(instant);
  return instant;
}

/** Weekday of a plain date. */
export const weekdayOf = (date: string): Weekday => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];

// ── Google: RRULE ───────────────────────────────────────────────────────────

const compactDate = (date: string) => date.replace(/-/g, '');

/**
 * The RRULE line for Google. A timed series ends at the end of its `until` day
 * in its own zone (RRULE wants that in UTC); an all-day one on the date.
 */
export function googleRecurrence(rule: CalendarRecurrence, options: { allDay: boolean; timeZone: string }): string[] {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.frequency === 'weekly' && rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.until) {
    if (options.allDay) parts.push(`UNTIL=${compactDate(rule.until)}`);
    else parts.push(`UNTIL=${new Date(instantInZone(rule.until, '23:59:59', options.timeZone)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  }
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  return [`RRULE:${parts.join(';')}`];
}

/**
 * A Google `recurrence` list read back, when the page can show and change it; else `custom`.
 * A timed series ends at an instant in UTC (`UNTIL=…Z`): its date is the day
 * that instant falls on in `timeZone`, the series' own zone. Read as a UTC
 * date it came back a day late west of Greenwich, and saving it again moved
 * the end of the series.
 */
export function parseGoogleRecurrence(lines: unknown, timeZone?: string): CalendarRecurrence | 'custom' | undefined {
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  // EXDATE / RDATE lines are exceptions to a rule the page would rewrite: keep them by not offering a change.
  if (lines.length !== 1 || typeof lines[0] !== 'string' || !lines[0].startsWith('RRULE:')) return 'custom';
  const fields = Object.fromEntries(lines[0].slice(6).split(';').map((p) => p.split('=') as [string, string]));
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT', 'WKST']);
  if (Object.keys(fields).some((k) => !known.has(k))) return 'custom';
  const frequency = String(fields.FREQ ?? '').toLowerCase() as RecurrenceFrequency;
  if (!FREQUENCIES.includes(frequency)) return 'custom';
  const rule: CalendarRecurrence = { frequency };
  if (fields.INTERVAL) rule.interval = Number(fields.INTERVAL);
  if (fields.BYDAY) {
    const days = fields.BYDAY.split(',');
    // "Second Tuesday" (2TU) and the like: a rule the page does not make.
    if (frequency !== 'weekly' || days.some((d) => !WEEKDAYS.includes(d as Weekday))) return 'custom';
    rule.byDay = days as Weekday[];
  }
  if (fields.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?/.exec(fields.UNTIL);
    if (!m) return 'custom';
    rule.until = m[4] && validTimeZone(timeZone)
      ? zoned(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, timeZone).date
      : `${m[1]}-${m[2]}-${m[3]}`;
  }
  if (fields.COUNT) rule.count = Number(fields.COUNT);
  const clean = validateRecurrence(rule);
  return typeof clean === 'string' ? 'custom' : clean;
}

// ── Microsoft Graph: patternedRecurrence ────────────────────────────────────

const GRAPH_DAY: Record<Weekday, string> = { SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday' };
const FROM_GRAPH_DAY = Object.fromEntries(Object.entries(GRAPH_DAY).map(([k, v]) => [v, k as Weekday]));

/**
 * Graph's `recurrence` for a series that starts on `startDate` (in the series'
 * own zone). Monthly and yearly repeat on the start's day (and month).
 */
export function graphRecurrence(rule: CalendarRecurrence, options: { startDate: string; timeZone: string }): Record<string, unknown> {
  const [, month, day] = options.startDate.split('-').map(Number);
  const interval = rule.interval ?? 1;
  const pattern: Record<string, unknown> = {
    daily: { type: 'daily', interval },
    weekly: { type: 'weekly', interval, daysOfWeek: (rule.byDay?.length ? rule.byDay : [weekdayOf(options.startDate)]).map((d) => GRAPH_DAY[d]), firstDayOfWeek: 'monday' },
    monthly: { type: 'absoluteMonthly', interval, dayOfMonth: day },
    yearly: { type: 'absoluteYearly', interval, dayOfMonth: day, month },
  }[rule.frequency];
  const range = rule.until
    ? { type: 'endDate', startDate: options.startDate, endDate: rule.until, recurrenceTimeZone: options.timeZone }
    : rule.count
      ? { type: 'numbered', startDate: options.startDate, numberOfOccurrences: rule.count, recurrenceTimeZone: options.timeZone }
      : { type: 'noEnd', startDate: options.startDate, recurrenceTimeZone: options.timeZone };
  return { pattern, range };
}

/** A Graph `recurrence` read back, when the page can show and change it; else `custom`. */
export function parseGraphRecurrence(input: unknown): CalendarRecurrence | 'custom' | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { pattern, range } = input as { pattern?: Record<string, unknown>; range?: Record<string, unknown> };
  if (!pattern || !range) return 'custom';
  const type = { daily: 'daily', weekly: 'weekly', absoluteMonthly: 'monthly', absoluteYearly: 'yearly' }[String(pattern.type)] as RecurrenceFrequency | undefined;
  if (!type) return 'custom';
  const rule: CalendarRecurrence = { frequency: type };
  if (typeof pattern.interval === 'number' && pattern.interval > 1) rule.interval = pattern.interval;
  if (type === 'weekly') {
    const days = Array.isArray(pattern.daysOfWeek) ? pattern.daysOfWeek.map((d) => FROM_GRAPH_DAY[String(d)]) : [];
    if (!days.length || days.some((d) => !d)) return 'custom';
    rule.byDay = WEEKDAYS.filter((d) => days.includes(d));
  }
  if (range.type === 'endDate' && typeof range.endDate === 'string') rule.until = range.endDate.slice(0, 10);
  else if (range.type === 'numbered' && typeof range.numberOfOccurrences === 'number') rule.count = range.numberOfOccurrences;
  else if (range.type !== 'noEnd') return 'custom';
  const clean = validateRecurrence(rule);
  return typeof clean === 'string' ? 'custom' : clean;
}

// ── Reminders ───────────────────────────────────────────────────────────────

/** At most four weeks before; null: no reminder. */
export function validReminder(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 40_320);
}

export function googleReminders(minutes: number | null): Record<string, unknown> {
  return { useDefault: false, overrides: minutes === null ? [] : [{ method: 'popup', minutes }] };
}

export function graphReminders(minutes: number | null): Record<string, unknown> {
  return minutes === null ? { isReminderOn: false } : { isReminderOn: true, reminderMinutesBeforeStart: minutes };
}

/** A Google event's reminder: absent when it follows the calendar's default. */
export function parseGoogleReminder(reminders: unknown): number | null | undefined {
  const r = reminders as { useDefault?: boolean; overrides?: Array<{ minutes?: number }> } | undefined;
  if (!r || r.useDefault !== false) return undefined;
  const minutes = (r.overrides ?? []).map((o) => o.minutes).filter((m): m is number => typeof m === 'number');
  return minutes.length ? Math.min(...minutes) : null;
}

// ── Moving a whole series ───────────────────────────────────────────────────

/** Graph's zone-less wall time plus milliseconds, still zone-less. */
export function shiftWallTime(wall: string, deltaMs: number): string {
  const at = Date.parse(`${wall.replace(/(\.\d{3})\d*$/, '$1')}Z`);
  return new Date(at + deltaMs).toISOString().replace(/\.\d{3}Z$/, '').replace('Z', '');
}
