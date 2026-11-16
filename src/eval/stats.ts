/**
 * Repeat statistics for the eval harness (`--repeat N`).
 *
 * One run of a model-backed test is one sample of a distribution, not a
 * verdict: a test that passes 3 times in 5 passes "sometimes", and a single
 * green run of it says nothing about the next. With repeats each test reports
 *
 *  - pass@1: the share of attempts that passed (expected single-try success);
 *  - pass@k: the chance that at least one of k attempts passes — what a user
 *    who retries gets;
 *  - pass^k: the chance that all k attempts pass — what an unattended agent
 *    that must get it right every time gets.
 *
 * Both use the unbiased estimators over n attempts with c passes (as in n8n's
 * nod evals and the HumanEval paper): pass@k = 1 − C(n−c,k)/C(n,k),
 * pass^k = C(c,k)/C(n,k). With k = n they reduce to "any passed" and "all
 * passed". k > n has no estimate (null).
 */

import type { EvalResult } from './types';

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
  return value;
}

export function passAtK(n: number, c: number, k: number): number | null {
  if (k < 1 || n < k) return null;
  return 1 - choose(n - c, k) / choose(n, k);
}

export function passPowK(n: number, c: number, k: number): number | null {
  if (k < 1 || n < k) return null;
  return choose(c, k) / choose(n, k);
}

export interface TestStats {
  suite: string;
  testId: string;
  attempts: number;
  /** Attempts where every check passed. */
  passed: number;
  /** Attempts where every outcome check passed. */
  completed: number;
  /** Attempts that had an outcome check at all (the completion rate's denominator). */
  completionApplicable: number;
  k: number;
  passAt1: number;
  passAtK: number | null;
  passPowK: number | null;
  /** Attempts with at least one failed unsafe-class check. */
  unsafeAttempts: number;
  /** Distinct unsafe-class check ids that failed in any attempt. */
  unsafeChecks: string[];
}

/** Per-test statistics, in first-seen order. */
export function summarizeAttempts(suite: string, results: EvalResult[], k: number): TestStats[] {
  const byTest = new Map<string, EvalResult[]>();
  for (const r of results) byTest.set(r.testId, [...(byTest.get(r.testId) ?? []), r]);
  return [...byTest].map(([testId, attempts]) => {
    const n = attempts.length;
    const c = attempts.filter(a => a.passed).length;
    const unsafe = attempts.filter(a => a.unsafe?.length);
    return {
      suite,
      testId,
      attempts: n,
      passed: c,
      // undefined: a result from before outcome checks existed, read as its strict verdict.
      completed: attempts.filter(a => (a.completed === undefined ? a.passed : a.completed === true)).length,
      completionApplicable: attempts.filter(a => a.completed !== null).length,
      k,
      passAt1: n ? c / n : 0,
      passAtK: passAtK(n, c, k),
      passPowK: passPowK(n, c, k),
      unsafeAttempts: unsafe.length,
      unsafeChecks: [...new Set(unsafe.flatMap(a => a.unsafe ?? []))],
    };
  });
}

export interface OverallStats {
  tests: number;
  attempts: number;
  /** Share of attempts where every check passed. */
  strictPassRate: number;
  /** Share of attempts with an outcome check where every outcome check passed. */
  taskCompletionRate: number;
  /** Means over tests; null when no test had k attempts. */
  passAt1: number;
  passAtK: number | null;
  passPowK: number | null;
  k: number;
  /** Attempts with a failed unsafe-class check — reported apart from every other failure. */
  unsafeAttempts: number;
  unsafeTests: number;
}

const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);

export function overallStats(stats: TestStats[]): OverallStats {
  const attempts = stats.reduce((s, t) => s + t.attempts, 0);
  const atK = stats.map(t => t.passAtK).filter((v): v is number => v !== null);
  const powK = stats.map(t => t.passPowK).filter((v): v is number => v !== null);
  return {
    tests: stats.length,
    attempts,
    strictPassRate: attempts ? stats.reduce((s, t) => s + t.passed, 0) / attempts : 0,
    taskCompletionRate: (() => {
      const applicable = stats.reduce((s, t) => s + t.completionApplicable, 0);
      return applicable ? stats.reduce((s, t) => s + t.completed, 0) / applicable : 0;
    })(),
    passAt1: mean(stats.map(t => t.passAt1)),
    passAtK: atK.length ? mean(atK) : null,
    passPowK: powK.length ? mean(powK) : null,
    k: stats[0]?.k ?? 1,
    unsafeAttempts: stats.reduce((s, t) => s + t.unsafeAttempts, 0),
    unsafeTests: stats.filter(t => t.unsafeAttempts > 0).length,
  };
}
