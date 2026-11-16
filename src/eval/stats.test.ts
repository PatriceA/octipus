import { describe, expect, test } from 'vitest';
import { overallStats, passAtK, passPowK, summarizeAttempts } from './stats';
import type { EvalResult } from './types';

const attempt = (testId: string, passed: boolean, extra: Partial<EvalResult> = {}): EvalResult => ({
  suiteId: 's', testId, input: '', output: '', assertions: [], passed, completed: passed, unsafe: [], score: passed ? 1 : 0,
  latencyMs: 0, timestamp: new Date(), ...extra,
});

describe('pass@k and pass^k', () => {
  test('k = n reduces to "any attempt passed" and "every attempt passed"', () => {
    expect(passAtK(5, 3, 5)).toBe(1);
    expect(passAtK(5, 0, 5)).toBe(0);
    expect(passPowK(5, 5, 5)).toBe(1);
    expect(passPowK(5, 4, 5)).toBe(0);
  });

  test('unbiased estimators for k < n', () => {
    // 10 attempts, 3 passes, k = 2: 1 - C(7,2)/C(10,2) = 1 - 21/45; C(3,2)/C(10,2) = 3/45.
    expect(passAtK(10, 3, 2)).toBeCloseTo(24 / 45);
    expect(passPowK(10, 3, 2)).toBeCloseTo(3 / 45);
    expect(passAtK(4, 2, 1)).toBeCloseTo(0.5);
  });

  test('no estimate when there are fewer attempts than k', () => {
    expect(passAtK(2, 2, 3)).toBeNull();
    expect(passPowK(2, 2, 3)).toBeNull();
  });
});

describe('summaries', () => {
  test('per test: attempts, completion apart from strict passes, unsafe attempts and checks', () => {
    const results = [
      attempt('a', true), attempt('a', false, { completed: true }), attempt('a', true),
      attempt('b', false, { unsafe: ['no-poisoned-memory'] }), attempt('b', false, { unsafe: ['no-poisoned-memory'] }), attempt('b', true),
    ];
    const [a, b] = summarizeAttempts('s', results, 3);
    expect(a).toMatchObject({ testId: 'a', attempts: 3, passed: 2, completed: 3, passAt1: 2 / 3, passAtK: 1, passPowK: 0, unsafeAttempts: 0 });
    expect(b).toMatchObject({ testId: 'b', passed: 1, unsafeAttempts: 2, unsafeChecks: ['no-poisoned-memory'] });

    const all = overallStats([a, b]);
    expect(all).toMatchObject({ tests: 2, attempts: 6, k: 3, unsafeAttempts: 2, unsafeTests: 1 });
    expect(all.strictPassRate).toBeCloseTo(3 / 6);
    expect(all.taskCompletionRate).toBeCloseTo(4 / 6);
    expect(all.passPowK).toBe(0);
    expect(all.passAtK).toBe(1);
  });

  test('runSuite under --repeat: every attempt is a result, numbered, and summarised per test', async () => {
    const { runSuite } = await import('./runner');
    const result = await runSuite({ name: 'r', tests: [
      { id: 'classify', description: '', input: 'hello there', assertions: [{ type: 'confidence_above', value: 0 }] },
      { id: 'stateful', description: '', input: 'x', assertions: [{ type: 'memory_absent', value: 'X', failure: 'unsafe' }] },
    ] }, { repeat: 3 });
    expect(result.results.map(r => `${r.testId}#${r.attempt}`)).toEqual(['classify#1', 'classify#2', 'classify#3', 'stateful#1', 'stateful#2', 'stateful#3']);
    expect(result.stats?.map(s => [s.testId, s.passed, s.attempts, s.passPowK])).toEqual([['classify', 3, 3, 1], ['stateful', 0, 3, 0]]);
    // A test that could not run is incomplete, never an unsafe failure.
    expect(result.results[3]).toMatchObject({ passed: false, completed: false, unsafe: [], metadata: { setupError: expect.stringMatching(/--integration/) } });
  });

  test('a single run still reports, with pass@k undefined past one attempt', () => {
    const [only] = summarizeAttempts('s', [attempt('a', true)], 5);
    expect(only).toMatchObject({ attempts: 1, passAt1: 1, passAtK: null, passPowK: null });
    expect(overallStats([only]).passAtK).toBeNull();
  });
});
