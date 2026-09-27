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
 *   - workspace — rows attributed to that workspace by
 *                 COALESCE(agents.workspace_id, sessions.workspace_id):
 *                 the agent row carries the workspace the agent ran under
 *                 (`AgentContext.workspaceId`, the same value enforcement
 *                 keys on); the session's own workspace is the fallback for
 *                 rows without an agent. cost_log has no workspace column, so
 *                 rows with neither (agent rows persisted before agents were
 *                 stamped with their workspace, background calls without an
 *                 agent in a user-level session) count toward the user scope
 *                 only — a workspace budget under-counts them.
 *
 * CLI and subscription providers log zero or an estimated cost
 * (`CostLogMetadata.costSource` = 'estimated' | 'unknown'), so a budget
 * under-counts work done through them. We take `total_cost` as recorded
 * rather than block on it: a USD cap is only as good as the cost the
 * provider reports.
 *
 * `warned_at` / `paused_at` are compared against the current period start, so
 * a stamp left from an earlier period is inert and budgets roll over without
 * a job. The warning and the pause are claimed with a conditional UPDATE so
 * each notifies once per period even across processes.
 *
 * Caching: checkSpend runs before every LLM call, so both the user's budget
 * rows and each budget's spend sum are cached in-process for 30s. A user with
 * no budgets costs one query per 30s. Writes through this module invalidate
 * the budget cache in-process; another process (API vs worker) may serve a
 * stale row — e.g. a cleared or freshly stamped pause — for up to 30s, which
 * is acceptable for a dollar cap. A pause is never missed: a stale row
 * without the stamp still sees spend ≥ limit and refuses.
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

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 5_000;
// Keyed per user / per budget scope (never per period), so a new period
// overwrites the entry rather than adding one.
const budgetCache = new Map<string, { rows: SpendBudget[]; expires: number }>();
const spendCache = new Map<string, { start: number; value: number; expires: number }>();

function remember<V extends { expires: number }>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(key, value);
}

function invalidate(userId: string): void {
  budgetCache.delete(userId);
}

export function periodStart(period: SpendPeriod, now: Date): Date {
  return period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function budgetsOf(userId: string, now: Date): Promise<SpendBudget[]> {
  const hit = budgetCache.get(userId);
  if (hit && hit.expires > now.getTime()) return hit.rows;
  const rows = await getDb().select().from(spendBudgets).where(eq(spendBudgets.userId, userId));
  remember(budgetCache, userId, { rows, expires: now.getTime() + CACHE_TTL_MS });
  return rows;
}

async function spendSince(budget: SpendBudget, start: Date, now: Date): Promise<number> {
  const key = `${budget.userId}:${budget.scopeKind}:${budget.scopeRef ?? ''}:${budget.period}`;
  const hit = spendCache.get(key);
  if (hit && hit.start === start.getTime() && hit.expires > now.getTime()) return hit.value;

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
      .leftJoin(agents, eq(agents.id, costLog.agentId))
      .leftJoin(sessions, eq(sessions.id, costLog.sessionId))
      .where(and(base, sql`COALESCE(${agents.workspaceId}, ${sessions.workspaceId})::text = ${budget.scopeRef ?? ''}`));
  } else {
    rows = await db.select({ s: total }).from(costLog).where(base);
  }
  const value = Number(rows[0]?.s ?? 0);
  remember(spendCache, key, { start: start.getTime(), value, expires: now.getTime() + CACHE_TTL_MS });
  return value;
}

function applies(b: SpendBudget, scope: SpendScope): boolean {
  if (b.scopeKind === 'user') return true;
  if (b.scopeKind === 'role') return !!scope.role && b.scopeRef === scope.role;
  return !!scope.workspaceId && b.scopeRef === scope.workspaceId.toLowerCase();
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
  const budgets = (await budgetsOf(scope.userId, now)).filter(b => applies(b, scope));
  if (budgets.length === 0) return [];

  const db = getDb();
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
      invalidate(b.userId);
      if (claimed.length > 0) {
        securityLogger.warn(reason, 'Spend budget exhausted, pausing');
        await notify(b, 'spend_budget_paused', 'Spend budget reached — agents paused',
          `${scopeLabel(b)} budget of $${limitUsd.toFixed(2)} is spent ($${spentUsd.toFixed(2)}).`, spentUsd);
      }
      throw new SpendBudgetExceededError(reason);
    }

    if (spentUsd >= limitUsd * b.warnRatio) {
      if (!(b.warnedAt && b.warnedAt >= start)) {
        const claimed = await db.update(spendBudgets)
          .set({ warnedAt: now, updatedAt: now })
          .where(and(eq(spendBudgets.id, b.id), or(isNull(spendBudgets.warnedAt), lt(spendBudgets.warnedAt, start))))
          .returning({ id: spendBudgets.id });
        invalidate(b.userId);
        if (claimed.length > 0) {
          await notify(b, 'spend_budget_warning', 'Spend budget almost reached',
            `${scopeLabel(b)} spend is $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}.`, spentUsd);
        }
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
 * Create or update the budget for (user, scope, period) in one statement.
 * Changing it clears the warning and the pause: the new limit is evaluated
 * afresh on the next check, which pauses again if spend is still over it.
 * Role names are trimmed and workspace ids lowercased so they match the
 * values enforcement compares against.
 */
export async function upsertBudget(input: {
  userId: string;
  scopeKind: SpendScopeKind;
  scopeRef?: string | null;
  period: SpendPeriod;
  limitUsd: number;
  warnRatio?: number;
}): Promise<SpendBudget> {
  const ref = input.scopeRef?.trim() || null;
  const scopeRef = input.scopeKind === 'user' ? null
    : input.scopeKind === 'workspace' ? (ref?.toLowerCase() ?? null) : ref;
  const values = {
    limitUsd: String(input.limitUsd),
    ...(input.warnRatio !== undefined && { warnRatio: input.warnRatio }),
    warnedAt: null,
    pausedAt: null,
    updatedAt: new Date(),
  };
  // The unique index is NULLS NOT DISTINCT, so the conflict target also
  // catches the user-scope row whose scope_ref is NULL.
  const [row] = await getDb().insert(spendBudgets)
    .values({ userId: input.userId, scopeKind: input.scopeKind, scopeRef, period: input.period, ...values })
    .onConflictDoUpdate({
      target: [spendBudgets.userId, spendBudgets.scopeKind, spendBudgets.scopeRef, spendBudgets.period],
      set: values,
    })
    .returning();
  invalidate(input.userId);
  return row;
}

export async function deleteBudget(id: string): Promise<boolean> {
  const rows = await getDb().delete(spendBudgets).where(eq(spendBudgets.id, id))
    .returning({ userId: spendBudgets.userId });
  for (const r of rows) invalidate(r.userId);
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
  if (row) invalidate(row.userId);
  return row ?? null;
}

export function _resetSpendBudgetsForTests(): void {
  budgetCache.clear();
  spendCache.clear();
}

export function _spendCacheSizeForTests(): number {
  return spendCache.size;
}
