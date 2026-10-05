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
 *   - group_channel — every member's rows in the channel's sessions
 *                 (`cost_log.session_id` → `sessions.group_channel_id`), not
 *                 only the user's the budget is filed under (the channel's
 *                 owner, who is notified). Applied to an invocation through
 *                 its session (`SpendScope.sessionId`).
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
 * Space budgets (docs/plans/coworking-spec.md §9.2) pay for sponsored work:
 *
 *   - space        — every `funding = 'sponsor'` row of the space
 *                 (`cost_log.workspace_id`), whoever acted. Paused on its
 *                 row like any budget: the whole space's sponsored work stops.
 *   - space_member — the same rows of one member. One budget applies to each
 *                 member separately: it is checked statelessly from cost_log
 *                 and its notices are stamped per member in
 *                 `space_member_notices`, so a member at their cap never
 *                 pauses the others.
 *
 * A sponsored invocation (`SpendScope.funding = 'sponsor'`) is checked
 * against its space's budgets only; an own invocation against the
 * requester's budgets (and its group channel's). Personal scopes (user, role,
 * workspace) never count sponsored rows: a sponsor paid them, so they never
 * pause a member's own budget. `install` rows keep counting for the user
 * they are attributed to.
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
import { and, eq, gte, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AgentFunding } from '@/core/types';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { costLog } from '@/db/schema/models';
import { costSourceAggregates } from '@/db/cost-source';
import { groupChannels } from '@/db/schema/group-channels';
import { sessions } from '@/db/schema/sessions';
import {
  SPACE_SCOPE_KINDS,
  type SpaceScopeKind,
  type SpendBudget,
  type SpendPeriod,
  type SpendScopeKind,
  spaceMemberNotices,
  spendBudgets,
} from '@/db/schema/spend-budgets';
import { SpendBudgetExceededError } from '@/security/spend-budget-error';
import { securityLogger } from '@/utils/logger';

export interface SpendScope {
  userId: string;
  role?: string;
  workspaceId?: string | null;
  /** The session the invocation runs in: a group channel's budget covers its sessions. */
  sessionId?: string | null;
  /** Who pays (`AgentContext.funding`): `sponsor` is checked against the space's budgets only. */
  funding: AgentFunding;
  /** The space the invocation runs in, or null. Required for a sponsored invocation. */
  spaceId: string | null;
}

const notSpaceKind = notInArray(spendBudgets.scopeKind, [...SPACE_SCOPE_KINDS]);

export function isSpaceScopeKind(kind: SpendScopeKind): kind is SpaceScopeKind {
  return (SPACE_SCOPE_KINDS as readonly string[]).includes(kind);
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
const spendCache = new Map<string, { start: number; value: SpendBreakdown; expires: number }>();
// Group channel budgets by channel id, and whether there is any at all: an
// install without one never looks a session up.
const groupBudgetCache = new Map<string, { rows: SpendBudget[]; expires: number }>();
let groupBudgetsExistCache: { value: boolean; expires: number } | null = null;
// Space budgets by space id.
const spaceBudgetCache = new Map<string, { rows: SpendBudget[]; expires: number }>();
// A session's group channel is set when the session is created and never
// changes, so it is cached without expiry (bounded).
const sessionGroupCache = new Map<string, string | null>();

function remember<V extends { expires: number }>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(key, value);
}

function invalidate(userId: string | null): void {
  if (userId) budgetCache.delete(userId);
}

/** After a write to `b`: the rows cached for it are stale. */
function invalidateBudget(b: Pick<SpendBudget, 'userId' | 'scopeKind' | 'scopeRef'>): void {
  if (isSpaceScopeKind(b.scopeKind)) {
    spaceBudgetCache.delete(b.scopeRef ?? '');
    return;
  }
  invalidate(b.userId);
  if (b.scopeKind === 'group_channel') {
    groupBudgetCache.delete(b.scopeRef ?? '');
    groupBudgetsExistCache = null;
  }
}

