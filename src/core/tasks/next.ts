/**
 * The next-action view, orchestrated once for every caller: scan the open
 * tasks wide, resolve the user's day, rank, cap. The tasks tool and the
 * `/tasks?view=next` route both call this so they cannot drift.
 */
import { contentRepos } from '@/db/repositories/content';
import type { Task } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';
import { type RankedTask, rankTasks } from './rank';
import { occurrenceStarted } from './repeat';
import { ACTIVE_TASK_STATUSES } from './status';
import { resolveUserTimezone } from './timezone';

/**
 * `listOwn` orders by priority before due date, so a small cap would drop a
 * low-priority overdue task before the ranker ever saw it — the one row this
 * view exists to surface. Scan wide; the cap the caller asks for is applied
 * after ranking. The category filter is applied after ranking too: the
 * ranker decides "waiting" against the whole active set, and a blocker in
 * another category still blocks.
 */
const SCAN_LIMIT = 5000;

export interface NextActionsOptions {
  category?: string;
  /** Browser-reported IANA zone; wins over the saved preference. */
  tz?: string | null;
  limit: number;
  /**
   * Only what an agent may work now: leaves out future occurrences of a
   * repeating to-do (`occurrenceStarted`, core/tasks/repeat.ts), the same
   * rule the checkout and the role heartbeat apply.
   */
  workableOnly?: boolean;
}

export async function nextActions(
  principal: Principal,
  opts: NextActionsOptions,
): Promise<{ timezone: string; ranked: RankedTask<Task>[] }> {
  const [active, timezone] = await Promise.all([
    contentRepos(principal).tasks.listOwn({ statuses: [...ACTIVE_TASK_STATUSES], limit: SCAN_LIMIT }),
    resolveUserTimezone(principal.userId, opts.tz),
  ]);
  const now = new Date();
  const ranked = rankTasks(active, now, { timezone }).filter((r) => !opts.workableOnly || occurrenceStarted(r.task, now, timezone));
  const category = opts.category?.trim();
  const wanted =
    category === undefined
      ? ranked
      : category === '' || category.toLowerCase() === 'none'
        ? ranked.filter((r) => !r.task.category)
        : ranked.filter((r) => r.task.category === category);
  return { timezone, ranked: wanted.slice(0, opts.limit) };
}
