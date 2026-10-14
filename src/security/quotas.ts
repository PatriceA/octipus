/**
 * Per-user quotas — Phase 3c-1 (read-side).
 *
 * Three quota dimensions, each with a per-user override that falls
 * back to the global config default:
 *
 *   - Concurrent agents — `agents WHERE user_id = … AND status='running'`
 *   - Daily token budget — sum of `billableTokens` (the spend proxy) across
 *     agents created in the current UTC day
 *   - API requests per minute — count of `audit_log` rows with
 *     `action='api_request'` for the user in the last 60 seconds
 *
 * `getEffectiveQuota(userId)` resolves the cap (override or default).
 * `getUsage(userId)` reads the current values straight from the DB.
 * `willExceed(userId, kind, delta)` is the contract the future
 * enforcement points (Phase 3c-2: agent worker, rate-limiter) call
 * before letting the operation through.
 *
 * Reads use raw SQL via `executeRaw` / `queryRaw` so the manager
 * doesn't transitively pull every drizzle schema into the agent
 * worker hot path. The shape is small and the queries are stable.
 *
 * No enforcement in this commit — the admin console (3c-1 web) lets
 * operators see + set quotas, and 3c-2 wires the actual gates at
 * spawn / LLM-call / API-request time.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { auditLog } from '@/db/schema/audit';
import { type UserQuota, userQuotas } from '@/db/schema/user-quotas';
import { securityLogger } from '@/utils/logger';

export type QuotaKind = 'concurrentAgents' | 'tokensPerDay' | 'apiCallsPerMinute';

/** Effective limits for a user (override OR global default). */
export interface EffectiveQuota {
  maxConcurrentAgents: number;
  maxTokensPerDay: number;
  maxApiCallsPerMinute: number;
  /** Which fields came from a per-user override vs the global default. */
  overrides: {
    maxConcurrentAgents: boolean;
    maxTokensPerDay: boolean;
    maxApiCallsPerMinute: boolean;
  };
}

/** Current usage snapshot for a user. */
export interface QuotaUsage {
  concurrentAgents: number;
  tokensToday: number;
  apiCallsLastMinute: number;
}

/**
 * The effective cap is read on every authenticated API request (the per-user
 * rate limit) and before every model call, and changes only when an operator
 * edits it. An override write here drops the entry; another instance's write
 * lands within this window.
 */
const QUOTA_TTL_MS = 10_000;
/** See `willExceed` for why reusing the tokens-today sum loses nothing. */
const TOKENS_TODAY_TTL_MS = 5_000;
const CACHE_MAX = 5_000;
const quotaCache = new Map<string, { value: EffectiveQuota; expires: number }>();
const tokensTodayCache = new Map<string, { dayStart: number; value: number; expires: number }>();

function remember<V extends { expires: number }>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(key, value);
}

/**
 * Read the per-user override row. Returns null when the user has no
 * row (i.e. inherits every global default). Cheap PK lookup.
 */
async function readOverride(userId: string): Promise<UserQuota | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userQuotas)
    .where(eq(userQuotas.userId, userId))
    .limit(1);
  return row ?? null;
}

function startOfUtcDay(): Date {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  return startOfDay;
}

/**
 * Concurrent: agents.user_id is `text` (a system job's agents carry a
 * non-user id). Compare as text.
 */
async function countRunningAgents(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.status, 'running')));
  return rows[0]?.c ?? 0;
}

/**
 * Tokens today: sum the SPEND figure across agents created since 00:00 UTC.
 *
 * Not `total_tokens`: once prompt-cache counters were folded into
 * `inputTokens`, that column became a grand total that re-counts the whole
 * replayed context every turn — a 100k-context session costing ~2.5k/turn
 * recorded ~102k/turn and hard-blocked a 500k/day cap after five turns,
 * having spent ~5% of it. A daily cap is a cost control, so it sums
 * `billable_tokens` (fresh input + output, cache reads excluded), the same
 * figure the per-agent budget gate compares. Legacy rows predate the column
 * and fall back to `total_tokens` rather than counting as free.
 * Only the user's own agents: a sponsor paid for sponsored ones (coworking
 * spec §9.2), so they count against the space's budgets, not this cap.
 * Concurrency counts every running agent.
 */
