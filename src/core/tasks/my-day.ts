/**
 * My Day (Microsoft To Do's daily pick list). A to-do is in My Day while its
 * `myDayOn` is today's date in the user's zone, so the list starts empty each
 * morning without a job rewriting rows. `GET /api/tasks/my-day` answers with
 * today's list and suggestions for it, read once here for every caller (the
 * web, the mobile app, a later Today page):
 *
 *   tasks        the to-dos picked today, active and done (done ones today too,
 *                so a finished day still shows what it held)
 *   suggestions  active top-level to-dos not picked today, in this order:
 *                left in My Day on an earlier day ("earlier"), then the
 *                next-action ranking's pressing buckets (in progress, overdue,
 *                due today, high priority, new from email, due this week),
 *                each with its one-line reason (core/tasks/rank.ts)
 */
import { contentRepos } from '@/db/repositories/content';
import type { Task } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';
import { nextActions } from './next';
import { dueChipLabel } from './quick-add';
import { localDateIn, type NextBucket } from './rank';
import { ACTIVE_TASK_STATUSES } from './status';
import { resolveUserTimezone } from './timezone';

export type MyDaySuggestionBucket = NextBucket | 'earlier';

export interface MyDaySuggestion {
  task: Task;
  bucket: MyDaySuggestionBucket;
  reason: string;
}

/** The ranking buckets worth suggesting for today; backlog and waiting are not. */
const SUGGESTED: ReadonlySet<NextBucket> = new Set(['doing', 'overdue', 'today', 'high', 'inbound', 'upcoming']);
const SUGGESTION_LIMIT = 12;

/** Today's calendar date in the user's zone (browser zone first, then the saved preference). */
export async function myDayDate(userId: string, tz?: string | null): Promise<{ timezone: string; date: string }> {
  const timezone = await resolveUserTimezone(userId, tz);
  return { timezone, date: localDateIn(Date.now(), timezone) };
}

export async function myDay(
  principal: Principal,
  tz?: string | null,
): Promise<{ timezone: string; date: string; tasks: Task[]; suggestions: MyDaySuggestion[] }> {
  const { timezone, date } = await myDayDate(principal.userId, tz);
  const repo = contentRepos(principal).tasks;
  const [picked, active, { ranked }] = await Promise.all([
    repo.listOwn({ myDayOn: date, statuses: [...ACTIVE_TASK_STATUSES, 'done'], limit: 500 }),
    repo.listOwn({ statuses: [...ACTIVE_TASK_STATUSES], limit: 5000 }),
    nextActions(principal, { tz: timezone, limit: 200 }),
  ]);
  const earlier: MyDaySuggestion[] = active
    .filter((t) => !t.parentId && t.myDayOn && t.myDayOn < date)
    .sort((a, b) => (b.myDayOn ?? '').localeCompare(a.myDayOn ?? ''))
    .map((task) => ({ task, bucket: 'earlier', reason: `in My Day ${myDayWhen(task.myDayOn as string, date)}` }));
  const seen = new Set(earlier.map((s) => s.task.id));
  const pressing: MyDaySuggestion[] = ranked
    .filter((r) => SUGGESTED.has(r.bucket) && !r.task.parentId && r.task.myDayOn !== date && !seen.has(r.task.id))
    .map((r) => ({ task: r.task, bucket: r.bucket, reason: r.reason }));
  return { timezone, date, tasks: picked, suggestions: [...earlier, ...pressing].slice(0, SUGGESTION_LIMIT) };
}

/** "yesterday", or "on Fri, Nov 20". */
function myDayWhen(day: string, today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return day === yesterday ? 'yesterday' : `on ${dueChipLabel(day, today)}`;
}
