import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { RedisCache } from '@/db/redis';
import { type CostLogEntry, costLog, modelConfig, type NewCostLogEntry } from '@/db/schema/models';
import { getBillingProvider } from '@/services/billing/provider';
import { coreLogger, modelLogger } from '@/utils/logger';

export interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  requestCount: number;
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
  private db = getDb();
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

    // Emit a billing event. Fire-and-forget — never block the request.
    void getBillingProvider().recordUsage({
      userId: entry.userId,
      orgId: null,
      workspaceId: null,
      modelName: entry.modelName,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.totalCost,
      sessionId: entry.sessionId ?? null,
      agentId: entry.agentId ?? null,
      requestType: entry.requestType ?? null,
      metadata: entry.metadata as Record<string, unknown> | undefined,
      occurredAt: new Date(),
    }).catch((err: unknown) => {
      coreLogger.error({ err: (err as Error).message }, 'billing.recordUsage failed');
    });

    return result[0];
  }

  /**
   * Calculate cost for a request
   */
  async calculateCost(
    modelName: string,
    inputTokens: number,
    outputTokens: number
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

    // Cost is per 1M tokens
    const inputCost = (inputTokens / 1_000_000) * model[0].costPerInputToken;
    const outputCost = (outputTokens / 1_000_000) * model[0].costPerOutputToken;

    return inputCost + outputCost;
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
    }
  ): Promise<CostLogEntry> {
    const totalCost = await this.calculateCost(modelName, inputTokens, outputTokens);

    return this.logUsage({
      userId,
      modelName,
      inputTokens,
      outputTokens,
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
