/**
 * Repeating to-dos (Microsoft To Do's "Repeat"). A rule is stored on the task
 * (`tasks.repeat`, jsonb); completing a repeating to-do creates the next
 * occurrence once (ScopedTaskRepo.update, whoever completes it: the user, the
 * API or an agent's tasks tool). Pure — the web bundle and the repo share it.
 *
 *   { unit: 'day',   interval: 1 }                      every day
 *   { unit: 'week',  interval: 1, weekdays: [1..5] }     weekdays
 *   { unit: 'week',  interval: 1 }                      every week (same weekday)
 *   { unit: 'week',  interval: 2, weekdays: [2, 4] }    every 2 weeks on Tue and Thu
 *   { unit: 'month', interval: 1 }                      every month (same day, clamped)
 *   { unit: 'year',  interval: 1 }                      every year
 *
 * `weekdays` are 0 = Sunday … 6 = Saturday, only with unit 'week'.
 *
 * The server stamps two more fields on a stored rule (`stampSeries`), so a
 * series is computed the same way for its whole life: `tz`, the IANA zone the
 * series runs in (its due days and times are wall-clock in that zone, across
 * DST), and for monthly and yearly rules `anchorDay`, the day of the month it
 * was set on — a series started on the 31st comes back on the 31st whenever a
 * month has one, not on the 28th forever after February.
 */
import { isValidTimezone, localDateIn, localDateTimeIn, localWallClock } from './rank';

export const REPEAT_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];

export interface TaskRepeat {
  unit: RepeatUnit;
  /** Every `interval` units, 1..365. */
  interval: number;
  /** With unit 'week': the days it falls on (0 = Sunday). Absent = the due date's weekday. */
  weekdays?: number[];
  /** The zone the series is computed in (stamped by the server). */
  tz?: string;
  /** Month and year rules: the day of the month the series keeps (stamped by the server). */
  anchorDay?: number;
}

/** The presets the pickers and the capture parser offer. */
export const REPEAT_PRESETS = {
  daily: { unit: 'day', interval: 1 },
  weekdays: { unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] },
  weekly: { unit: 'week', interval: 1 },
  monthly: { unit: 'month', interval: 1 },
  yearly: { unit: 'year', interval: 1 },
} as const satisfies Record<string, TaskRepeat>;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Validate a rule from a client or an agent. null / undefined → null (no
 * repeat). Throws with a message fit for a 400 or the tool's `error` field.
 */
export function normalizeRepeat(value: unknown): TaskRepeat | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const preset = (REPEAT_PRESETS as Record<string, TaskRepeat>)[value.trim().toLowerCase()];
    if (preset) return { ...preset, ...(preset.weekdays ? { weekdays: [...preset.weekdays] } : {}) };
    throw new Error(`Invalid repeat "${value}" — expected one of ${Object.keys(REPEAT_PRESETS).join(', ')} or { unit, interval, weekdays? }`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('repeat must be an object { unit, interval, weekdays? }');
  const raw = value as Record<string, unknown>;
  const unit = raw.unit;
  if (typeof unit !== 'string' || !(REPEAT_UNITS as readonly string[]).includes(unit)) {
    throw new Error(`Invalid repeat unit "${String(unit)}" — expected ${REPEAT_UNITS.join(' | ')}`);
  }
  const interval = raw.interval === undefined ? 1 : raw.interval;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw new Error('repeat interval must be a whole number from 1 to 365');
  }
  const rule: TaskRepeat = { unit: unit as RepeatUnit, interval };
  if (raw.weekdays !== undefined && raw.weekdays !== null) {
    if (unit !== 'week') throw new Error('repeat weekdays go with unit "week" only');
    if (!Array.isArray(raw.weekdays) || raw.weekdays.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error('repeat weekdays must be numbers 0 (Sunday) to 6 (Saturday)');
    }
    const days = [...new Set(raw.weekdays as number[])].sort((a, b) => a - b);
    if (days.length > 0) rule.weekdays = days;
  }
  // Echoed back by a client that read the row: kept when well-formed.
  if (typeof raw.tz === 'string' && isValidTimezone(raw.tz)) rule.tz = raw.tz;
  if ((unit === 'month' || unit === 'year') && typeof raw.anchorDay === 'number' && Number.isInteger(raw.anchorDay) && raw.anchorDay >= 1 && raw.anchorDay <= 31) {
    rule.anchorDay = raw.anchorDay;
  }
  return rule;
}

/**
 * The rule as stored for a series: its zone (`tz`, kept when the rule already
 * has one, so a series stays in the zone it was set up in) and, for month and
 * year rules, the anchor day — the due date's day of the month in that zone,
 * else today's, unless the rule's anchor already gives that day (clamped in a
 * shorter month). Called whenever the rule or the due date is written.
 */
export function stampSeries(rule: TaskRepeat, dueAt: Date | null, tz: string, now: Date = new Date()): TaskRepeat {
  const zone = rule.tz && isValidTimezone(rule.tz) ? rule.tz : isValidTimezone(tz) ? tz : 'UTC';
  const { anchorDay: old, ...rest } = rule;
  const stamped: TaskRepeat = { ...rest, tz: zone };
  if (rule.unit === 'month' || rule.unit === 'year') {
    const due = localWallClock((dueAt ?? now).getTime(), zone);
    // A due day the anchor clamps to in that month (Feb 28 of a 31st series)
    // is still that series: a new due time, or the same day, keeps the
    // anchor. Only a day the anchor would not give moves it.
    const keep = old !== undefined && Math.min(old, daysInMonth(due.year, due.month)) === due.day;
    stamped.anchorDay = keep ? old : due.day;
  }
  return stamped;
}

