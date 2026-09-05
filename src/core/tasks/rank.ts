/**
 * Next-action ranking over the to-do list.
 *
 * `list_tasks` returns rows ordered by status / priority / due date, which is
 * a sort, not an answer to "what should I do first?". This is the answer,
 * written once as a pure function so the tasks tool, the `/tasks?view=next`
 * API and the tasks page's default grouping all agree on it; the Daily
 * Briefing asks the tool for this view rather than re-sorting.
 *
 * Buckets, in order:
 *   overdue   — due date passed (most overdue first)
 *   today     — due by the end of today (earliest first)
 *   high      — priority 3 with no due date pressure
 *   inbound   — arrived from email / research / reader in the last 48h
 *               (something outside the user's head asked for attention)
 *   upcoming  — due by the end of the 7th day from today
 *   backlog   — everything else, by priority then recency
 *
 * "Today" is a calendar day in the USER's timezone, not the server's: the
 * caller passes the zone (browser-reported, or the user's preference), and
 * the day boundaries are computed in it. Only open tasks are ranked.
 * `reason` is the one-line justification the UI and the briefing show next
 * to the task — a rank without a reason is a guess the user cannot argue with.
 */

export type NextBucket = 'overdue' | 'today' | 'high' | 'inbound' | 'upcoming' | 'backlog';

export const NEXT_BUCKET_ORDER: readonly NextBucket[] = ['overdue', 'today', 'high', 'inbound', 'upcoming', 'backlog'];

export const NEXT_BUCKET_TITLE: Record<NextBucket, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  high: 'High priority',
  inbound: 'New from email, research and reading',
  upcoming: 'Due this week',
  backlog: 'Backlog',
};

/** The subset of a task row the ranker reads. */
export interface RankableTask {
  status: string;
  priority: number;
  dueAt?: Date | string | null;
  createdAt: Date | string;
  source?: string;
}

export interface RankedTask<T extends RankableTask> {
  task: T;
  bucket: NextBucket;
  reason: string;
}

