import type { Pipeline, PipelineNodeRow, PlanItemRow } from '@/db/schema/pipelines';

/** Projection is based on completed items from this run, not a promise about future model usage. */
export function pipelineBudget(pipeline: Pipeline, nodes: PipelineNodeRow[], items: PlanItemRow[], defaultPool: number) {
  const pool = typeof pipeline.metadata?.tokenBudget === 'number' ? pipeline.metadata.tokenBudget : defaultPool;
  const spent = nodes.reduce((sum, node) => sum + (node.tokensUsed ?? 0), 0);
  const byItem = pipeline.metadata?.tokensByItem as Record<string, number> | undefined ?? {};
  const completed = items.filter(item => item.status === 'done' && typeof byItem[item.id] === 'number');
  const remaining = items.filter(item => !['done', 'skipped'].includes(item.status)).length;
  const average = completed.length ? completed.reduce((sum, item) => sum + byItem[item.id], 0) / completed.length : null;
  const projectedRemainingTokens = average === null ? null : Math.ceil(average * remaining);
  return { projectionExceedsPool: pool > 0 && projectedRemainingTokens !== null && spent + projectedRemainingTokens > pool,
    pool, spent, percent: pool > 0 ? spent / pool * 100 : null,
    remainingItems: remaining, projectedRemainingTokens,
    projectionBasis: completed.length ? `${completed.length} completed items in this run` : 'Insufficient completed-item evidence',
    exhausted: pool > 0 && spent >= pool, warning: pool > 0 && spent >= pool * .8, byItem };
}
