import { describe, expect, test } from 'vitest';
import { DEFAULT_THRESHOLDS, evaluateSplit, isPaid, type SplitRow } from './executor-split';

function row(over: Partial<SplitRow> = {}): SplitRow {
  return {
    node_id: 'child-1',
    role: 'coding',
    child_model: 'ornith:35b',
    child_provider: 'ollama',
    child_tokens: 10_000,
    tool_calls: 8,
    parent_id: 'parent-1',
    parent_model: 'deepseek-v4-flash',
    parent_provider: 'deepseek',
    parent_tokens: 20_000,
    created_at: '2026-08-03T10:00:00.000Z',
    ...over,
  };
}

describe('isPaid', () => {
  test('local and CLI providers are free, metered APIs are not', () => {
    expect(isPaid('ollama')).toBe(false);
    expect(isPaid('cli')).toBe(false);
    expect(isPaid('deepseek')).toBe(true);
    expect(isPaid('anthropic')).toBe(true);
  });

  test('an unknown provider counts as paid — understating spend is the worse error', () => {
    expect(isPaid(null)).toBe(true);
    expect(isPaid('')).toBe(true);
  });
});

describe('evaluateSplit', () => {
  test('a cheap local executor doing real work passes', () => {
    const v = evaluateSplit([row(), row({ node_id: 'c2', parent_id: 'p2' })]);
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
    // Executor is local, so every executor token is off the paid planner.
    expect(Math.round(v.paidOffloadPct)).toBe(33); // 10k+10k of 60k total
    expect(v.paidExecutorTokens).toBe(0);
  });

  test('the anti-pattern the brief named: a plan so detailed execution is transcription', () => {
    // Five planned spawns, every executor making one tool call.
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ node_id: `c${i}`, parent_id: `p${i}`, tool_calls: 1 }),
    );
    const v = evaluateSplit(rows);
    expect(v.ok).toBe(false);
    expect(v.trivial).toHaveLength(5);
    expect(v.failures[0]).toContain('transcription');
  });

  test('a planner that keeps all the paid work fails even when the executor is busy', () => {
    const v = evaluateSplit([
      row({ tool_calls: 20, child_tokens: 500, parent_tokens: 100_000 }),
    ]);
    expect(v.ok).toBe(false);
    expect(v.failures.join(' ')).toContain('left the paid planner');
  });

  test('zero-token executors are unmeasured, not free — they cannot manufacture a saving', () => {
    const v = evaluateSplit([
      row({ node_id: 'cli-1', child_model: 'cli/claude', child_provider: 'cli', child_tokens: 0 }),
      row({ node_id: 'cli-2', child_model: 'cli/claude', child_provider: 'cli', child_tokens: 0, parent_id: 'p2' }),
    ]);
    expect(v.spawns).toBe(2);
    expect(v.unmeasured).toBe(2);
    // Nothing measurable ⇒ no verdict either way, and no planner tokens
    // credited from parents whose only children were unmeasurable.
    expect(v.ok).toBe(true);
    expect(v.plannerTokens).toBe(0);
    expect(v.summary).toContain('nothing measurable');
  });

  test('one planner with many planned children is counted once', () => {
    const shared = Array.from({ length: 4 }, (_, i) =>
      row({ node_id: `c${i}`, parent_id: 'same-parent', parent_tokens: 20_000 }),
    );
    const v = evaluateSplit(shared);
    // 20k, not 80k: fanning out must not inflate the planner's cost.
    expect(v.plannerTokens).toBe(20_000);
    expect(v.executorTokens).toBe(40_000);
  });

  test('an empty window is reported, not failed', () => {
    const v = evaluateSplit([]);
    expect(v.ok).toBe(true);
    expect(v.summary).toContain('never exercised');
  });

  test('thresholds are the knobs, and the defaults are the plan’s pass condition', () => {
    expect(DEFAULT_THRESHOLDS.minToolCalls).toBe(3);
    const rows = [row({ tool_calls: 2 }), row({ node_id: 'c2', parent_id: 'p2', tool_calls: 2 })];
    expect(evaluateSplit(rows).ok).toBe(false);
    expect(evaluateSplit(rows, { ...DEFAULT_THRESHOLDS, minToolCalls: 2 }).ok).toBe(true);
  });
});

describe('a planner with no recorded cost cannot price a saving', () => {
  test('0-token parent is excluded from the ratios, not read as 100% offload', () => {
    const v = evaluateSplit([row({ parent_tokens: 0, tool_calls: 17 })]);
    expect(v.uncosted).toBe(1);
    expect(v.plannerTokens).toBe(0);
    expect(v.executorTokens).toBe(0); // not priced either — both sides or neither
    expect(v.paidOffloadPct).toBe(0);
    // No offload failure can be raised from an unpriceable window.
    expect(v.ok).toBe(true);
    expect(v.summary).toContain('no saving can be priced');
  });

  test('an unpriced spawn is still judged on whether it did real work', () => {
    const v = evaluateSplit([
      row({ parent_tokens: 0, tool_calls: 1 }),
      row({ node_id: 'c2', parent_id: 'p2', parent_tokens: 0, tool_calls: 1 }),
    ]);
    expect(v.trivial).toHaveLength(2);
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain('transcription');
  });
});
