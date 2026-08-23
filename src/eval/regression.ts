/**
 * Regression gating for the eval harness (roadmap wave 3).
 *
 * The harness could tell you a run's score. It could not tell you whether a
 * change made things WORSE, which is the only question a gate can act on: a
 * suite that scores 0.86 today is not information until you know it scored 0.91
 * yesterday, and even the aggregate hides the case that matters most — one test
 * fixed and one broken nets out to zero movement while the behaviour of the
 * system changed in both directions.
 *
 * So the gate is per-test and directional. A REGRESSION is a test that passed
 * in the baseline and fails now; that is what fails the run. A recovery is
 * reported but never fails anything, and a test the baseline never ran is
 * reported as new rather than silently counted as either.
 */

import { resolve } from 'node:path';
import type { EvalSuiteResult } from './types';
import { fileAt } from '@/utils/fs-file';

/** One test's outcome, flattened out of the nested suite/result shape. */
interface Outcome {
  key: string;
  suite: string;
  testId: string;
  passed: boolean;
  score: number;
}

export interface TestDelta {
  suite: string;
  testId: string;
  /** Baseline score, or null when the baseline never ran this test. */
  before: number | null;
  after: number;
}

export interface RegressionReport {
  /** Passed before, fails now. These fail the gate. */
  regressions: TestDelta[];
  /** Failed before, passes now. */
  recoveries: TestDelta[];
  /** Not present in the baseline at all. */
  added: TestDelta[];
  /** In the baseline, not in this run — a deleted or filtered-out test. */
  removed: { suite: string; testId: string; before: number }[];
  /** Aggregate pass rate, for the one-line summary. */
  passRateBefore: number;
  passRateAfter: number;
}

/**
 * A saved results file (`eval/results/*.json`) or a live in-memory run. The
 * saved shape is `toJSON`'s: `{ suites: [...] }` with ISO timestamps, which is
 * structurally the suite array for everything this compares.
 */
export type ResultsInput = EvalSuiteResult[] | { suites: EvalSuiteResult[] };

const suitesOf = (input: ResultsInput): EvalSuiteResult[] =>
  Array.isArray(input) ? input : (input?.suites ?? []);

/**
 * Flatten to one row per test. Keyed by `suite/testId` — a test id is only
 * unique within its suite, and comparing across suites by bare id would pair
 * up unrelated tests that happen to share a name.
 */
function outcomes(input: ResultsInput): Map<string, Outcome> {
  const map = new Map<string, Outcome>();
  for (const suite of suitesOf(input)) {
    for (const r of suite.results ?? []) {
      const key = `${suite.suite}/${r.testId}`;
      map.set(key, { key, suite: suite.suite, testId: r.testId, passed: r.passed, score: r.score });
    }
  }
  return map;
}

const passRate = (m: Map<string, Outcome>): number =>
  m.size === 0 ? 0 : [...m.values()].filter((o) => o.passed).length / m.size;

/** Compare a run against a baseline. Pure — no IO, no clock. */
export function compareToBaseline(baseline: ResultsInput, current: ResultsInput): RegressionReport {
  const before = outcomes(baseline);
  const after = outcomes(current);

  const report: RegressionReport = {
    regressions: [],
    recoveries: [],
    added: [],
    removed: [],
    passRateBefore: passRate(before),
    passRateAfter: passRate(after),
  };

  for (const [key, now] of after) {
    const then = before.get(key);
    if (!then) {
      report.added.push({ suite: now.suite, testId: now.testId, before: null, after: now.score });
      continue;
    }
    if (then.passed && !now.passed) {
      report.regressions.push({ suite: now.suite, testId: now.testId, before: then.score, after: now.score });
    } else if (!then.passed && now.passed) {
      report.recoveries.push({ suite: now.suite, testId: now.testId, before: then.score, after: now.score });
    }
  }

  for (const [key, then] of before) {
    if (!after.has(key)) {
      report.removed.push({ suite: then.suite, testId: then.testId, before: then.score });
    }
  }

  return report;
}

/** Does this report fail the gate? Regressions only — nothing else is a fault. */
export const hasRegressions = (report: RegressionReport): boolean => report.regressions.length > 0;

/** Console summary. Returns the text so a caller can log or attach it. */
export function formatRegressionReport(report: RegressionReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [
    '',
    `Baseline comparison: ${pct(report.passRateBefore)} → ${pct(report.passRateAfter)}`,
  ];

  if (report.regressions.length > 0) {
    lines.push(`  REGRESSED (${report.regressions.length}):`);
    for (const d of report.regressions) {
      lines.push(`    ✗ ${d.suite}/${d.testId}  ${d.before?.toFixed(2)} → ${d.after.toFixed(2)}`);
    }
  }
  if (report.recoveries.length > 0) {
    lines.push(`  recovered (${report.recoveries.length}):`);
    for (const d of report.recoveries) {
      lines.push(`    ✓ ${d.suite}/${d.testId}  ${d.before?.toFixed(2)} → ${d.after.toFixed(2)}`);
    }
  }
  // New and removed tests are reported, never gated on: a test the baseline
  // never ran has nothing to regress from, and one the run skipped may simply
  // have been filtered by `--suite` or `--tag`.
  if (report.added.length > 0) lines.push(`  new (${report.added.length}, not gated)`);
  if (report.removed.length > 0) lines.push(`  missing from this run (${report.removed.length}, not gated)`);
  if (report.regressions.length === 0) lines.push('  no regressions');

  return lines.join('\n');
}

/**
 * Resolve `--baseline`. A path is used as given; `latest` picks the newest
 * `eval-*.json` in the results directory, which is what a developer means by
 * "compare against the last run" without having to name a timestamp.
 */
export async function resolveBaselinePath(arg: string, resultsDir: string): Promise<string | null> {
  if (arg !== 'latest') return (await fileAt(arg).exists()) ? arg : null;
  const { readdirSync } = await import('fs');
  let names: string[];
  try {
    names = readdirSync(resultsDir).filter((n) => n.startsWith('eval-') && n.endsWith('.json'));
  } catch {
    return null;
  }
  // Filenames are ISO timestamps with `:`/`.` replaced, so they sort lexically
  // in chronological order.
  const newest = names.sort().pop();
  return newest ? resolve(resultsDir, newest) : null;
}
