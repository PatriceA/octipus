/**
 * Per-node token budgets in the graph (wave 3).
 *
 * Two things are worth pinning: the pool decision itself, and the fact that a
 * declared per-node cap survives the template→stage mapper. That mapper
 * enumerates fields, and a flag it forgets is silently dropped between what a
 * template declares and what the runtime reads — the same drift that has bitten
 * `producesArtifacts`, `runsCommands` and `stageType` before.
 */
import { describe, expect, test } from 'bun:test';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import { poolExhaustedSummary } from './pipeline-manager';
import { stepConfigToStageTemplate } from './templates';

describe('poolExhaustedSummary', () => {
  test('a pool of 0 disables the bound', () => {
    expect(poolExhaustedSummary(0, 9_999_999, 'Implementation')).toBeNull();
  });

  test('under budget keeps walking', () => {
    expect(poolExhaustedSummary(2_000_000, 1_999_999, 'Implementation')).toBeNull();
  });

  test('spending the pool exactly stops the run — it is a ceiling on the run', () => {
    const summary = poolExhaustedSummary(2_000_000, 2_000_000, 'Implementation');
    expect(summary).toContain('exhausted');
    expect(summary).toContain('Implementation');
  });
});

describe('template mapper carries the per-node cap', () => {
  test('maxTokens survives stepConfigToStageTemplate', () => {
    const step = {
      name: 'Implementation',
      topic: 'coding',
      requiresApproval: false,
      promptTemplate: 'do it',
      maxTokens: 40_000,
    } as PipelineStepConfig;
    expect(stepConfigToStageTemplate(step).maxTokens).toBe(40_000);
  });

  test('an undeclared cap stays undefined — the global default applies', () => {
    const step = {
      name: 'Implementation',
      topic: 'coding',
      requiresApproval: false,
      promptTemplate: 'do it',
    } as PipelineStepConfig;
    expect(stepConfigToStageTemplate(step).maxTokens).toBeUndefined();
  });
});
