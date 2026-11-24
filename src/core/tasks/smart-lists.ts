/**
 * The to-do list's views (after Microsoft To Do), as pure functions over the
 * rows `GET /api/tasks` returns, so the web page, a later Today page and the
 * mobile app (which mirrors this file) agree on what each list holds:
 *
 *   my-day     picked today (`myDayOn` is today in the user's zone)
 *   important  starred
 *   planned    has a due date, grouped Earlier / Today / Tomorrow / This week / Later
 *   all        everything not archived
 *   completed  done
 *   archived   archived (the deleted ones; they can be restored)
 *   list:<name>  one user list (`category`)
 *
 * and the Today page's parts (`todayParts`): what is overdue, due today and
 * picked into My Day, and what of that was finished today.
 *
 * A to-do's steps are its children; they show inside it, not as rows, except
 * a child whose parent is not in the set (done and paged out, or archived),
 * which stays a row so nothing disappears. Active rows are in manual order
 * (`sortOrder` ascending), done rows most recently finished first.
 */
import { localDateIn } from './rank';
import { isActiveStatus } from './status';

export const SMART_LISTS = ['my-day', 'important', 'planned', 'all', 'completed', 'archived'] as const;
export type SmartList = (typeof SMART_LISTS)[number];
export type ListKey = SmartList | `list:${string}`;

export const SMART_LIST_TITLE: Record<SmartList, string> = {
  'my-day': 'My Day',
  important: 'Important',
  planned: 'Planned',
  all: 'All',
  completed: 'Completed',
  archived: 'Archived',
};

/** The fields of a row these views read. */
export interface ListableTask {
  id: string;
  status: string;
  parentId?: string | null;
  category?: string | null;
  important?: boolean;
  myDayOn?: string | null;
  dueAt?: string | Date | null;
  sortOrder?: number;
  createdAt: string | Date;
  completedAt?: string | Date | null;
}

export function isListKey(value: string | null | undefined): value is ListKey {
  if (!value) return false;
  return (SMART_LISTS as readonly string[]).includes(value) || (value.startsWith('list:') && value.length > 5);
}

export function listTitle(key: ListKey): string {
  return key.startsWith('list:') ? key.slice(5) : SMART_LIST_TITLE[key as SmartList];
}

const ms = (v: string | Date | null | undefined): number => (v == null ? Number.NaN : new Date(v).getTime());

/**
 * A due date without a time: the server stores a bare day as the last
 * millisecond of that day in the user's zone, so seconds 59 and ms 999. A
 * time the user picks is whole minutes. True for that convention in every
 * zone with whole-minute offsets.
 */
export function isAllDayDue(dueAt: string | Date): boolean {
  const d = new Date(dueAt);
  return d.getUTCSeconds() === 59 && d.getUTCMilliseconds() === 999;
}

/** In My Day on `today` (the user's `YYYY-MM-DD`). */
export function inMyDay(task: ListableTask, today: string): boolean {
  return task.myDayOn === today;
}

/** The rows a list shows (active and done; archived only in its own view), steps folded into their to-do. */
export function listMembers<T extends ListableTask>(tasks: readonly T[], key: ListKey, today: string): T[] {
  const ids = new Set(tasks.map((t) => t.id));
  const rows = tasks.filter((t) => !t.parentId || !ids.has(t.parentId));
  const live = (t: T) => t.status !== 'archived';
  switch (key) {
    case 'my-day': return rows.filter((t) => live(t) && inMyDay(t, today));
    case 'important': return rows.filter((t) => live(t) && !!t.important);
    case 'planned': return rows.filter((t) => live(t) && t.dueAt != null);
    case 'all': return rows.filter(live);
    case 'completed': return rows.filter((t) => t.status === 'done');
    case 'archived': return rows.filter((t) => t.status === 'archived');
    default: {
      const name = key.slice(5);
      return rows.filter((t) => live(t) && (t.category ?? '') === name);
    }
  }
}

/** Manual order: `sortOrder` ascending, then newest first. */
export function byManualOrder(a: ListableTask, b: ListableTask): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || ms(b.createdAt) - ms(a.createdAt);
}

/** Finished order: most recently completed first. */
export function byCompletion(a: ListableTask, b: ListableTask): number {
  return (ms(b.completedAt) || 0) - (ms(a.completedAt) || 0) || ms(b.createdAt) - ms(a.createdAt);
}

/** Split a list's rows into its active part (manual order) and its done part (latest first). */
export function splitList<T extends ListableTask>(rows: readonly T[]): { active: T[]; done: T[] } {
  return {
    active: rows.filter((t) => isActiveStatus(t.status)).sort(byManualOrder),
    done: rows.filter((t) => !isActiveStatus(t.status)).sort(byCompletion),
  };
}