async function sumTokensToday(userId: string, startOfDay: Date): Promise<number> {
  const rows = await getDb()
    .select({ s: sql<number>`COALESCE(SUM(COALESCE(${agents.billableTokens}, ${agents.totalTokens})), 0)::int` })
    .from(agents)
    .where(and(eq(agents.userId, userId), gte(agents.createdAt, startOfDay), eq(agents.funding, 'own')));
  return rows[0]?.s ?? 0;
}

/**
 * API calls last minute: audit_log row with action='api_request'.
 * userId there is `text` and stores 'system' for unauth so the
 * text comparison works.
 */
async function countApiCallsLastMinute(userId: string): Promise<number> {
  const minuteAgo = new Date(Date.now() - 60_000);
  const rows = await getDb()
    .select({ c: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(
      eq(auditLog.userId, userId),
      eq(auditLog.action, 'api_request'),
      gte(auditLog.createdAt, minuteAgo),
    ));
  return rows[0]?.c ?? 0;
}

async function cachedTokensToday(userId: string): Promise<number> {
  const dayStart = startOfUtcDay();
  const now = Date.now();
  const hit = tokensTodayCache.get(userId);
  // A new UTC day starts from zero, whatever the entry's age.
  if (hit && hit.dayStart === dayStart.getTime() && hit.expires > now) return hit.value;
  const value = await sumTokensToday(userId, dayStart);
  remember(tokensTodayCache, userId, { dayStart: dayStart.getTime(), value, expires: now + TOKENS_TODAY_TTL_MS });
  return value;
}

function currentUsage(userId: string, kind: QuotaKind): Promise<number> {
  switch (kind) {
    case 'concurrentAgents': return countRunningAgents(userId);
    case 'tokensPerDay': return cachedTokensToday(userId);
    case 'apiCallsPerMinute': return countApiCallsLastMinute(userId);
  }
}

export class QuotaManager {
  /** Resolve the effective limits for a user. */
  async getEffectiveQuota(userId: string): Promise<EffectiveQuota> {
    const hit = quotaCache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await this.readEffectiveQuota(userId);
    remember(quotaCache, userId, { value, expires: Date.now() + QUOTA_TTL_MS });
    return value;
  }

  private async readEffectiveQuota(userId: string): Promise<EffectiveQuota> {
    const cfg = getConfig();
    const defaults = {
      maxConcurrentAgents: cfg.agent.maxConcurrentAgents,
      // 0 means unlimited in the config; surface as a very large
      // number so the caller doesn't have to special-case zero.
      maxTokensPerDay: cfg.agent.maxTokenBudget > 0 ? cfg.agent.maxTokenBudget : Number.MAX_SAFE_INTEGER,
      maxApiCallsPerMinute: cfg.api.rateLimitMax,
    };

    const row = await readOverride(userId);
    if (!row) {
      return {
        ...defaults,
        overrides: { maxConcurrentAgents: false, maxTokensPerDay: false, maxApiCallsPerMinute: false },
      };
    }
    return {
      maxConcurrentAgents: row.maxConcurrentAgents ?? defaults.maxConcurrentAgents,
      maxTokensPerDay: row.maxTokensPerDay ?? defaults.maxTokensPerDay,
      maxApiCallsPerMinute: row.maxApiCallsPerMinute ?? defaults.maxApiCallsPerMinute,
      overrides: {
        maxConcurrentAgents: row.maxConcurrentAgents !== null,
        maxTokensPerDay: row.maxTokensPerDay !== null,
        maxApiCallsPerMinute: row.maxApiCallsPerMinute !== null,
      },
    };
  }

  /**
   * Compute the user's current usage straight from the canonical tables.
   *
   * No cached counters: this is what the admin console shows, so it reads
   * the tables as they are now. The enforcement path (`willExceed`) reads
   * only the dimension it gates; see the note there.
   */
  async getUsage(userId: string): Promise<QuotaUsage> {
    const [concurrentAgents, tokensToday, apiCallsLastMinute] = await Promise.all([
      countRunningAgents(userId),
      sumTokensToday(userId, startOfUtcDay()),
      countApiCallsLastMinute(userId),
    ]);
    return { concurrentAgents, tokensToday, apiCallsLastMinute };
  }

  /**
   * Pre-flight check — would `delta` more units of `kind` push the
   * user over their effective cap? Called before an agent spawn
   * (`concurrentAgents`) and before EVERY model call of a running agent
   * (`tokensPerDay`), so it reads only the dimension asked for.
   *
   * Granularity: the tokens-today sum is reused per user for
   * `TOKENS_TODAY_TTL_MS` (5 s). That loses nothing that matters: the sum
   * only moves when an agent finishes (`billable_tokens` is written on
   * completion), so a running agent's own spend is never in it, cached or
   * not. The cap is cached for `QUOTA_TTL_MS`. Concurrency is always read
   * live — a burst of spawns is exactly what it has to see.
   *
   * Returns `{ allowed: true }` when the operation is within budget.
   * Returns `{ allowed: false, reason }` with a structured reason
   * the gate can surface to the user.
   */
  async willExceed(
    userId: string,
    kind: QuotaKind,
    delta: number,
  ): Promise<{ allowed: true } | { allowed: false; reason: { kind: QuotaKind; current: number; max: number } }> {
    const [quota, current] = await Promise.all([
      this.getEffectiveQuota(userId),
      currentUsage(userId, kind),
    ]);
    const max = kind === 'concurrentAgents' ? quota.maxConcurrentAgents
      : kind === 'tokensPerDay' ? quota.maxTokensPerDay
        : quota.maxApiCallsPerMinute;
    if (current + delta > max) {
      securityLogger.warn(
        { userId, kind, current, max, delta },
        'Quota would be exceeded',
      );
      return { allowed: false, reason: { kind, current, max } };
    }
    return { allowed: true };
  }

  /**
   * Set a per-user override. Pass `null` for any field to clear it
   * (revert to global default). Audit log entries are written by the
   * caller (admin route) so we don't double-log here.
   */
  async setOverride(
    userId: string,
    patch: {
      maxConcurrentAgents?: number | null;
      maxTokensPerDay?: number | null;
      maxApiCallsPerMinute?: number | null;
    },
  ): Promise<UserQuota> {
    const existing = await readOverride(userId);
    // Dropped after the write, so a read racing it cannot re-cache the old cap.
    try {
      return await this.writeOverride(userId, existing, patch);
    } finally {
      quotaCache.delete(userId);
    }
  }

  private async writeOverride(
    userId: string,
    existing: UserQuota | null,
    patch: Parameters<QuotaManager['setOverride']>[1],
  ): Promise<UserQuota> {
    const db = getDb();
    if (existing) {
      const [row] = await db
        .update(userQuotas)
        .set({
          ...(patch.maxConcurrentAgents !== undefined && { maxConcurrentAgents: patch.maxConcurrentAgents }),
          ...(patch.maxTokensPerDay !== undefined && { maxTokensPerDay: patch.maxTokensPerDay }),
          ...(patch.maxApiCallsPerMinute !== undefined && { maxApiCallsPerMinute: patch.maxApiCallsPerMinute }),
          updatedAt: new Date(),
        })
        .where(eq(userQuotas.userId, userId))
        .returning();
      return row;
    }

    const [row] = await db.insert(userQuotas).values({
      userId,
      maxConcurrentAgents: patch.maxConcurrentAgents ?? null,
      maxTokensPerDay: patch.maxTokensPerDay ?? null,
      maxApiCallsPerMinute: patch.maxApiCallsPerMinute ?? null,
    }).returning();
    return row;
  }

  /** Drop the per-user override row entirely (revert all fields to defaults). */
  async clearOverride(userId: string): Promise<boolean> {
    const db = getDb();
    const result = await db
      .delete(userQuotas)
      .where(eq(userQuotas.userId, userId))
      .returning();
    quotaCache.delete(userId);
    return result.length > 0;
  }
}

let instance: QuotaManager | null = null;

export function getQuotaManager(): QuotaManager {
  if (!instance) instance = new QuotaManager();
  return instance;
}

export function _resetQuotaManagerForTests(): void {
  instance = null;
  quotaCache.clear();
  tokensTodayCache.clear();
}
