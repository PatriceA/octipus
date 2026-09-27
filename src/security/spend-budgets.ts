/**
 * Dollar spend budgets — a USD cap per user, role or workspace.
 *
 * Soft warning at `warn_ratio` (default 80%), hard pause at 100%, checked
 * before invocation (agent spawn, each LLM call, CLI start, heartbeat tick).
 * Spend is SUM(cost_log.total_cost) since the start of the current UTC day or
 * month:
 *
 *   - user      — every cost_log row of the user.
 *   - role      — rows whose agent_id joins `agents` with that `role`.
 *   - workspace — rows whose session_id joins `sessions` with that
 *                 `workspace_id`. Rows without a session (some background
 *                 calls) cannot be attributed and count only toward the
 *                 user scope.
 *
 * CLI and subscription providers log zero or an estimated cost
 * (`CostLogMetadata.costSource` = 'estimated' | 'unknown'), so a budget
 * under-counts work done through them. We take `total_cost` as recorded
 * rather than block on it: a USD cap is only as good as the cost the
 * provider reports.
 *
 * `warned_at` / `paused_at` are compared against the current period start, so
 * a stamp left from an earlier period is inert and budgets roll over without
 * a job. The warning is claimed with a conditional UPDATE so it fires once per
 * period even across processes.
 */
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { costLog } from '@/db/schema/models';
import { sessions } from '@/db/schema/sessions';
import {
  type SpendBudget,
  type SpendPeriod,
  type SpendScopeKind,
  spendBudgets,
} from '@/db/schema/spend-budgets';
import { SpendBudgetExceededError } from '@/security/spend-budget-error';
import { securityLogger } from '@/utils/logger';

export interface SpendScope {
  userId: string;
  role?: string;
  workspaceId?: string | null;
}

