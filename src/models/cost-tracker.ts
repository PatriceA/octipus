import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { RedisCache } from '@/db/redis';
import { type CostLogEntry, costLog, modelConfig, type NewCostLogEntry } from '@/db/schema/models';
import { modelLogger } from '@/utils/logger';

export interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  requestCount: number;
}

export interface ModelUsageStats extends UsageStats {
  modelName: string;
}

// Cached prompt-read price as a fraction of the base input rate, by provider
// family. Anthropic/Mistral/DeepSeek publish ~0.1×; OpenAI/Grok/Gemini ~0.5×.
// Unknown providers default to 0.25× (see calculateCost).
const CACHED_READ_MULTIPLIER: Record<string, number> = {
  anthropic: 0.1,
  'custom-anthropic': 0.1,
  mistral: 0.1,
  deepseek: 0.1,
  openai: 0.5,
  'custom-openai': 0.5,
  grok: 0.5,
  gemini: 0.5,
  'custom-gemini': 0.5,
  openrouter: 0.5,
};

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
  private cache = new RedisCache(60); // 1 minute cache for stats

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
   * ponytail: cached-read multiplier is per-provider-family (Anthropic/Mistral/
   * DeepSeek reads ≈0.1×, OpenAI/Grok/Gemini ≈0.5×) and cache-write ≈1.25×
   * (Anthropic 5-min). Upgrade path if a model diverges: per-model rate columns.
   */
  async calculateCost(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens = 0,
    cacheCreationTokens = 0
  ): Promise<number> {
    // Get model pricing from config — callers pass either name or modelId
    const model = await this.db
      .select()
      .from(modelConfig)
      .where(or(eq(modelConfig.name, modelName), eq(modelConfig.modelId, modelName)))
      .limit(1);

    if (!model[0]) {
      modelLogger.warn({ model: modelName }, 'Model not found for cost calculation');
      return 0;
    }

    const inputRate = model[0].costPerInputToken;
    const readMultiplier = CACHED_READ_MULTIPLIER[model[0].provider] ?? 0.25;
    // Cached reads + cache-creation are subsets of inputTokens billed at their
    // own rates — the remainder is fresh input at full price.
    const fullPriceInput = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens);

    // Cost is per 1M tokens
    const inputCost = (fullPriceInput / 1_000_000) * inputRate;
    const cachedReadCost = (cachedInputTokens / 1_000_000) * inputRate * readMultiplier;
    const cacheWriteCost = (cacheCreationTokens / 1_000_000) * inputRate * 1.25;
    const outputCost = (outputTokens / 1_000_000) * model[0].costPerOutputToken;

    return inputCost + cachedReadCost + cacheWriteCost + outputCost;
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
    }
  ): Promise<CostLogEntry> {
    const cachedInputTokens = options?.cachedInputTokens ?? 0;
    const cacheCreationTokens = options?.cacheCreationTokens ?? 0;
    const totalCost = await this.calculateCost(
      modelName,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationTokens
    );

    return this.logUsage({
      userId,
      modelName,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      totalCost,
      sessionId: options?.sessionId,
      agentId: options?.agentId,
      requestType: options?.requestType,
      metadata: options?.metadata || {},
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