export interface RankOptions {
  /** IANA zone the day boundaries are computed in. Default: the process zone. */
  timezone?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const INBOUND_SOURCES = new Set(['email', 'research', 'reader']);
const INBOUND_WINDOW_MS = 48 * 60 * 60 * 1000;
const UPCOMING_WINDOW_DAYS = 7;

/** True when `tz` is a zone Intl accepts. */
export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** The wall-clock reading of instant `ms` in `tz`. */
function wallClockIn(ms: number, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** `tz`'s UTC offset (ms) in force at instant `ms`. */
function offsetAt(ms: number, tz: string): number {
  const w = wallClockIn(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Local midnight of the calendar date (y, m, d) in `tz`, as an epoch. Two
 * passes: the offset at the guessed instant, then the offset at the
 * corrected instant — because on a DST transition day the offset at noon
 * is not the offset at midnight, and a one-pass reading is an hour off.
 */
function localMidnightIn(year: number, month: number, day: number, tz: string): number {
  const naive = Date.UTC(year, month - 1, day);
  const candidate = naive - offsetAt(naive, tz);
  return naive - offsetAt(candidate, tz);
}

/** Start of the calendar day containing `ms` in `tz`, as an epoch. */
function startOfDayIn(ms: number, tz: string): number {
  const w = wallClockIn(ms, tz);
  return localMidnightIn(w.year, w.month, w.day, tz);
}

/** End of the calendar day containing `ms` in `tz`: the last ms before the next local midnight. */
function endOfDayIn(ms: number, tz: string): number {
  const w = wallClockIn(ms, tz);
  return localMidnightIn(w.year, w.month, w.day + 1, tz) - 1;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A bare `YYYY-MM-DD` due date means "by the end of that day" in the user's
 * zone. Stored as-is it would be UTC midnight, which for anyone east of
 * Greenwich is the previous evening — every "due today" task would rank as
 * overdue from the moment the day starts. Returns null for anything that is
 * not a bare date, so callers fall through to ordinary ISO parsing.
 */
export function dateOnlyToEndOfDay(value: string, tz: string): Date | null {
  const m = DATE_ONLY.exec(value.trim());
  if (!m) return null;
  const zone = isValidTimezone(tz) ? tz : 'UTC';
  return new Date(localMidnightIn(Number(m[1]), Number(m[2]), Number(m[3]) + 1, zone) - 1);
}

function describeSource(source: string | undefined): string {
  switch (source) {
    case 'email': return 'an email';
    case 'research': return 'a research report';
    case 'reader': return 'an article';
    default: return 'elsewhere';
  }
}

interface DayBounds { startOfToday: number; endOfToday: number; endOfWindow: number }

function classify<T extends RankableTask>(task: T, nowMs: number, days: DayBounds): { bucket: NextBucket; reason: string; sortKey: number } {
  const dueMs = toMs(task.dueAt);
  const createdMs = toMs(task.createdAt) ?? nowMs;

  if (dueMs !== null && dueMs < nowMs) {
    let late: string;
    if (dueMs >= days.startOfToday) late = 'today';
    else {
      // Whole days back from the start of today: a task due at yesterday's
      // midnight is 1 day ago, not 2.
      const calendarDays = Math.max(1, Math.ceil((days.startOfToday - dueMs) / DAY_MS));
      late = calendarDays === 1 ? 'yesterday' : `${calendarDays} days ago`;
    }
    return { bucket: 'overdue', reason: `was due ${late}`, sortKey: dueMs };
  }
  if (dueMs !== null && dueMs <= days.endOfToday) {
    return { bucket: 'today', reason: 'due today', sortKey: dueMs };
  }
  if (task.priority >= 3) {
    return { bucket: 'high', reason: 'high priority', sortKey: -createdMs };
  }
  if (task.source && INBOUND_SOURCES.has(task.source) && nowMs - createdMs <= INBOUND_WINDOW_MS) {
    return { bucket: 'inbound', reason: `came in from ${describeSource(task.source)}`, sortKey: -task.priority * 1e15 - createdMs };
  }
  if (dueMs !== null && dueMs <= days.endOfWindow) {
    const calendarDays = Math.max(1, Math.ceil((dueMs - days.endOfToday) / DAY_MS));
    return { bucket: 'upcoming', reason: `due in ${calendarDays} day${calendarDays === 1 ? '' : 's'}`, sortKey: dueMs };
  }
  return {
    bucket: 'backlog',
    reason: task.priority > 0 ? `priority ${task.priority}` : 'no date, no priority',
    sortKey: -task.priority * 1e15 - createdMs,
  };
}

/**
 * Rank open tasks into next-action order. Stable within a bucket by the
 * bucket's own key (most overdue first, earliest due first, newest inbound
 * first, highest priority first). Non-open tasks are dropped, not sorted last.
 */
export function rankTasks<T extends RankableTask>(
  tasks: readonly T[],
  now: Date = new Date(),
  opts: RankOptions = {},
): RankedTask<T>[] {
  const tz = isValidTimezone(opts.timezone) ? opts.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowMs = now.getTime();
  const days: DayBounds = {
    startOfToday: startOfDayIn(nowMs, tz),
    endOfToday: endOfDayIn(nowMs, tz),
    endOfWindow: endOfDayIn(nowMs + UPCOMING_WINDOW_DAYS * DAY_MS, tz),
  };
  const bucketRank = new Map(NEXT_BUCKET_ORDER.map((b, i) => [b, i]));
  return tasks
    .filter((t) => t.status === 'open')
    .map((task) => ({ task, ...classify(task, nowMs, days) }))
    .sort((a, b) => (bucketRank.get(a.bucket)! - bucketRank.get(b.bucket)!) || (a.sortKey - b.sortKey))
    .map(({ task, bucket, reason }) => ({ task, bucket, reason }));
}
