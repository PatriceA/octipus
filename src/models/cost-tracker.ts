import { estimateCost } from './pricing';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { Cache } from '@/db/cache';
import { type CostLogEntry, costLog, modelConfig, type NewCostLogEntry } from '@/db/schema/models';
import { modelLogger } from '@/utils/logger';

export interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  requestCount: number;
  reportedCost?: number;
  estimatedCost?: number;
  unknownCostRequests?: number;
  unknownUsageRequests?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  estimatedCacheSavings?: number;
}

export interface ModelUsageStats extends UsageStats {
  modelName: string;
}

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  requests: number;
}

export class CostTracker {
  // Resolve the live connection per access — see ModelRegistry.db: a singleton
  // must not snapshot a handle that can be recycled (max_lifetime) or closed
  // and reopened between integration-test files (else CONNECTION_ENDED).
  private get db() {
    return getDb();
  }
  private cache = new Cache(60); // 1 minute cache for stats

  /**
   * Log a model usage entry
   */
  async logUsage(entry: Omit<NewCostLogEntry, 'id' | 'createdAt'>): Promise<CostLogEntry> {
    const result = await this.db.insert(costLog).values(entry).returning();

    modelLogger.debug(
      {
        model: entry.modelName,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cost: entry.totalCost,
      },
      'Usage logged'
    );

    // Invalidate relevant caches
    await this.invalidateUserCache(entry.userId);

    return result[0];
  }

  /**
   * Calculate cost for a request.
   *
   * Convention (normalized at the provider boundary): `inputTokens` is the
   * grand-total prompt tokens INCLUDING cached reads and cache-creation;
   * `cachedInputTokens` and `cacheCreationTokens` are subsets of it, each
   * billed at its own rate rather than the base input rate.
   * Rates are explicit per model; missing cache prices produce an unknown
   * estimate instead of silently assuming a discount.
   */
  async calculateCost(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens = 0,
    cacheCreationTokens = 0
  ): Promise<number | null> {
    const model = await this.pricingModel(modelName);

    return estimateCost(model, inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens);
  }

  private async pricingModel(name: string, provider?: string, lookupByModelId = false) {
    const rows = await this.db.select().from(modelConfig)
      .where(and(lookupByModelId ? eq(modelConfig.modelId, name) : or(eq(modelConfig.name, name), eq(modelConfig.modelId, name)), provider ? eq(modelConfig.provider, provider) : undefined));
    // Prefer an exact registry name; ambiguous model IDs must not pick an
    // arbitrary alias's rates or provider account.
    return (lookupByModelId ? undefined : rows.find(row => row.name === name)) ?? (rows.length === 1 ? rows[0] : undefined);
  }

  /**
   * Log usage with automatic cost calculation
   */
  async logUsageWithCost(
    userId: string,
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    options?: {
      sessionId?: string;
      agentId?: string;
      requestType?: string;
      metadata?: Record<string, unknown>;
      cachedInputTokens?: number;
      cacheCreationTokens?: number;
      reportedCost?: number;
      usageAvailable?: boolean;
      provider?: string;
      lookupByModelId?: boolean;
    }
  ): Promise<CostLogEntry> {
    const cachedInputTokens = options?.cachedInputTokens ?? 0;
    const cacheCreationTokens = options?.cacheCreationTokens ?? 0;
    const pricingModel = await this.pricingModel(modelName, options?.provider, options?.lookupByModelId);
    const estimatedCost = pricingModel?.metadata?.pricing?.free ? 0 : options?.usageAvailable === false ? null : estimateCost(pricingModel,
      inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens);
    const uncachedCost = options?.usageAvailable === false ? null : estimateCost(pricingModel, inputTokens, outputTokens);
    const reportedCost = typeof options?.reportedCost === 'number' && Number.isFinite(options.reportedCost) && options.reportedCost >= 0 ? options.reportedCost : undefined;

    return this.logUsage({
      userId,
      modelName,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      // Unknown entries retain a zero numeric contribution for legacy SQL;
      // metadata and unknownCostRequests distinguish them from free requests.
      totalCost: reportedCost ?? estimatedCost ?? 0,
      sessionId: options?.sessionId,
      agentId: options?.agentId,
      requestType: options?.requestType,
      metadata: {
        ...options?.metadata,
        costSource: reportedCost != null ? 'reported' : estimatedCost != null ? 'estimated' : 'unknown',
        reportedCost,
        reportedCostSource: reportedCost != null ? 'provider response' : null,
        pricingSource: pricingModel ? pricingModel.metadata?.pricing?.source ?? 'model configuration' : null,
        pricingSnapshot: pricingModel ? { input: pricingModel.costPerInputToken, output: pricingModel.costPerOutputToken, ...pricingModel.metadata?.pricing } : null,
        estimatedCacheSavings: estimatedCost != null && uncachedCost != null ? uncachedCost - estimatedCost : null,
        estimatedCost,
        usageAvailable: options?.usageAvailable ?? true,
      },
    });
  }