export interface SpendStatus {
  budget: SpendBudget;
  spentUsd: number;
  limitUsd: number;
  state: 'ok' | 'warn';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Short-lived spend cache: the SUM runs before every LLM call, and a 30s lag
// on a dollar cap is acceptable. Budget rows (limit, pause) are read fresh so
// an admin change applies on the next check.
const CACHE_TTL_MS = 30_000;
const spendCache = new Map<string, { value: number; expires: number }>();

export function periodStart(period: SpendPeriod, now: Date): Date {
  return period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function spendSince(budget: SpendBudget, start: Date, now: Date): Promise<number> {
  const key = `${budget.userId}:${budget.scopeKind}:${budget.scopeRef ?? ''}:${start.toISOString()}`;
  const hit = spendCache.get(key);
  if (hit && hit.expires > now.getTime()) return hit.value;

  const db = getDb();
  const total = sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float8`;
  const base = and(eq(costLog.userId, budget.userId), gte(costLog.createdAt, start));
  let rows: { s: number }[];
  if (budget.scopeKind === 'role') {
    rows = await db.select({ s: total }).from(costLog)
      .innerJoin(agents, eq(agents.id, costLog.agentId))
      .where(and(base, eq(agents.role, budget.scopeRef ?? '')));
  } else if (budget.scopeKind === 'workspace') {
    rows = await db.select({ s: total }).from(costLog)
      .innerJoin(sessions, eq(sessions.id, costLog.sessionId))
      .where(and(base, sql`${sessions.workspaceId}::text = ${budget.scopeRef ?? ''}`));
  } else {
    rows = await db.select({ s: total }).from(costLog).where(base);
  }
  const value = Number(rows[0]?.s ?? 0);
  spendCache.set(key, { value, expires: now.getTime() + CACHE_TTL_MS });
  return value;
}

function scopeLabel(b: SpendBudget): string {
  const every = b.period === 'day' ? 'daily' : 'monthly';
  return b.scopeKind === 'user' ? `Your ${every}` : `The ${b.scopeKind} "${b.scopeRef}" ${every}`;
}

async function notify(b: SpendBudget, type: string, title: string, body: string, spentUsd: number): Promise<void> {
  const { getNotificationService } = await import('@/core/notification-service');
  await getNotificationService().notify(b.userId, type, title, body, {
    budgetId: b.id, scopeKind: b.scopeKind, scopeRef: b.scopeRef, period: b.period,
    spentUsd, limitUsd: Number(b.limitUsd),
  });
}

/**
 * Evaluate every budget that applies to this invocation. Throws
 * `SpendBudgetExceededError` (and stamps `paused_at`) when one is at or over
 * its limit; warns once per period at `warn_ratio`. System / local principals
 * have no budgets.
 */
export async function checkSpend(scope: SpendScope, now: Date = new Date()): Promise<SpendStatus[]> {
  if (!UUID_RE.test(scope.userId)) return [];
  const db = getDb();
  const scopeMatch = [eq(spendBudgets.scopeKind, 'user')];
  if (scope.role) {
    scopeMatch.push(and(eq(spendBudgets.scopeKind, 'role'), eq(spendBudgets.scopeRef, scope.role))!);
  }
  if (scope.workspaceId) {
    scopeMatch.push(and(eq(spendBudgets.scopeKind, 'workspace'), eq(spendBudgets.scopeRef, scope.workspaceId))!);
  }
  const budgets = await db.select().from(spendBudgets)
    .where(and(eq(spendBudgets.userId, scope.userId), or(...scopeMatch)));

  const out: SpendStatus[] = [];
  for (const b of budgets) {
    const start = periodStart(b.period, now);
    const limitUsd = Number(b.limitUsd);
    const spentUsd = await spendSince(b, start, now);
    const reason = {
      budgetId: b.id, userId: b.userId, scopeKind: b.scopeKind, scopeRef: b.scopeRef,
      period: b.period, spentUsd, limitUsd,
    };

    if (b.pausedAt && b.pausedAt >= start) throw new SpendBudgetExceededError(reason);

    if (spentUsd >= limitUsd) {
      const claimed = await db.update(spendBudgets)
        .set({ pausedAt: now, updatedAt: now })
        .where(and(eq(spendBudgets.id, b.id), or(isNull(spendBudgets.pausedAt), lt(spendBudgets.pausedAt, start))))
        .returning({ id: spendBudgets.id });
      if (claimed.length > 0) {
        securityLogger.warn(reason, 'Spend budget exhausted, pausing');
        await notify(b, 'spend_budget_paused', 'Spend budget reached — agents paused',
          `${scopeLabel(b)} budget of $${limitUsd.toFixed(2)} is spent ($${spentUsd.toFixed(2)}).`, spentUsd);
      }
      throw new SpendBudgetExceededError(reason);
    }

    if (spentUsd >= limitUsd * b.warnRatio) {
      const claimed = await db.update(spendBudgets)
        .set({ warnedAt: now, updatedAt: now })
        .where(and(eq(spendBudgets.id, b.id), or(isNull(spendBudgets.warnedAt), lt(spendBudgets.warnedAt, start))))
        .returning({ id: spendBudgets.id });
      if (claimed.length > 0) {
        await notify(b, 'spend_budget_warning', 'Spend budget almost reached',
          `${scopeLabel(b)} spend is $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}.`, spentUsd);
      }
      out.push({ budget: b, spentUsd, limitUsd, state: 'warn' });
    } else {
      out.push({ budget: b, spentUsd, limitUsd, state: 'ok' });
    }
  }
  return out;
}

// ── CRUD (admin routes) ─────────────────────────────────────────────

export function listBudgets(userId?: string): Promise<SpendBudget[]> {
  const q = getDb().select().from(spendBudgets);
  return userId ? q.where(eq(spendBudgets.userId, userId)) : q;
}

/**
 * Create or update the budget for (user, scope, period). Changing it clears
 * the warning and the pause: the new limit is evaluated afresh on the next
 * check, which pauses again if spend is still over it.
 */
export async function upsertBudget(input: {
  userId: string;
  scopeKind: SpendScopeKind;
  scopeRef?: string | null;
  period: SpendPeriod;
  limitUsd: number;
  warnRatio?: number;
}): Promise<SpendBudget> {
  const db = getDb();
  const scopeRef = input.scopeKind === 'user' ? null : (input.scopeRef ?? null);
  const match = and(
    eq(spendBudgets.userId, input.userId),
    eq(spendBudgets.scopeKind, input.scopeKind),
    scopeRef === null ? isNull(spendBudgets.scopeRef) : eq(spendBudgets.scopeRef, scopeRef),
    eq(spendBudgets.period, input.period),
  );
  const [existing] = await db.select({ id: spendBudgets.id }).from(spendBudgets).where(match).limit(1);
  const values = {
    limitUsd: String(input.limitUsd),
    ...(input.warnRatio !== undefined && { warnRatio: input.warnRatio }),
    warnedAt: null,
    pausedAt: null,
    updatedAt: new Date(),
  };
  if (existing) {
    const [row] = await db.update(spendBudgets).set(values).where(eq(spendBudgets.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(spendBudgets).values({
    userId: input.userId, scopeKind: input.scopeKind, scopeRef, period: input.period, ...values,
  }).returning();
  return row;
}

export async function deleteBudget(id: string): Promise<boolean> {
  const rows = await getDb().delete(spendBudgets).where(eq(spendBudgets.id, id)).returning({ id: spendBudgets.id });
  return rows.length > 0;
}

/**
 * Clear a budget's pause. Only useful once spend is back under the limit
 * (limit raised elsewhere, or costs corrected); otherwise the next check
 * pauses it again.
 */
export async function resetPause(id: string): Promise<SpendBudget | null> {
  const [row] = await getDb().update(spendBudgets)
    .set({ pausedAt: null, updatedAt: new Date() })
    .where(eq(spendBudgets.id, id))
    .returning();
  return row ?? null;
}

export function _resetSpendBudgetsForTests(): void {
  spendCache.clear();
}
