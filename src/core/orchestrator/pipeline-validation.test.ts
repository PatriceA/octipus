import { describe, expect, test } from 'vitest';
import {
  type PipelineStageInput,
  reorderStages,
  validatePipelineStages,
} from './pipeline-validation';

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

describe('reorderStages', () => {
  const A = stage({ name: 'A' });
  const B = stage({ name: 'B' });
  const C = stage({ name: 'C' });
  const D = stage({ name: 'D' });

  test('from === to → returns shallow copy unchanged', () => {
    const out = reorderStages([A, B, C], 1, 1);
    expect(out.map(s => s.name)).toEqual(['A', 'B', 'C']);
    expect(out).not.toBe([A, B, C]); // new array
  });

  test('move down: index 0 → 2 produces [B, C, A]', () => {
    const out = reorderStages([A, B, C], 0, 2);
    expect(out.map(s => s.name)).toEqual(['B', 'C', 'A']);
  });

  test('move up: index 2 → 0 produces [C, A, B]', () => {
    const out = reorderStages([A, B, C], 2, 0);
    expect(out.map(s => s.name)).toEqual(['C', 'A', 'B']);
  });

  test('out-of-range from → returns copy unchanged', () => {
    expect(reorderStages([A, B], 5, 0).map(s => s.name)).toEqual(['A', 'B']);
  });

  test('out-of-range to → returns copy unchanged', () => {
    expect(reorderStages([A, B], 0, 5).map(s => s.name)).toEqual(['A', 'B']);
  });

  test('rebases QA retryTargetStage when its target shifts', () => {
    // [Plan, Build, QA→Build(1)]; move Plan after QA → [Build, QA, Plan]
    // QA used to point at Build (oldIdx 1), should now point at newIdx 0.
    const plan = stage({ name: 'Plan' });
    const build = stage({ name: 'Build' });
    const qa = stage({
      name: 'QA',
      stageType: 'qa_validation',
      retryTargetStage: 1,
    });
    const out = reorderStages([plan, build, qa], 0, 2);
    expect(out.map(s => s.name)).toEqual(['Build', 'QA', 'Plan']);
    expect(out[1].retryTargetStage).toBe(0);
  });

  test('rebases retry target that follows the moved stage', () => {
    // [A, B, C, QA→A(0)]; move A from 0 to 2 → [B, C, A, QA].
    // QA pointed at A (oldIdx 0); A is now at newIdx 2.
    const qa = stage({
      name: 'QA',
      stageType: 'qa_validation',
      retryTargetStage: 0,
    });
    const out = reorderStages([A, B, C, qa], 0, 2);
    expect(out.map(s => s.name)).toEqual(['B', 'C', 'A', 'QA']);
    expect(out[3].retryTargetStage).toBe(2);
  });

  test('moving stage carries its own retryTargetStage with rebasing', () => {
    // [A, B, C, QA→A(0)]; move QA from 3 to 1 → [A, QA, B, C].
    // QA pointed at A (oldIdx 0); A stays at newIdx 0.
    const qa = stage({
      name: 'QA',
      stageType: 'qa_validation',
      retryTargetStage: 0,
    });
    const out = reorderStages([A, B, C, qa], 3, 1);
    expect(out.map(s => s.name)).toEqual(['A', 'QA', 'B', 'C']);
    expect(out[1].retryTargetStage).toBe(0);
  });

  test('move that pushes QA before its target produces forward-ref (caller validates)', () => {
    // [A, B, QA→A(0)]; move QA from 2 to 0 → [QA, A, B].
    // QA's target rebases to newIdx 1 (where A landed).
    // That is now a forward reference — validator must surface it.
    const qa = stage({
      name: 'QA',
      stageType: 'qa_validation',
      retryTargetStage: 0,
    });
    const out = reorderStages([A, B, qa], 2, 0);
    expect(out.map(s => s.name)).toEqual(['QA', 'A', 'B']);
    expect(out[0].retryTargetStage).toBe(1);
    const errs = validatePipelineStages(out);
    expect(errs.some(e => e.includes('retry target'))).toBe(true);
  });

  test('preserves other fields on copy', () => {
    const stages = [
      stage({ name: 'A', requiresApproval: true, maxRetries: 5 }),
      stage({ name: 'B' }),
    ];
    const out = reorderStages(stages, 0, 1);
    expect(out[1].requiresApproval).toBe(true);
    expect(out[1].maxRetries).toBe(5);
  });

  test('handles 4-stage move with multiple retry pointers', () => {
    // [A, B, C, D] each B,C,D being a QA pointing at A (oldIdx 0).
    // Move A from 0 to 3 → [B, C, D, A]. A now at newIdx 3.
    // All retry targets should rebase to 3.
    const mkQa = (name: string) => stage({
      name,
      stageType: 'qa_validation',
      retryTargetStage: 0,
    });
    const out = reorderStages([A, mkQa('B'), mkQa('C'), mkQa('D')], 0, 3);
    expect(out.map(s => s.name)).toEqual(['B', 'C', 'D', 'A']);
    expect(out[0].retryTargetStage).toBe(3);
    expect(out[1].retryTargetStage).toBe(3);
    expect(out[2].retryTargetStage).toBe(3);
  });
});

describe('human_input stages', () => {
  test('a human step needs no topic — it binds no worker', () => {
    expect(
      validatePipelineStages([{ name: 'Sign off?', topic: '', stageType: 'human_input' }]),
    ).toEqual([]);
  });

  test('every other step still needs one', () => {
    expect(validatePipelineStages([{ name: 'Build', topic: '' }])).toEqual([
      'Stage 1: topic is required.',
    ]);
  });
});
