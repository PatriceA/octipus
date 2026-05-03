/**
 * Per-user quotas — Phase 3c-1 (read-side).
 *
 * Three quota dimensions, each with a per-user override that falls
 * back to the global config default:
 *
 *   - Concurrent agents — `agents WHERE user_id = … AND status='running'`
 *   - Daily token budget — sum of `totalTokens` across the user's
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

export class QuotaManager {
  /** Resolve the effective limits for a user. */
  async getEffectiveQuota(userId: string): Promise<EffectiveQuota> {
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
   * No cached counters: simpler to reason about, and the queries are
   * cheap enough at the scale this targets (single-user → small org).
   * If it ever becomes a hot path, swap to a Redis-backed counter +
   * periodic reconciliation.
   */
  async getUsage(userId: string): Promise<QuotaUsage> {
    const db = getDb();

    // Concurrent: agents.user_id is `text` and may be either a UUID or
    // the legacy 'system'/'local' sentinel. Compare as text.
    const concurrentRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.status, 'running')));

    // Tokens today: sum totalTokens across agents created since 00:00 UTC.
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const tokenRows = await db
      .select({ s: sql<number>`COALESCE(SUM(${agents.totalTokens}), 0)::int` })
      .from(agents)
      .where(and(eq(agents.userId, userId), gte(agents.createdAt, startOfDay)));

    // API calls last minute: audit_log row with action='api_request'.
    // userId there is `text` and stores 'system' for unauth so the
    // text comparison works.
    const minuteAgo = new Date(Date.now() - 60_000);
    const apiRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(
        eq(auditLog.userId, userId),
        eq(auditLog.action, 'api_request'),
        gte(auditLog.createdAt, minuteAgo),
      ));

    return {
      concurrentAgents: concurrentRows[0]?.c ?? 0,
      tokensToday: tokenRows[0]?.s ?? 0,
      apiCallsLastMinute: apiRows[0]?.c ?? 0,
    };
  }

  /**
   * Pre-flight check — would `delta` more units of `kind` push the
   * user over their effective cap? Reserved for 3c-2's enforcement
   * sites (agent spawn, LLM call, API request).
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
    const [quota, usage] = await Promise.all([
      this.getEffectiveQuota(userId),
      this.getUsage(userId),
    ]);
    const checks = {
      concurrentAgents: { current: usage.concurrentAgents, max: quota.maxConcurrentAgents },
      tokensPerDay: { current: usage.tokensToday, max: quota.maxTokensPerDay },
      apiCallsPerMinute: { current: usage.apiCallsLastMinute, max: quota.maxApiCallsPerMinute },
    };
    const c = checks[kind];
    if (c.current + delta > c.max) {
      securityLogger.warn(
        { userId, kind, current: c.current, max: c.max, delta },
        'Quota would be exceeded',
      );
      return { allowed: false, reason: { kind, ...c } };
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
    const db = getDb();
    const existing = await readOverride(userId);

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
}
