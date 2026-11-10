/**
 * Per-plugin usage (docs/PLUGIN-PACKAGES.md#usage): the tokens and spend of
 * one plugin package's `model:complete` calls (cost rows tagged
 * `plugin:<name>`) and of its background runs (`agent:run`: the cost rows of
 * the runs' own sessions), with the number of model calls and runs.
 *
 * Aggregates only, never row content: counts and sums, by user for the
 * admin view. `userId` narrows everything to one user's own rows (the
 * per-user view); without it, every user (admins only, checked by the route).
 */
import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../postgres';
import { backgroundJobs } from '../schema/background-jobs';
import { costLog } from '../schema/models';

export interface PluginUsageTotals {
  modelCalls: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  byUser: Array<{ userId: string; modelCalls: number; runs: number; tokens: number; cost: number }>;
}

export const pluginUsageRepository = {
  async usage(plugin: string, since: Date, userId?: string): Promise<PluginUsageTotals> {
    const db = getDb();
    const runFilters: SQL[] = [eq(backgroundJobs.kind, 'agent'), sql`${backgroundJobs.payload} ->> 'plugin' = ${plugin}`];
    if (userId) runFilters.push(eq(backgroundJobs.userId, userId));
    // Run sessions of this package (any start date: a run may cost after `since`). i2: ids only, never content.
    const runSessions = db.select({ id: sql<string>`(${backgroundJobs.payload} ->> 'sessionId')::uuid` }).from(backgroundJobs).where(and(...runFilters));
    const costFilters: SQL[] = [gte(costLog.createdAt, since)];
    if (userId) costFilters.push(eq(costLog.userId, userId));
    const rows = await db.select({
      userId: costLog.userId,
      modelCalls: sql<number>`count(*) filter (where ${costLog.requestType} = ${`plugin:${plugin}`})::int`,
      inputTokens: sql<number>`coalesce(sum(${costLog.inputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${costLog.outputTokens}), 0)::float8`,
      cost: sql<number>`coalesce(sum(${costLog.totalCost}), 0)::float8`,
    }).from(costLog)
      .where(and(...costFilters, sql`(${costLog.requestType} = ${`plugin:${plugin}`} OR ${inArray(costLog.sessionId, runSessions)})`))
      .groupBy(costLog.userId);
    const runs = await db.select({ userId: backgroundJobs.userId, n: sql<number>`count(*)::int` })
      // i2: counts only
      .from(backgroundJobs)
      .where(and(...runFilters, gte(backgroundJobs.createdAt, since)))
      .groupBy(backgroundJobs.userId);
    const byUser = new Map<string, PluginUsageTotals['byUser'][number]>();
    const entry = (id: string) => {
      const existing = byUser.get(id);
      if (existing) return existing;
      const fresh = { userId: id, modelCalls: 0, runs: 0, tokens: 0, cost: 0 };
      byUser.set(id, fresh);
      return fresh;
    };
    let inputTokens = 0;
    let outputTokens = 0;
    for (const r of rows) {
      const e = entry(r.userId);
      e.modelCalls += Number(r.modelCalls);
      e.tokens += Number(r.inputTokens) + Number(r.outputTokens);
      e.cost += Number(r.cost);
      inputTokens += Number(r.inputTokens);
      outputTokens += Number(r.outputTokens);
    }
    for (const r of runs) entry(r.userId).runs += Number(r.n);
    const users = [...byUser.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
    return {
      modelCalls: users.reduce((n, u) => n + u.modelCalls, 0),
      runs: users.reduce((n, u) => n + u.runs, 0),
      inputTokens, outputTokens,
      cost: users.reduce((n, u) => n + u.cost, 0),
      byUser: users,
    };
  },
};