export type PlannedGroup = 'earlier' | 'today' | 'tomorrow' | 'week' | 'later';
export const PLANNED_GROUP_TITLE: Record<PlannedGroup, string> = {
  earlier: 'Earlier', today: 'Today', tomorrow: 'Tomorrow', week: 'This week', later: 'Later',
};

/** Which Planned group a due date falls in, by calendar day in `tz`. */
export function plannedGroup(dueAt: string | Date, now: Date, tz: string): PlannedGroup {
  const day = localDateIn(ms(dueAt), tz);
  const today = localDateIn(now.getTime(), tz);
  if (day < today) return 'earlier';
  if (day === today) return 'today';
  const [y, m, d] = today.split('-').map(Number);
  const plus = (n: number) => new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  if (day === plus(1)) return 'tomorrow';
  if (day <= plus(7)) return 'week';
  return 'later';
}

/** Active rows of each smart list and user list, for the rail's counts. */
export function listCounts(tasks: readonly ListableTask[], today: string): { smart: Record<SmartList, number>; lists: Map<string, number> } {
  const smart = Object.fromEntries(SMART_LISTS.map((k) => [k, 0])) as Record<SmartList, number>;
  const lists = new Map<string, number>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (t.parentId && ids.has(t.parentId)) continue;
    if (t.status === 'done') smart.completed += 1;
    if (t.status === 'archived') smart.archived += 1;
    if (!isActiveStatus(t.status)) continue;
    smart.all += 1;
    if (inMyDay(t, today)) smart['my-day'] += 1;
    if (t.important) smart.important += 1;
    if (t.dueAt != null) smart.planned += 1;
    if (t.category) lists.set(t.category, (lists.get(t.category) ?? 0) + 1);
  }
  return { smart, lists };
}

/**
 * The `sortOrder` that puts a row between two neighbours (`above` has the
 * smaller value): their midpoint, or one past the end; 0 in an empty list.
 * Null when there is no number strictly between them (doubles near the
 * default values, about -1.8e12, halve a gap of 1 only a dozen times): the
 * caller then renumbers the list with `renumbered`.
 */
export function orderBetween(above: number | null | undefined, below: number | null | undefined): number | null {
  if (above != null && below != null) {
    const mid = above + (below - above) / 2;
    return mid > above && mid < below ? mid : null;
  }
  if (below != null) return below - 1;
  if (above != null) return above + 1;
  return 0;
}

/** Fresh, evenly spaced orders for `count` rows in their current order, starting where the first one was. */
export function renumbered(count: number, start = 0): number[] {
  return Array.from({ length: count }, (_, i) => Math.round(start) + i * 1024);
}

/** The Today page's to-dos (`todayParts`). */
export interface TodayParts<T> {
  /** Active, due before today. Earliest first. */
  overdue: T[];
  /** Active, due today. Earliest first. */
  due: T[];
  /** Active, in My Day today and not overdue or due today. Manual order. */
  picked: T[];
  /** Finished today, of those that were due by today or in My Day today. Latest first. */
  done: T[];
}

/**
 * What the Today page shows, by calendar day in `tz` (the web and the tasks
 * tool's `view: "today"` agree on it): each active to-do once, overdue
 * before due today before picked. Steps fold into their to-do as in a list.
 */
export function todayParts<T extends ListableTask>(tasks: readonly T[], now: Date, tz: string): TodayParts<T> {
  const ids = new Set(tasks.map((t) => t.id));
  const rows = tasks.filter((t) => !t.parentId || !ids.has(t.parentId));
  const today = localDateIn(now.getTime(), tz);
  const parts: TodayParts<T> = { overdue: [], due: [], picked: [], done: [] };
  const byDue = (a: T, b: T) => ms(a.dueAt) - ms(b.dueAt) || byManualOrder(a, b);
  for (const t of rows) {
    const group = t.dueAt != null ? plannedGroup(t.dueAt, now, tz) : null;
    if (isActiveStatus(t.status)) {
      if (group === 'earlier') parts.overdue.push(t);
      else if (group === 'today') parts.due.push(t);
      else if (inMyDay(t, today)) parts.picked.push(t);
    } else if (t.status === 'done' && t.completedAt != null && localDateIn(ms(t.completedAt), tz) === today
      && (inMyDay(t, today) || group === 'earlier' || group === 'today')) {
      parts.done.push(t);
    }
  }
  parts.overdue.sort(byDue);
  parts.due.sort(byDue);
  parts.picked.sort(byManualOrder);
  parts.done.sort(byCompletion);
  return parts;
}
