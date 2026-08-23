/**
 * Regression gating. The property that matters: an aggregate that did not move
 * must not hide a test that broke.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { compareToBaseline, formatRegressionReport, hasRegressions, resolveBaselinePath } from './regression';
import type { EvalSuiteResult } from './types';

const suite = (name: string, tests: [string, boolean][]): EvalSuiteResult => ({
  suite: name,
  totalTests: tests.length,
  passed: tests.filter(([, p]) => p).length,
  failed: tests.filter(([, p]) => !p).length,
  score: 0,
  duration: 0,
  timestamp: new Date(0),
  results: tests.map(([testId, passed]) => ({
    suiteId: name,
    testId,
    input: '',
    output: '',
    assertions: [],
    passed,
    score: passed ? 1 : 0,
    latencyMs: 0,
    timestamp: new Date(0),
  })),
});

describe('compareToBaseline', () => {
  test('a swap — one fixed, one broken — still fails the gate', () => {
    const before = [suite('routing', [['a', true], ['b', false]])];
    const after = [suite('routing', [['a', false], ['b', true]])];
    const report = compareToBaseline(before, after);

    expect(report.passRateBefore).toBe(report.passRateAfter); // the aggregate says nothing
    expect(report.regressions.map((r) => r.testId)).toEqual(['a']);
    expect(report.recoveries.map((r) => r.testId)).toEqual(['b']);
    expect(hasRegressions(report)).toBe(true);
  });

  test('an improvement passes the gate', () => {
    const report = compareToBaseline(
      [suite('routing', [['a', false]])],
      [suite('routing', [['a', true]])],
    );
    expect(hasRegressions(report)).toBe(false);
    expect(report.recoveries).toHaveLength(1);
  });

  test('a new test is reported, never gated on', () => {
    const report = compareToBaseline(
      [suite('routing', [['a', true]])],
      [suite('routing', [['a', true], ['b', false]])],
    );
    expect(report.added.map((r) => r.testId)).toEqual(['b']);
    expect(hasRegressions(report)).toBe(false);
  });

  test('a test missing from the run is reported, not treated as a failure', () => {
    const report = compareToBaseline(
      [suite('routing', [['a', true], ['b', true]])],
      [suite('routing', [['a', true]])],
    );
    expect(report.removed.map((r) => r.testId)).toEqual(['b']);
    expect(hasRegressions(report)).toBe(false);
  });

  test('same test id in two suites is not the same test', () => {
    const report = compareToBaseline(
      [suite('routing', [['a', true]]), suite('quality', [['a', false]])],
      [suite('routing', [['a', true]]), suite('quality', [['a', false]])],
    );
    expect(report.regressions).toHaveLength(0);
    expect(report.added).toHaveLength(0);
  });

  test('reads a saved results file shape ({ suites: [...] })', () => {
    const report = compareToBaseline(
      { suites: [suite('routing', [['a', true]])] },
      [suite('routing', [['a', false]])],
    );
    expect(hasRegressions(report)).toBe(true);
  });
});

describe('formatRegressionReport', () => {
  test('names each regression, and says so plainly when there are none', () => {
    const clean = compareToBaseline(
      [suite('routing', [['a', true]])],
      [suite('routing', [['a', true]])],
    );
    expect(formatRegressionReport(clean)).toContain('no regressions');

    const broken = compareToBaseline(
      [suite('routing', [['a', true]])],
      [suite('routing', [['a', false]])],
    );
    const text = formatRegressionReport(broken);
    expect(text).toContain('REGRESSED (1)');
    expect(text).toContain('routing/a');
    expect(text).not.toContain('no regressions');
  });
});

describe('resolveBaselinePath', () => {
  test('"latest" picks the newest run — filenames sort chronologically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    writeFileSync(join(dir, 'eval-2026-01-01T00-00-00.json'), '{}');
    writeFileSync(join(dir, 'eval-2026-08-20T09-00-00.json'), '{}');
    writeFileSync(join(dir, 'not-a-result.txt'), 'x');
    expect(await resolveBaselinePath('latest', dir)).toBe(join(dir, 'eval-2026-08-20T09-00-00.json'));
    rmSync(dir, { recursive: true, force: true });
  });

  test('an empty or missing results directory resolves to nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-baseline-'));
    expect(await resolveBaselinePath('latest', dir)).toBeNull();
    expect(await resolveBaselinePath('latest', join(dir, 'nope'))).toBeNull();
    expect(await resolveBaselinePath(join(dir, 'nope.json'), dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
