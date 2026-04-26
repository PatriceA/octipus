import { describe, expect, test } from 'bun:test';
import { validatePipelineStages, type PipelineStageInput } from './pipeline-validation';

const stage = (over: Partial<PipelineStageInput> = {}): PipelineStageInput => ({
  name: 'A stage',
  topic: 'general',
  ...over,
});

describe('validatePipelineStages', () => {
  test('empty array → "at least one stage" error', () => {
    expect(validatePipelineStages([])).toEqual(['Pipeline must have at least one stage.']);
  });

  test('valid 2-stage pipeline → no errors', () => {
    expect(validatePipelineStages([stage({ name: 'Plan' }), stage({ name: 'Build' })])).toEqual([]);
  });

  test('missing name → flagged', () => {
    expect(validatePipelineStages([stage({ name: '' })])).toContain('Stage 1: name is required.');
  });

  test('whitespace-only name → flagged', () => {
    expect(validatePipelineStages([stage({ name: '   ' })])).toContain('Stage 1: name is required.');
  });

  test('missing topic → flagged', () => {
    expect(validatePipelineStages([stage({ topic: '' })])).toContain('Stage 1: topic is required.');
  });

  test('QA stage requires retryTargetStage', () => {
    const errs = validatePipelineStages([
      stage({ name: 'Plan' }),
      stage({ name: 'QA', stageType: 'qa_validation' }),
    ]);
    expect(errs).toContain('Stage 2 (QA): retryTargetStage is required.');
  });

  test('QA forward-reference (target >= self index) → flagged', () => {
    const errs = validatePipelineStages([
      stage({ name: 'Plan' }),
      stage({ name: 'QA', stageType: 'qa_validation', retryTargetStage: 1 }), // points to self
    ]);
    expect(errs).toContain('Stage 2 (QA): retry target 2 must be an earlier stage (1..1).');
  });

  test('QA target far in the future → flagged', () => {
    const errs = validatePipelineStages([
      stage({ name: 'Plan' }),
      stage({ name: 'QA', stageType: 'qa_validation', retryTargetStage: 5 }), // out of range
      stage({ name: 'Build' }),
    ]);
    expect(errs).toContain('Stage 2 (QA): retry target 6 must be an earlier stage (1..1).');
  });

  test('QA target = -1 → flagged', () => {
    const errs = validatePipelineStages([
      stage({ name: 'Plan' }),
      stage({ name: 'QA', stageType: 'qa_validation', retryTargetStage: -1 }),
    ]);
    expect(errs).toContain('Stage 2 (QA): retry target 0 must be an earlier stage (1..1).');
  });

  test('valid QA target → no error', () => {
    const errs = validatePipelineStages([
      stage({ name: 'Plan' }),
      stage({ name: 'Build' }),
      stage({ name: 'QA', stageType: 'qa_validation', retryTargetStage: 0, maxRetries: 3 }),
    ]);
    expect(errs).toEqual([]);
  });

  test('maxRetries < 1 → flagged', () => {
    const errs = validatePipelineStages([
      stage({ name: 'Plan' }),
      stage({ name: 'QA', stageType: 'qa_validation', retryTargetStage: 0, maxRetries: 0 }),
    ]);
    expect(errs).toContain('Stage 2 (QA): maxRetries must be ≥ 1.');
  });

  test('multiple problems surface together (one-pass)', () => {
    const errs = validatePipelineStages([
      stage({ name: '' }),
      stage({
        name: 'QA',
        topic: '',
        stageType: 'qa_validation',
        retryTargetStage: 5,
        maxRetries: -2,
      }),
    ]);
    // All four problems should appear in the same call.
    expect(errs.length).toBeGreaterThanOrEqual(4);
    expect(errs).toContain('Stage 1: name is required.');
    expect(errs).toContain('Stage 2: topic is required.');
    expect(errs.some((e) => e.includes('retry target'))).toBe(true);
    expect(errs).toContain('Stage 2 (QA): maxRetries must be ≥ 1.');
  });

  test('non-QA stages with retryTargetStage are NOT validated for cycles', () => {
    // The validator only enforces the cycle rule on QA stages — a
    // standard stage carrying a stale retryTargetStage value (e.g. one
    // stage was demoted from QA to standard) shouldn't produce a
    // false positive.
    const errs = validatePipelineStages([
      stage({ name: 'Plan', retryTargetStage: 99 }),
      stage({ name: 'Build' }),
    ]);
    expect(errs).toEqual([]);
  });
});
