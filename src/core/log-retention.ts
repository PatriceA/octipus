/**
 * Age-based pruning of the log tables that otherwise grow for ever.
 *
 * Only rows that are history and nothing else:
 *
 *   - `audit_log` rows with action `api_request` — the shadow log of every
 *     write request (src/api/middleware/audit-shadow.ts), by far its bulk.
 *     Security actions (logins, permission and admin changes) are kept.
 *   - `hook_executions` — the run history the hooks pages page through.
 *   - `notifications` the user has READ. Unread ones stay, whatever their age.
 *   - `permission_requests` that were answered or expired. Pending ones stay:
 *     a human answers when they answer.
 *   - `context_turns` — what the context hooks injected per turn and what the
 *     agent did with it (docs/CONTEXT-HOOKS.md); the stats read 90 days at most.
 *
 * Deliberately not pruned: `cost_log` (billing history and the source of the
 * spend budgets; it outlives a purged space), `run_events` (replay and the
 * trace of a session that still exists), `tool_actions` (recovery evidence
 * awaiting review), `trajectory_runs` (index of the trajectory files), and
 * `cleanup_audit_log` (one row per cleanup run — it does not grow enough to
 * matter).
 *
 * Default window `LOG_RETENTION_DAYS_DEFAULT`; an operator overrides it with a
 * `retention_policies` row, purpose `log_history`: `max_age_days` sets the
 * window, NULL turns pruning off.
 *
 * Deletes go in batches of ids (`LIMIT` in a subquery) so no statement holds
 * a long lock or a huge transaction, with a ceiling per run; whatever is left
 * goes on the next run.
 */
import { and, eq, inArray, lt, ne, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getDb } from '@/db/postgres';
import { auditLog } from '@/db/schema/audit';
import { contextTurns } from '@/db/schema/context-hooks';
import { hookExecutions } from '@/db/schema/hook-executions';
import { notifications } from '@/db/schema/notifications';
import { permissionRequests } from '@/db/schema/permissions';
import { retentionPolicies } from '@/db/schema/retention-policies';

export const LOG_RETENTION_DAYS_DEFAULT = 90;
export const LOG_RETENTION_PURPOSE = 'log_history';

interface PruneTarget {
  name: string;
  table: PgTable;
  id: PgColumn;
  /** The rows this target may delete, older than `cutoff`. */
  where: (cutoff: Date) => SQL | undefined;
}

const TARGETS: readonly PruneTarget[] = [
  {
    name: 'audit_log.api_request',
    table: auditLog,
    id: auditLog.id,
    where: (cutoff) => and(eq(auditLog.action, 'api_request'), lt(auditLog.createdAt, cutoff)),
  },
  {
    name: 'hook_executions',
    table: hookExecutions,
    id: hookExecutions.id,
    where: (cutoff) => lt(hookExecutions.createdAt, cutoff),
  },
  {
    name: 'notifications.read',
    table: notifications,
    id: notifications.id,
    where: (cutoff) => and(eq(notifications.read, true), lt(notifications.createdAt, cutoff)),
  },
  {
    name: 'permission_requests.settled',
    table: permissionRequests,
    id: permissionRequests.id,
    where: (cutoff) => and(ne(permissionRequests.status, 'pending'), lt(permissionRequests.createdAt, cutoff)),
  },
  {
    name: 'context_turns',
    table: contextTurns,
    id: contextTurns.id,
    where: (cutoff) => lt(contextTurns.createdAt, cutoff),
  },
];

/** The window in days, or null when an operator turned pruning off. */
export async function logRetentionDays(): Promise<number | null> {
  const [policy] = await getDb()
    .select({ maxAgeDays: retentionPolicies.maxAgeDays })
    .from(retentionPolicies)
    .where(eq(retentionPolicies.purpose, LOG_RETENTION_PURPOSE))
    .limit(1);
  if (!policy) return LOG_RETENTION_DAYS_DEFAULT;
  return policy.maxAgeDays && policy.maxAgeDays > 0 ? policy.maxAgeDays : null;
}

/**
 * Delete what is past the window. Returns rows removed per target, or null
 * when pruning is off.
 */
export async function pruneLogTables(
  now = new Date(),
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<Record<string, number> | null> {
  const days = await logRetentionDays();
  if (days === null) return null;
  const batchSize = opts.batchSize ?? 5000;
  const maxBatches = opts.maxBatches ?? 200;
  const cutoff = new Date(now.getTime() - days * 24 * 3600_000);
  const db = getDb();
  const removed: Record<string, number> = {};
  for (const target of TARGETS) {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const ids = db.select({ id: target.id }).from(target.table).where(target.where(cutoff)).limit(batchSize);
      const rows = await db.delete(target.table).where(inArray(target.id, ids)).returning({ id: target.id });
      total += rows.length;
      if (rows.length < batchSize) break;
    }
    removed[target.name] = total;
  }
  return removed;
}
