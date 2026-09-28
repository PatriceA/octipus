import { sql } from 'drizzle-orm';
import { costLog } from '@/db/schema/models';

/**
 * How `cost_log` spend was measured, as SQL aggregates over `cost_log` rows
 * (`CostLogMetadata.costSource`): provider-reported USD, USD estimated from
 * model pricing (rows without a source predate it and were estimates), and
 * the count of calls whose cost is unknown and logged as $0 (CLI /
 * subscription providers). Shared by the usage stats (`src/models/cost-tracker.ts`)
 * and the spend budget view (`src/security/spend-budgets.ts`) so both classify alike.
 */
export function costSourceAggregates() {
  return {
    reportedCost: sql<number>`COALESCE(SUM(CASE WHEN ${costLog.metadata}->>'costSource' = 'reported' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
    estimatedCost: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${costLog.metadata}->>'costSource', 'estimated') = 'estimated' THEN ${costLog.totalCost} ELSE 0 END), 0)::float`,
    unknownCostRequests: sql<number>`COUNT(*) FILTER (WHERE ${costLog.metadata}->>'costSource' = 'unknown')::int`,
  };
}
