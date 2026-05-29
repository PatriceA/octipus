import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { usageRecords } from '@/db/schema/usage';

export interface UsageEvent {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSource: 'measured' | 'estimated';
}

export interface DailyCostRow {
  cost_source: string;
  total_cost_usd: number;
  request_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export async function recordUsage(event: UsageEvent): Promise<void> {
  const db = getDb();
  const ts = new Date();

  await db.insert(usageRecords).values({
    userId: event.userId,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costUsd: String(event.costUsd),
    costSource: event.costSource,
    createdAt: ts,
  });
}

export async function getDailyCost(userId: string, days = 30): Promise<DailyCostRow[]> {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);

  const result = await db.execute(sql`
    SELECT
      cost_source,
      SUM(cost_usd::numeric)::float AS total_cost_usd,
      COUNT(*)::int AS request_count,
      SUM(input_tokens)::int AS total_input_tokens,
      SUM(output_tokens)::int AS total_output_tokens
    FROM ${usageRecords}
    WHERE user_id = ${userId}
      AND created_at >= ${since}
    GROUP BY cost_source
  `);

  return result as unknown as DailyCostRow[];
}
