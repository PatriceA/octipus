/**
 * The next-action view, orchestrated once for every caller: scan the open
 * tasks wide, resolve the user's day, rank, cap. The tasks tool and the
 * `/tasks?view=next` route both call this so they cannot drift.
 */
import { scopedRepos } from '@/db/repositories/scoped';
import type { Task } from '@/db/schema/tasks';
import type { Principal } from '@/security/principal';
import { type RankedTask, rankTasks } from './rank';
import { resolveUserTimezone } from './timezone';

/**
 * `listOwn` orders by priority before due date, so a small cap would drop a
 * low-priority overdue task before the ranker ever saw it — the one row this
 * view exists to surface. Scan wide; the cap the caller asks for is applied
 * after ranking.
 */
const SCAN_LIMIT = 5000;

export interface NextActionsOptions {
  category?: string;
  /** Browser-reported IANA zone; wins over the saved preference. */
  tz?: string | null;
  limit: number;
}

export async function nextActions(
  principal: Principal,
  opts: NextActionsOptions,
): Promise<{ timezone: string; ranked: RankedTask<Task>[] }> {
  const [open, timezone] = await Promise.all([
    scopedRepos(principal).tasks.listOwn({ status: 'open', category: opts.category, limit: SCAN_LIMIT }),
    resolveUserTimezone(principal.userId, opts.tz),
  ]);
  return { timezone, ranked: rankTasks(open, new Date(), { timezone }).slice(0, opts.limit) };
}