/**
 * Whether an occurrence of a series may be worked yet: from the start of its
 * due day in the series' zone. A to-do without a rule or a due date always
 * may. Agents' pickup paths (heartbeat, checkout, the next-action view the
 * tasks tool offers) use this rule, so an agent assigned a repeating to-do
 * works one occurrence a day, not the whole future series back to back.
 */
export function occurrenceStarted(task: { repeat?: TaskRepeat | null; dueAt?: Date | string | null }, now: Date, fallbackTz = 'UTC'): boolean {
  if (!task.repeat || !task.dueAt) return true;
  const zone = task.repeat.tz && isValidTimezone(task.repeat.tz) ? task.repeat.tz : fallbackTz;
  return localDateIn(new Date(task.dueAt).getTime(), zone) <= localDateIn(now.getTime(), zone);
}

/** "Every day", "Weekdays", "Every 2 weeks on Tue, Thu", … */
export function repeatLabel(rule: TaskRepeat): string {
  const n = rule.interval;
  const days = rule.weekdays;
  if (rule.unit === 'week' && days && n === 1 && days.join(',') === '1,2,3,4,5') return 'Weekdays';
  const every = n === 1 ? `Every ${rule.unit}` : `Every ${n} ${rule.unit}s`;
  if (rule.unit === 'week' && days && days.length > 0) return `${n === 1 ? 'Weekly' : every} on ${days.map((d) => WEEKDAY_SHORT[d]).join(', ')}`;
  if (n === 1) return { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[rule.unit];
  return every;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Weekday (0 = Sunday) of a calendar date. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

interface CalendarDate { year: number; month: number; day: number }

function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Monday-based week index of a date, for "every n weeks". */
function weekIndex(date: CalendarDate): number {
  const ms = Date.UTC(date.year, date.month - 1, date.day);
  const daysSinceEpoch = Math.floor(ms / 86_400_000);
  // 1970-01-01 was a Thursday; shift so weeks start on Monday.
  return Math.floor((daysSinceEpoch + 3) / 7);
}

/** One step of the rule from `date`; month and year rules land on their anchor day (clamped to the month). */
function step(rule: TaskRepeat, date: CalendarDate): CalendarDate {
  const anchor = rule.anchorDay ?? date.day;
  switch (rule.unit) {
    case 'day':
      return addDays(date, rule.interval);
    case 'week': {
      if (!rule.weekdays || rule.weekdays.length === 0) return addDays(date, 7 * rule.interval);
      const start = weekIndex(date);
      // The next listed weekday in this week, or in the week `interval` on.
      for (let i = 1; i <= 7 * rule.interval + 7; i += 1) {
        const candidate = addDays(date, i);
        const weeks = weekIndex(candidate) - start;
        if (weeks % rule.interval !== 0) continue;
        if (rule.weekdays.includes(weekdayOf(candidate.year, candidate.month, candidate.day))) return candidate;
      }
      return addDays(date, 7 * rule.interval);
    }
    case 'month': {
      const months = date.month - 1 + rule.interval;
      const year = date.year + Math.floor(months / 12);
      const month = (months % 12) + 1;
      return { year, month, day: Math.min(anchor, daysInMonth(year, month)) };
    }
    case 'year': {
      const year = date.year + rule.interval;
      return { year, month: date.month, day: Math.min(anchor, daysInMonth(year, date.month)) };
    }
  }
}

/**
 * When the next occurrence is due, for a to-do completed at `now`.
 *
 * From its due date, keeping the wall-clock time in the user's zone (an
 * all-day to-do stays at the end of its day, a 09:00 one at 09:00 across a
 * DST change). One step, and more while the result is still before today, so
 * a daily to-do finished three days late comes back today, not three days
 * overdue. A to-do with no due date counts from today (end of day): its next
 * occurrence is due one step after today. `tz` is only the fallback for a
 * rule without its own zone (`rule.tz`).
 */
export function nextOccurrence(rule: TaskRepeat, dueAt: Date | null, now: Date, tz: string): Date {
  // The series' own zone wins over the caller's fallback.
  const zone = rule.tz && isValidTimezone(rule.tz) ? rule.tz : isValidTimezone(tz) ? tz : 'UTC';
  const today = localWallClock(now.getTime(), zone);
  let base: CalendarDate;
  let hour: number;
  let minute: number;
  let withinMinuteMs: number;
  if (dueAt) {
    const w = localWallClock(dueAt.getTime(), zone);
    base = { year: w.year, month: w.month, day: w.day };
    hour = w.hour;
    minute = w.minute;
    withinMinuteMs = w.second * 1000 + (dueAt.getTime() % 1000 + 1000) % 1000;
  } else {
    base = { year: today.year, month: today.month, day: today.day };
    hour = 23;
    minute = 59;
    withinMinuteMs = 59_999;
  }
  const todayKey = today.year * 10_000 + today.month * 100 + today.day;
  let next = step(rule, base);
  // Bounded: a decade of daily steps covers any realistic backlog.
  for (let guard = 0; next.year * 10_000 + next.month * 100 + next.day < todayKey && guard < 4000; guard += 1) {
    next = step(rule, next);
  }
  return new Date(localDateTimeIn(next.year, next.month, next.day, hour, minute, zone).getTime() + withinMinuteMs);
}