  /**
   * Get usage stats for a user
   */
  async getUserStats(userId: string, since?: Date): Promise<UsageStats> {
    const cacheKey = `usage:user:${userId}:${since?.toISOString() || 'all'}`;
    const cached = await this.cache.get<UsageStats>(cacheKey);
    if (cached) return cached;

    const conditions = [eq(costLog.userId, userId)];
    if (since) {
      conditions.push(gte(costLog.createdAt, since));
    }

    const result = await this.db
      .select({
        totalInputTokens: sql<number>`COALESCE(SUM(${costLog.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${costLog.outputTokens}), 0)::int`,
        totalCost: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float`,
        requestCount: sql<number>`COUNT(*)::int`,
        estimatedCacheSavings: sql<number>`COALESCE(SUM((${costLog.metadata}->>'estimatedCacheSavings')::float), 0)::float`,
        reportedCost: sql<number>`COALESCE(SUM(CASE WHEN ${costLog.metadata}->>'costSource' = 'reported' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        estimatedCost: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${costLog.metadata}->>'costSource', 'estimated') = 'estimated' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        unknownUsageRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'usageAvailable' = 'false')::int`,
        unknownCostRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'costSource' = 'unknown')::int`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${costLog.cachedInputTokens}), 0)::bigint`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${costLog.cacheCreationTokens}), 0)::bigint`,
      })
      .from(costLog)
      .where(and(...conditions));

    const stats: UsageStats = result[0] || {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      requestCount: 0,
    };

    await this.cache.set(cacheKey, stats);
    return stats;
  }

  /**
   * Get usage stats by model for a user
   */
  async getUserStatsByModel(userId: string, since?: Date): Promise<ModelUsageStats[]> {
    const conditions = [eq(costLog.userId, userId)];
    if (since) {
      conditions.push(gte(costLog.createdAt, since));
    }

    const result = await this.db
      .select({
        modelName: costLog.modelName,
        totalInputTokens: sql<number>`COALESCE(SUM(${costLog.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${costLog.outputTokens}), 0)::int`,
        totalCost: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float`,
        requestCount: sql<number>`COUNT(*)::int`,
        estimatedCacheSavings: sql<number>`COALESCE(SUM((${costLog.metadata}->>'estimatedCacheSavings')::float), 0)::float`,
        reportedCost: sql<number>`COALESCE(SUM(CASE WHEN ${costLog.metadata}->>'costSource' = 'reported' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        estimatedCost: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${costLog.metadata}->>'costSource', 'estimated') = 'estimated' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        unknownUsageRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'usageAvailable' = 'false')::int`,
        unknownCostRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'costSource' = 'unknown')::int`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${costLog.cachedInputTokens}), 0)::bigint`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${costLog.cacheCreationTokens}), 0)::bigint`,
      })
      .from(costLog)
      .where(and(...conditions))
      .groupBy(costLog.modelName)
      .orderBy(desc(sql`SUM(${costLog.totalCost})`));

    return result;
  }

  /**
   * Get daily usage for a user
   */
  async getDailyUsage(userId: string, days: number = 30): Promise<DailyUsage[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const result = await this.db
      .select({
        date: sql<string>`DATE(${costLog.createdAt})::text`,
        inputTokens: sql<number>`COALESCE(SUM(${costLog.inputTokens}), 0)::int`,
        outputTokens: sql<number>`COALESCE(SUM(${costLog.outputTokens}), 0)::int`,
        cost: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float`,
        requests: sql<number>`COUNT(*)::int`,
      })
      .from(costLog)
      .where(and(eq(costLog.userId, userId), gte(costLog.createdAt, since)))
      .groupBy(sql`DATE(${costLog.createdAt})`)
      .orderBy(sql`DATE(${costLog.createdAt})`);

    return result;
  }

  /**
   * Get usage stats for a session
   */
  async getSessionStats(sessionId: string): Promise<UsageStats> {
    const result = await this.db
      .select({
        totalInputTokens: sql<number>`COALESCE(SUM(${costLog.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${costLog.outputTokens}), 0)::int`,
        totalCost: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float`,
        requestCount: sql<number>`COUNT(*)::int`,
        estimatedCacheSavings: sql<number>`COALESCE(SUM((${costLog.metadata}->>'estimatedCacheSavings')::float), 0)::float`,
        reportedCost: sql<number>`COALESCE(SUM(CASE WHEN ${costLog.metadata}->>'costSource' = 'reported' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        estimatedCost: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${costLog.metadata}->>'costSource', 'estimated') = 'estimated' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        unknownUsageRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'usageAvailable' = 'false')::int`,
        unknownCostRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'costSource' = 'unknown')::int`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${costLog.cachedInputTokens}), 0)::bigint`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${costLog.cacheCreationTokens}), 0)::bigint`,
      })
      .from(costLog)
      .where(eq(costLog.sessionId, sessionId));

    return result[0] || {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      requestCount: 0,
    };
  }

  /**
   * Get global usage stats
   */
  async getGlobalStats(since?: Date): Promise<UsageStats> {
    const conditions = since ? [gte(costLog.createdAt, since)] : [];

    const result = await this.db
      .select({
        totalInputTokens: sql<number>`COALESCE(SUM(${costLog.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${costLog.outputTokens}), 0)::int`,
        totalCost: sql<number>`COALESCE(SUM(${costLog.totalCost}), 0)::float`,
        requestCount: sql<number>`COUNT(*)::int`,
        estimatedCacheSavings: sql<number>`COALESCE(SUM((${costLog.metadata}->>'estimatedCacheSavings')::float), 0)::float`,
        reportedCost: sql<number>`COALESCE(SUM(CASE WHEN ${costLog.metadata}->>'costSource' = 'reported' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        estimatedCost: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${costLog.metadata}->>'costSource', 'estimated') = 'estimated' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
        unknownUsageRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'usageAvailable' = 'false')::int`,
        unknownCostRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'costSource' = 'unknown')::int`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${costLog.cachedInputTokens}), 0)::bigint`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${costLog.cacheCreationTokens}), 0)::bigint`,
      })
      .from(costLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return result[0] || {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      requestCount: 0,
    };
  }

  /**
   * Get recent usage entries
   */
  async getRecentUsage(userId: string, limit: number = 100): Promise<CostLogEntry[]> {
    return this.db
      .select()
      .from(costLog)
      .where(eq(costLog.userId, userId))
      .orderBy(desc(costLog.createdAt))
      .limit(limit);
  }

  /**
   * Invalidate cache for a user
   */
  private async invalidateUserCache(userId: string): Promise<void> {
    // In production, you'd track and clear specific keys
    // For now, we rely on short TTL
  }
}

// Singleton instance
let trackerInstance: CostTracker | null = null;

export function getCostTracker(): CostTracker {
  if (!trackerInstance) {
    trackerInstance = new CostTracker();
  }
  return trackerInstance;
}