export function periodStart(period: SpendPeriod, now: Date): Date {
  return period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Start of the next period: when a pause lifts on its own. */
export function periodEnd(period: SpendPeriod, now: Date): Date {
  return period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

async function budgetsOf(userId: string, now: Date): Promise<SpendBudget[]> {
  const hit = budgetCache.get(userId);
  if (hit && hit.expires > now.getTime()) return hit.rows;
  const rows = await getDb().select().from(spendBudgets).where(and(eq(spendBudgets.userId, userId), notSpaceKind));
  remember(budgetCache, userId, { rows, expires: now.getTime() + CACHE_TTL_MS });
  return rows;
}

/** The space's budgets (`space` and `space_member`), loaded by workspace. */
export async function spaceBudgetsOf(workspaceId: string, now: Date = new Date()): Promise<SpendBudget[]> {
  if (!UUID_RE.test(workspaceId)) return [];
  const ref = workspaceId.toLowerCase();
  const hit = spaceBudgetCache.get(ref);
  if (hit && hit.expires > now.getTime()) return hit.rows;
  const rows = await getDb().select().from(spendBudgets)
    .where(and(inArray(spendBudgets.scopeKind, [...SPACE_SCOPE_KINDS]), eq(spendBudgets.scopeRef, ref)));
  remember(spaceBudgetCache, ref, { rows, expires: now.getTime() + CACHE_TTL_MS });
  return rows;
}

async function groupBudgetsExist(now: Date): Promise<boolean> {
  if (groupBudgetsExistCache && groupBudgetsExistCache.expires > now.getTime()) return groupBudgetsExistCache.value;
  const [row] = await getDb().select({ id: spendBudgets.id }).from(spendBudgets)
    .where(eq(spendBudgets.scopeKind, 'group_channel')).limit(1);
  groupBudgetsExistCache = { value: !!row, expires: now.getTime() + CACHE_TTL_MS };
  return !!row;
}

async function groupBudgetsOf(groupChannelId: string, now: Date): Promise<SpendBudget[]> {
  const hit = groupBudgetCache.get(groupChannelId);
  if (hit && hit.expires > now.getTime()) return hit.rows;
  const rows = await getDb().select().from(spendBudgets)
    .where(and(eq(spendBudgets.scopeKind, 'group_channel'), eq(spendBudgets.scopeRef, groupChannelId)));
  remember(groupBudgetCache, groupChannelId, { rows, expires: now.getTime() + CACHE_TTL_MS });
  return rows;
}

/** The group channel a session belongs to, or null (a 1:1 session, or no such session). */
async function groupChannelOfSession(sessionId: string): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null;
  if (sessionGroupCache.has(sessionId)) return sessionGroupCache.get(sessionId) ?? null;
  const [row] = await getDb().select({ groupChannelId: sessions.groupChannelId }).from(sessions)
    .where(eq(sessions.id, sessionId)).limit(1);
  if (!row) return null; // not cached: the session may not be written yet
  if (sessionGroupCache.size >= CACHE_MAX) sessionGroupCache.clear();
  sessionGroupCache.set(sessionId, row.groupChannelId ?? null);
  return row.groupChannelId ?? null;
}

/** Spend of one budget over a period, split by how the cost was measured. */
export interface SpendBreakdown {
  /** SUM(cost_log.total_cost) — what enforcement compares to the limit. */
  totalUsd: number;
  /** The part of `totalUsd` computed from model pricing, not reported by the provider. */
  estimatedUsd: number;
  /** Calls whose cost is unknown (`costSource` 'unknown'): logged at $0. */
  unmeasuredCalls: number;
}

/**
 * The one spend query for a budget scope. Enforcement (`checkSpend`) and the
 * read API (`budgetStatusesFor`) both go through it, so a budget card can
 * never show a figure the pause does not act on. A `space_member` budget is
 * computed for one member (`memberId`).
 */
async function spendSince(budget: SpendBudget, start: Date, now: Date, memberId?: string): Promise<SpendBreakdown> {
  if (budget.scopeKind === 'space_member' && !memberId) throw new Error('A space_member budget is computed per member');
  // A group channel's or a space's spend is theirs, whoever the budget is filed under.
  const key = budget.scopeKind === 'group_channel' ? `group:${budget.scopeRef ?? ''}:${budget.period}`
    : budget.scopeKind === 'space' ? `space:${budget.scopeRef ?? ''}:${budget.period}`
      : budget.scopeKind === 'space_member' ? `space_member:${budget.scopeRef ?? ''}:${memberId}:${budget.period}`
        : `${budget.userId}:${budget.scopeKind}:${budget.scopeRef ?? ''}:${budget.period}`;
  const hit = spendCache.get(key);
  if (hit && hit.start === start.getTime() && hit.expires > now.getTime()) return hit.value;

  const db = getDb();
  const { estimatedCost, unknownCostRequests } = costSourceAggregates();
  const fields = {
    s: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float8`,
    est: estimatedCost,
    unk: unknownCostRequests,
  };
  // Personal scopes: the user's rows a sponsor did not pay for.
  const base = and(eq(costLog.userId, budget.userId ?? ''), gte(costLog.createdAt, start), ne(costLog.funding, 'sponsor'));
  const sponsoredIn = (spaceId: string) => and(
    gte(costLog.createdAt, start), eq(costLog.funding, 'sponsor'), sql`${costLog.workspaceId}::text = ${spaceId}`,
  );
  let rows: { s: number; est: number; unk: number }[];
  if (budget.scopeKind === 'space') {
    // Every member's sponsored calls in the space.
    rows = UUID_RE.test(budget.scopeRef ?? '') ? await db.select(fields).from(costLog).where(sponsoredIn(budget.scopeRef as string)) : [];
  } else if (budget.scopeKind === 'space_member') {
    rows = UUID_RE.test(budget.scopeRef ?? '')
      ? await db.select(fields).from(costLog).where(and(sponsoredIn(budget.scopeRef as string), eq(costLog.userId, memberId as string)))
      : [];
  } else if (budget.scopeKind === 'group_channel') {
    // Every member's calls in the channel's sessions, not the owner's alone.
    rows = UUID_RE.test(budget.scopeRef ?? '')
      ? await db.select(fields).from(costLog)
        .innerJoin(sessions, eq(sessions.id, costLog.sessionId))
        .where(and(gte(costLog.createdAt, start), eq(sessions.groupChannelId, budget.scopeRef as string)))
      : [];
  } else if (budget.scopeKind === 'role') {
    rows = await db.select(fields).from(costLog)
      .innerJoin(agents, eq(agents.id, costLog.agentId))
      .where(and(base, eq(agents.role, budget.scopeRef ?? '')));
  } else if (budget.scopeKind === 'workspace') {
    rows = await db.select(fields).from(costLog)
      .leftJoin(agents, eq(agents.id, costLog.agentId))
      .leftJoin(sessions, eq(sessions.id, costLog.sessionId))
      .where(and(base, sql`COALESCE(${agents.workspaceId}, ${sessions.workspaceId})::text = ${budget.scopeRef ?? ''}`));
  } else {
    rows = await db.select(fields).from(costLog).where(base);
  }
  const value: SpendBreakdown = {
    totalUsd: Number(rows[0]?.s ?? 0),
    estimatedUsd: Number(rows[0]?.est ?? 0),
    unmeasuredCalls: Number(rows[0]?.unk ?? 0),
  };
  remember(spendCache, key, { start: start.getTime(), value, expires: now.getTime() + CACHE_TTL_MS });
  return value;
}

/** Whether `b`, one of the user's own budgets, covers this invocation (group budgets are matched by session). */
function applies(b: SpendBudget, scope: SpendScope): boolean {
  if (b.scopeKind === 'user') return true;
  if (b.scopeKind === 'role') return !!scope.role && b.scopeRef === scope.role;
  if (b.scopeKind === 'group_channel' || isSpaceScopeKind(b.scopeKind)) return false;
  return !!scope.workspaceId && b.scopeRef === scope.workspaceId.toLowerCase();
}

/** `#release`, or the channel id, for each group channel id. */
async function groupLabels(ids: string[]): Promise<Map<string, string>> {
  const valid = ids.filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return new Map();
  const rows = await getDb().select({ id: groupChannels.id, label: groupChannels.label, channelId: groupChannels.channelId })
    .from(groupChannels).where(inArray(groupChannels.id, valid));
  return new Map(rows.map((r) => [r.id, r.label ?? r.channelId]));
}

async function scopeLabel(b: SpendBudget): Promise<string> {
  const every = b.period === 'day' ? 'daily' : 'monthly';
  if (b.scopeKind === 'user') return `Your ${every}`;
  if (b.scopeKind === 'space') return `The space's sponsored ${every}`;
  if (b.scopeKind === 'space_member') return `Your ${every} share of the space's sponsored`;
  if (b.scopeKind === 'group_channel') {
    const label = (await groupLabels([b.scopeRef ?? ''])).get(b.scopeRef ?? '');
    return `The group channel ${label ?? b.scopeRef}'s ${every}`;
  }
  return `The ${b.scopeKind} "${b.scopeRef}" ${every}`;
}

async function notify(b: SpendBudget, type: string, title: string, body: string, spentUsd: number, to?: string | null): Promise<void> {
  const recipient = to === undefined ? b.userId : to;
  if (!recipient) {
    securityLogger.warn({ budgetId: b.id, type }, 'Spend budget notice has no recipient (no sponsor and no author)');
    return;
  }
  const { getNotificationService } = await import('@/core/notification-service');
  await getNotificationService().notify(recipient, type, title, body, {
    budgetId: b.id, scopeKind: b.scopeKind, scopeRef: b.scopeRef, period: b.period,
    spentUsd, limitUsd: Number(b.limitUsd),
  }, isSpaceScopeKind(b.scopeKind) ? { workspaceId: b.scopeRef } : {});
}

/**
 * Who hears about a `space` budget: the sponsor, who pays, else the owner
 * who wrote the budget; null when there is neither (the pause still holds).
 * Any other budget: its user.
 */
async function recipientOf(b: SpendBudget): Promise<string | null> {
  if (b.scopeKind !== 'space') return b.userId;
  const { spaceFunding } = await import('@/core/spaces/funding');
  const funding = await spaceFunding(b.scopeRef ?? '');
  return funding.sponsorUserId ?? b.userId;
}

/**
 * The per-member cap of a space for one member (§9.2): computed from
 * cost_log, never stamped on the shared budget row. The warning and the
 * pause notice are claimed once per member and period in
 * `space_member_notices`. Throws when the member is at the cap.
 */
async function checkMemberCap(b: SpendBudget, memberId: string, now: Date): Promise<SpendStatus> {
  const start = periodStart(b.period, now);
  const limitUsd = Number(b.limitUsd);
  const spentUsd = (await spendSince(b, start, now, memberId)).totalUsd;
  const workspaceId = b.scopeRef as string;
  const claim = async (column: 'warnedAt' | 'pausedAt'): Promise<boolean> => {
    const field = spaceMemberNotices[column];
    const set = column === 'warnedAt' ? { warnedAt: now } : { pausedAt: now };
    const rows = await getDb().insert(spaceMemberNotices)
      .values({ workspaceId, userId: memberId, period: b.period, ...set })
      .onConflictDoUpdate({
        target: [spaceMemberNotices.workspaceId, spaceMemberNotices.userId, spaceMemberNotices.period],
        set,
        setWhere: or(isNull(field), lt(field, start)),
      })
      .returning({ userId: spaceMemberNotices.userId });
    return rows.length > 0;
  };
  if (spentUsd >= limitUsd) {
    const reason = {
      budgetId: b.id, userId: memberId, scopeKind: b.scopeKind, scopeRef: b.scopeRef,
      period: b.period, spentUsd, limitUsd, resetsAt: periodEnd(b.period, now).toISOString(),
    };
    if (await claim('pausedAt')) {
      securityLogger.warn(reason, 'Space member cap reached, pausing their sponsored work');
      await notify(b, 'spend_budget_paused', 'Your share of the space budget is used up',
        `${await scopeLabel(b)} budget of $${limitUsd.toFixed(2)} is spent ($${spentUsd.toFixed(2)}).`, spentUsd, memberId);
    }
    throw new SpendBudgetExceededError(reason);
  }
  if (spentUsd >= limitUsd * b.warnRatio) {
    if (await claim('warnedAt')) {
      await notify(b, 'spend_budget_warning', 'Your share of the space budget is almost used',
        `${await scopeLabel(b)} spend is $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}.`, spentUsd, memberId);
    }
    return { budget: b, spentUsd, limitUsd, state: 'warn' };
  }
  return { budget: b, spentUsd, limitUsd, state: 'ok' };
}

/**
 * Evaluate every budget that applies to this invocation. Throws
 * `SpendBudgetExceededError` (and stamps `paused_at`) when one is at or over
 * its limit; warns once per period at `warn_ratio`. System / local principals
 * have no budgets.
 */
export async function checkSpend(scope: SpendScope, now: Date = new Date()): Promise<SpendStatus[]> {
  if (!UUID_RE.test(scope.userId)) return [];
  let budgets: SpendBudget[];
  if (scope.funding === 'sponsor') {
    // Sponsored: the space's budgets, never the requester's own.
    if (!scope.spaceId) throw new Error('A sponsored invocation needs its space (SpendScope.spaceId)');
    budgets = await spaceBudgetsOf(scope.spaceId, now);
  } else {
    const own = (await budgetsOf(scope.userId, now)).filter(b => applies(b, scope));
    // A group channel's budget, for an invocation in one of its sessions.
    const groupChannelId = scope.sessionId && await groupBudgetsExist(now)
      ? await groupChannelOfSession(scope.sessionId)
      : null;
    budgets = groupChannelId ? [...own, ...await groupBudgetsOf(groupChannelId, now)] : own;
  }
  if (budgets.length === 0) return [];

  const db = getDb();
  const out: SpendStatus[] = [];
  for (const b of budgets) {
    if (b.scopeKind === 'space_member') {
      out.push(await checkMemberCap(b, scope.userId, now));
      continue;
    }
    const start = periodStart(b.period, now);
    const limitUsd = Number(b.limitUsd);
    const spentUsd = (await spendSince(b, start, now)).totalUsd;
    const reason = {
      budgetId: b.id, userId: b.userId ?? scope.userId, scopeKind: b.scopeKind, scopeRef: b.scopeRef,
      period: b.period, spentUsd, limitUsd, resetsAt: periodEnd(b.period, now).toISOString(),
    };

    if (b.pausedAt && b.pausedAt >= start) throw new SpendBudgetExceededError(reason);

    if (spentUsd >= limitUsd) {
      const claimed = await db.update(spendBudgets)
        .set({ pausedAt: now, updatedAt: now })
        .where(and(eq(spendBudgets.id, b.id), or(isNull(spendBudgets.pausedAt), lt(spendBudgets.pausedAt, start))))
        .returning({ id: spendBudgets.id });
      invalidateBudget(b);
      if (claimed.length > 0) {
        securityLogger.warn(reason, 'Spend budget exhausted, pausing');
        await notify(b, 'spend_budget_paused', 'Spend budget reached — agents paused',
          `${await scopeLabel(b)} budget of $${limitUsd.toFixed(2)} is spent ($${spentUsd.toFixed(2)}).`, spentUsd, await recipientOf(b));
      }
      throw new SpendBudgetExceededError(reason);
    }

    if (spentUsd >= limitUsd * b.warnRatio) {
      if (!(b.warnedAt && b.warnedAt >= start)) {
        const claimed = await db.update(spendBudgets)
          .set({ warnedAt: now, updatedAt: now })
          .where(and(eq(spendBudgets.id, b.id), or(isNull(spendBudgets.warnedAt), lt(spendBudgets.warnedAt, start))))
          .returning({ id: spendBudgets.id });
        invalidateBudget(b);
        if (claimed.length > 0) {
          await notify(b, 'spend_budget_warning', 'Spend budget almost reached',
            `${await scopeLabel(b)} spend is $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}.`, spentUsd, await recipientOf(b));
        }
      }
      out.push({ budget: b, spentUsd, limitUsd, state: 'warn' });
    } else {
      out.push({ budget: b, spentUsd, limitUsd, state: 'ok' });
    }
  }
  return out;
}

// ── Read view (GET /api/spend-budgets/me, admin list) ───────────────

/** One budget as the user-facing and admin screens show it. */
export interface SpendBudgetView {
  id: string;
  /** The budget's user; a space budget's author (null once their account is gone). */
  userId: string | null;
  scopeKind: SpendScopeKind;
  scopeRef: string | null;
  /** Workspace name for a workspace budget; the role name for a role budget; the channel's label for a group channel budget. */
  scopeName: string | null;
  period: SpendPeriod;
  limitUsd: number;
  warnRatio: number;
  /** Spend this period — the same sum `checkSpend` compares to the limit. */
  spentUsd: number;
  /** Part of `spentUsd` computed from model pricing rather than reported. */
  estimatedUsd: number;
  /** Calls this period logged at $0 because their cost is unknown. */
  unmeasuredCalls: number;
  /**
   * True when the figure is known to under-count: some calls this period
   * came from CLI / subscription providers that report no cost.
   */
  unmeasured: boolean;
  /** spent / limit × 100, not capped at 100. */
  percent: number;
  /**
   * Judged against the current period start: `paused` when the pause stamp
   * is from this period or spend is already at the limit (the next check
   * would pause), `warned` at or above the warn ratio.
   */
  state: 'ok' | 'warned' | 'paused';
  periodStart: string;
  /** Start of the next period, when a pause lifts on its own. */
  resetsAt: string;
  /** This period's stamps only — a stamp from an earlier period is inert and reported as null. */
  pausedAt: string | null;
  warnedAt: string | null;
  updatedAt: string;
}

/**
 * Every budget stored for a user, with its current-period spend and state.
 * Read-only: unlike `checkSpend` it stamps nothing and sends no notification.
 * Budget rows are read fresh (an admin's resume shows at once); spend sums
 * share `checkSpend`'s 30s cache.
 */
export async function budgetStatusesFor(
  userId: string,
  now: Date = new Date(),
  /** The user's budget rows when the caller already has them (admin list). */
  rows?: SpendBudget[],
): Promise<SpendBudgetView[]> {
  if (!UUID_RE.test(userId)) return [];
  const budgets = rows ?? await listBudgets(userId);
  if (budgets.length === 0) return [];

  const wsNames = new Map<string, string>();
  if (budgets.some(b => b.scopeKind === 'workspace')) {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    for (const w of await getOrgWorkspaceManager().listOwn(userId)) wsNames.set(w.id.toLowerCase(), w.name);
  }

  const groupNames = budgets.some(b => b.scopeKind === 'group_channel')
    ? await groupLabels(budgets.filter(b => b.scopeKind === 'group_channel').map(b => b.scopeRef ?? ''))
    : new Map<string, string>();

  return budgetViews(budgets, now, (b) => b.scopeKind === 'workspace' ? (wsNames.get(b.scopeRef ?? '') ?? null)
    : b.scopeKind === 'group_channel' ? (groupNames.get(b.scopeRef ?? '') ?? null)
      : b.scopeKind === 'role' ? b.scopeRef : null);
}

const KIND_ORDER: Record<SpendScopeKind, number> = { user: 0, role: 1, workspace: 2, group_channel: 3, space: 4, space_member: 5 };

/**
 * Views of `budgets`, sorted, each with its current-period spend: a
 * `space_member` budget is shown for `memberId` (the viewer's own share,
 * with their own notice stamps).
 */
async function budgetViews(
  budgets: SpendBudget[],
  now: Date,
  scopeName: (b: SpendBudget) => string | null,
  member?: { id: string; notices: Map<SpendPeriod, { warnedAt: Date | null; pausedAt: Date | null }> },
): Promise<SpendBudgetView[]> {
  const sorted = [...budgets].sort((a, b) =>
    KIND_ORDER[a.scopeKind] - KIND_ORDER[b.scopeKind]
    || (a.scopeRef ?? '').localeCompare(b.scopeRef ?? '')
    || a.period.localeCompare(b.period));

  // One spend query per budget, run concurrently.
  const spends = await Promise.all(sorted.map(b => spendSince(b, periodStart(b.period, now), now, b.scopeKind === 'space_member' ? member?.id : undefined)));
  return sorted.map((b, i): SpendBudgetView => {
    const start = periodStart(b.period, now);
    const spend = spends[i];
    const limitUsd = Number(b.limitUsd);
    const stamps = b.scopeKind === 'space_member' ? (member?.notices.get(b.period) ?? { warnedAt: null, pausedAt: null }) : b;
    const pausedAt = stamps.pausedAt && stamps.pausedAt >= start ? stamps.pausedAt : null;
    const warnedAt = stamps.warnedAt && stamps.warnedAt >= start ? stamps.warnedAt : null;
    const state: SpendBudgetView['state'] = pausedAt || spend.totalUsd >= limitUsd ? 'paused'
      : warnedAt || spend.totalUsd >= limitUsd * b.warnRatio ? 'warned' : 'ok';
    return {
      id: b.id,
      userId: b.userId,
      scopeKind: b.scopeKind,
      scopeRef: b.scopeRef,
      scopeName: scopeName(b),
      period: b.period,
      limitUsd,
      warnRatio: b.warnRatio,
      spentUsd: spend.totalUsd,
      estimatedUsd: spend.estimatedUsd,
      unmeasuredCalls: spend.unmeasuredCalls,
      unmeasured: spend.unmeasuredCalls > 0,
      percent: limitUsd > 0 ? Math.round((spend.totalUsd / limitUsd) * 1000) / 10 : 0,
      state,
      periodStart: start.toISOString(),
      resetsAt: periodEnd(b.period, now).toISOString(),
      pausedAt: pausedAt?.toISOString() ?? null,
      warnedAt: warnedAt?.toISOString() ?? null,
      updatedAt: b.updatedAt.toISOString(),
    };
  });
}

// ── Space budgets (PUT /api/spaces/:id/budget) ──────────────────────

/**
 * A space's budgets with their spend: the `space` budget's total, and the
 * `space_member` cap with `memberId`'s own share. The caller checked the
 * membership.
 */
export async function spaceBudgetStatuses(workspaceId: string, memberId: string, now: Date = new Date()): Promise<SpendBudgetView[]> {
  if (!UUID_RE.test(workspaceId)) return [];
  const ref = workspaceId.toLowerCase();
  const budgets = await getDb().select().from(spendBudgets)
    .where(and(inArray(spendBudgets.scopeKind, [...SPACE_SCOPE_KINDS]), eq(spendBudgets.scopeRef, ref)));
  if (budgets.length === 0) return [];
  const notices = await getDb().select().from(spaceMemberNotices)
    .where(and(eq(spaceMemberNotices.workspaceId, ref), eq(spaceMemberNotices.userId, memberId)));
  return budgetViews(budgets, now, () => null, {
    id: memberId,
    notices: new Map(notices.map((n) => [n.period, { warnedAt: n.warnedAt, pausedAt: n.pausedAt }])),
  });
}

/**
 * Set (or, with `limitUsd: null`, remove) a space budget of `kind` and
 * `period`. `authorId` is filed as its user, author only. Changing it clears
 * the warning and the pause, as `upsertBudget` does; the per-member notices
 * of the period are cleared too.
 */
export async function setSpaceBudget(input: {
  workspaceId: string;
  authorId: string;
  kind: SpaceScopeKind;
  period: SpendPeriod;
  limitUsd: number | null;
  warnRatio?: number;
}, db: Pick<ReturnType<typeof getDb>, 'insert' | 'update' | 'delete'> = getDb()): Promise<SpendBudget | null> {
  if (!UUID_RE.test(input.workspaceId)) throw new Error('setSpaceBudget: not a space id');
  const scopeRef = input.workspaceId.toLowerCase();
  const where = and(eq(spendBudgets.scopeKind, input.kind), eq(spendBudgets.scopeRef, scopeRef), eq(spendBudgets.period, input.period));
  if (input.limitUsd === null) {
    const gone = await db.delete(spendBudgets).where(where)
      .returning({ userId: spendBudgets.userId, scopeKind: spendBudgets.scopeKind, scopeRef: spendBudgets.scopeRef });
    for (const r of gone) invalidateBudget(r);
    return null;
  }
  const values = {
    userId: input.authorId,
    limitUsd: String(input.limitUsd),
    ...(input.warnRatio !== undefined && { warnRatio: input.warnRatio }),
    warnedAt: null,
    pausedAt: null,
    updatedAt: new Date(),
  };
  const [row] = await db.insert(spendBudgets)
    .values({ scopeKind: input.kind, scopeRef, period: input.period, ...values })
    .onConflictDoUpdate({
      target: [spendBudgets.scopeKind, spendBudgets.scopeRef, spendBudgets.period],
      targetWhere: sql`${spendBudgets.scopeKind} IN ('space','space_member')`,
      set: values,
    })
    .returning();
  if (input.kind === 'space_member') {
    await db.update(spaceMemberNotices).set({ warnedAt: null, pausedAt: null })
      .where(and(eq(spaceMemberNotices.workspaceId, scopeRef), eq(spaceMemberNotices.period, input.period)));
  }
  invalidateBudget(row);
  return row;
}

/**
 * Whether the space's sponsored work is paused by its `space` budget: when
 * the last pause lifts, or null. Read-only (the group handler's gate for a
 * channel bound to a space, §9.4).
 */
export async function spaceBudgetPause(workspaceId: string, now: Date = new Date()): Promise<{ resetsAt: string } | null> {
  let resetsAt: Date | null = null;
  for (const b of await spaceBudgetsOf(workspaceId, now)) {
    if (b.scopeKind !== 'space') continue;
    const start = periodStart(b.period, now);
    const used = (b.pausedAt && b.pausedAt >= start) || (await spendSince(b, start, now)).totalUsd >= Number(b.limitUsd);
    const end = periodEnd(b.period, now);
    if (used && (!resetsAt || end > resetsAt)) resetsAt = end;
  }
  return resetsAt ? { resetsAt: resetsAt.toISOString() } : null;
}

// ── CRUD (admin routes) ─────────────────────────────────────────────

/** Personal budgets (a user's, or every user's). Space budgets are the space's: `spaceBudgetStatuses`. */
export function listBudgets(userId?: string): Promise<SpendBudget[]> {
  const q = getDb().select().from(spendBudgets);
  return userId ? q.where(and(eq(spendBudgets.userId, userId), notSpaceKind)) : q.where(notSpaceKind);
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
  scopeKind: Exclude<SpendScopeKind, SpaceScopeKind>;
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
  const insert = getDb().insert(spendBudgets)
    .values({ userId: input.userId, scopeKind: input.scopeKind, scopeRef, period: input.period, ...values });
  // A group channel has one budget per period whoever it is filed under
  // (migration 0123's partial index): a new owner takes the existing row.
  // Otherwise the unique index is NULLS NOT DISTINCT, so the conflict target
  // also catches the user-scope row whose scope_ref is NULL.
  const [row] = input.scopeKind === 'group_channel'
    ? await insert.onConflictDoUpdate({
      target: [spendBudgets.scopeRef, spendBudgets.period],
      targetWhere: sql`${spendBudgets.scopeKind} = 'group_channel'`,
      set: { ...values, userId: input.userId },
    }).returning()
    : await insert.onConflictDoUpdate({
      target: [spendBudgets.userId, spendBudgets.scopeKind, spendBudgets.scopeRef, spendBudgets.period],
      set: values,
    }).returning();
  invalidateBudget(row);
  return row;
}

/** Delete a personal budget by id (admin); a space budget is not reachable here. */
export async function deleteBudget(id: string): Promise<boolean> {
  const rows = await getDb().delete(spendBudgets).where(and(eq(spendBudgets.id, id), notSpaceKind))
    .returning({ userId: spendBudgets.userId, scopeKind: spendBudgets.scopeKind, scopeRef: spendBudgets.scopeRef });
  for (const r of rows) invalidateBudget(r);
  return rows.length > 0;
}

// ── Group channels ──────────────────────────────────────────────────

/**
 * Whether a group channel's spend budget is used up, for the channel's own
 * gate before it starts a turn: when the last pause lifts, or null. Read-only;
 * the pause is stamped, and its notification sent, by `checkSpend` on a run.
 */
export async function groupChannelPause(
  groupChannelId: string,
  /** Who pays the channel's turns: a sponsored channel answers to its space's budget (§9.2). */
  scope: Pick<SpendScope, 'funding' | 'spaceId'> = { funding: 'own', spaceId: null },
  now: Date = new Date(),
): Promise<{ resetsAt: string } | null> {
  if (scope.funding === 'sponsor') {
    if (!scope.spaceId) throw new Error('A sponsored channel needs its space');
    return spaceBudgetPause(scope.spaceId, now);
  }
  if (!UUID_RE.test(groupChannelId) || !(await groupBudgetsExist(now))) return null;
  let resetsAt: Date | null = null;
  for (const b of await groupBudgetsOf(groupChannelId, now)) {
    const start = periodStart(b.period, now);
    const used = (b.pausedAt && b.pausedAt >= start) || (await spendSince(b, start, now)).totalUsd >= Number(b.limitUsd);
    const end = periodEnd(b.period, now);
    if (used && (!resetsAt || end > resetsAt)) resetsAt = end;
  }
  return resetsAt ? { resetsAt: resetsAt.toISOString() } : null;
}

/** A group channel's budgets with their spend and state (Admin → Group channels). */
export async function groupChannelBudgetStatuses(groupChannelId: string, now: Date = new Date()): Promise<SpendBudgetView[]> {
  if (!UUID_RE.test(groupChannelId)) return [];
  const rows = await getDb().select().from(spendBudgets)
    .where(and(eq(spendBudgets.scopeKind, 'group_channel'), eq(spendBudgets.scopeRef, groupChannelId)));
  return rows.length > 0 && rows[0].userId ? budgetStatusesFor(rows[0].userId, now, rows) : [];
}

/** File a channel's budgets under its new owner (takeover), who is notified from then on. */
export async function moveGroupChannelBudgets(groupChannelId: string, ownerUserId: string): Promise<void> {
  const moved = await getDb().update(spendBudgets)
    .set({ userId: ownerUserId, updatedAt: new Date() })
    .where(and(eq(spendBudgets.scopeKind, 'group_channel'), eq(spendBudgets.scopeRef, groupChannelId)))
    .returning({ userId: spendBudgets.userId, scopeKind: spendBudgets.scopeKind, scopeRef: spendBudgets.scopeRef });
  for (const r of moved) invalidateBudget(r);
  budgetCache.clear(); // the previous owner's cached rows still hold them
}

/** Drop a channel's budgets with its enrolment. */
export async function deleteGroupChannelBudgets(groupChannelId: string): Promise<void> {
  const gone = await getDb().delete(spendBudgets)
    .where(and(eq(spendBudgets.scopeKind, 'group_channel'), eq(spendBudgets.scopeRef, groupChannelId)))
    .returning({ userId: spendBudgets.userId, scopeKind: spendBudgets.scopeKind, scopeRef: spendBudgets.scopeRef });
  for (const r of gone) invalidateBudget(r);
}

/**
 * Clear a budget's pause. Only useful once spend is back under the limit
 * (limit raised elsewhere, or costs corrected); otherwise the next check
 * pauses it again.
 */
export async function resetPause(id: string): Promise<SpendBudget | null> {
  const [row] = await getDb().update(spendBudgets)
    .set({ pausedAt: null, updatedAt: new Date() })
    .where(and(eq(spendBudgets.id, id), notSpaceKind))
    .returning();
  if (row) invalidateBudget(row);
  return row ?? null;
}

export function _resetSpendBudgetsForTests(): void {
  budgetCache.clear();
  spendCache.clear();
  groupBudgetCache.clear();
  groupBudgetsExistCache = null;
  sessionGroupCache.clear();
  spaceBudgetCache.clear();
}

export function _spendCacheSizeForTests(): number {
  return spendCache.size;
}
