import { expect, test } from 'vitest';
import type { Pipeline, PipelineNodeRow, PlanItemRow } from '@/db/schema/pipelines';
import { pipelineBudget } from './pipeline-budget';
test('warns at 80%, projects from completed item spend and applies a run top-up (#41)', () => {
  const pipeline = { metadata: { tokensByItem: { one: 80 } } } as unknown as Pipeline;
  const nodes = [{ tokensUsed: 80 }] as PipelineNodeRow[];
  const items = [{ id: 'one', status: 'done' }, { id: 'two', status: 'pending' }] as PlanItemRow[];
  expect(pipelineBudget(pipeline, nodes, items, 100)).toMatchObject({ warning: true, exhausted: false, projectedRemainingTokens: 80, spent: 80 });
  expect(pipelineBudget({ ...pipeline, metadata: { ...pipeline.metadata, tokenBudget: 1000 } }, nodes, items, 100)).toMatchObject({ warning: false, pool: 1000 });
  expect(pipelineBudget(pipeline, [{ tokensUsed: 110 }] as PipelineNodeRow[], items, 100).exhausted).toBe(true);
});

test('a soft warning does not require a pause when projected remaining work fits', () => {
  const pipeline = { metadata: { tokensByItem: { one: 1_050_000 } } } as unknown as Pipeline;
  const nodes = [{ tokensUsed: 24_300_000 }] as PipelineNodeRow[];
  const items = [{ id: 'one', status: 'done' }, { id: 'two', status: 'pending' }] as PlanItemRow[];
  expect(pipelineBudget(pipeline, nodes, items, 30_000_000)).toMatchObject({
    warning: true, exhausted: false, projectionExceedsPool: false, projectedRemainingTokens: 1_050_000,
  });
  expect(pipelineBudget(pipeline, nodes, items, 25_000_000).projectionExceedsPool).toBe(true);
  expect(pipelineBudget({ metadata: {} } as Pipeline, nodes, items, 30_000_000)).toMatchObject({
    warning: true, projectionExceedsPool: false, projectedRemainingTokens: null,
  });
});
