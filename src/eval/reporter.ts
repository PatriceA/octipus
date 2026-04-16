/**
 * Eval results reporter.
 * Outputs results to console (table format), JSON files, and eval/results/ directory.
 */

import { resolve } from 'path';
import type { EvalSuiteResult, AssertionResult } from './types';

// ── ANSI helpers ─────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const _WHITE = '\x1b[37m';

function pass(text: string) { return `${GREEN}${text}${RESET}`; }
function fail(text: string) { return `${RED}${text}${RESET}`; }
function warn(text: string) { return `${YELLOW}${text}${RESET}`; }
function info(text: string) { return `${CYAN}${text}${RESET}`; }
function bold(text: string) { return `${BOLD}${text}${RESET}`; }
function dim(text: string) { return `${DIM}${text}${RESET}`; }

function padRight(str: string, len: number): string {
  // Strip ANSI for length calculation
  const stripped = str.replace(/\x1b\[\d+m/g, '');
  const pad = Math.max(0, len - stripped.length);
  return str + ' '.repeat(pad);
}

// ── Console reporter ─────────────────────────────────────────────────

function formatScore(score: number): string {
  if (score == null || isNaN(score)) return dim('N/A');
  const pct = Math.round(score * 100);
  if (pct >= 80) return pass(`${pct}%`);
  if (pct >= 50) return warn(`${pct}%`);
  return fail(`${pct}%`);
}

function formatLatency(ms: number): string {
  if (ms == null || isNaN(ms)) return dim('N/A');
  if (ms < 100) return pass(`${ms}ms`);
  if (ms < 1000) return info(`${ms}ms`);
  if (ms < 5000) return warn(`${(ms / 1000).toFixed(1)}s`);
  return fail(`${(ms / 1000).toFixed(1)}s`);
}

function formatAssertionLine(r: AssertionResult): string {
  const icon = r.passed ? pass('PASS') : fail('FAIL');
  const typeStr = padRight(r.type, 20);
  const detail = r.message || `expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`;
  return `    ${icon} ${dim(typeStr)} ${detail}`;
}

export function reportToConsole(results: EvalSuiteResult[]): void {
  console.log('');
  console.log(bold('=== Agent Evaluation Results ==='));
  console.log('');

  for (const suite of results) {
    const suiteIcon = suite.failed === 0 ? pass('PASS') : fail('FAIL');
    console.log(`${suiteIcon} ${bold(suite.suite)} ${dim(`(${suite.totalTests} tests, ${formatLatency(suite.duration)})`)}`);
    console.log(`  Score: ${formatScore(suite.score)}  |  Passed: ${pass(String(suite.passed))}  |  Failed: ${suite.failed > 0 ? fail(String(suite.failed)) : dim('0')}`);
    console.log('');

    // Table header
    const COL_ID = 30;
    const COL_STATUS = 8;
    const COL_SCORE = 8;
    const COL_LATENCY = 10;

    console.log(`  ${dim(padRight('Test', COL_ID))} ${dim(padRight('Status', COL_STATUS))} ${dim(padRight('Score', COL_SCORE))} ${dim(padRight('Latency', COL_LATENCY))} ${dim('Assertions')}`);
    console.log(`  ${dim('-'.repeat(COL_ID + COL_STATUS + COL_SCORE + COL_LATENCY + 20))}`);

    for (const r of suite.results) {
      const status = r.passed ? pass('PASS') : fail('FAIL');
      const assertSummary = `${r.assertions.filter(a => a.passed).length}/${r.assertions.length}`;
      console.log(
        `  ${padRight(r.testId, COL_ID)} ${padRight(status, COL_STATUS + 9)} ${padRight(formatScore(r.score), COL_SCORE + 9)} ${padRight(formatLatency(r.latencyMs), COL_LATENCY + 9)} ${assertSummary}`,
      );

      // Show failing assertions inline
      const failing = r.assertions.filter(a => !a.passed);
      for (const a of failing) {
        console.log(formatAssertionLine(a));
      }
    }

    console.log('');
  }

  // Overall summary
  const totalTests = results.reduce((s, r) => s + r.totalTests, 0);
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  // Weight score by number of tests per suite (not simple average)
  const totalAssertions = results.reduce((s, r) => s + r.results.reduce((as, t) => as + t.assertions.length, 0), 0);
  const passedAssertions = results.reduce((s, r) => s + r.results.reduce((as, t) => as + t.assertions.filter(a => a.passed).length, 0), 0);
  const passRate = totalTests > 0 ? totalPassed / totalTests : 0;
  const assertionRate = totalAssertions > 0 ? passedAssertions / totalAssertions : 0;

  console.log(bold('--- Summary ---'));
  console.log(`  Suites: ${results.length}  |  Tests: ${totalTests}  |  Passed: ${pass(String(totalPassed))}  |  Failed: ${totalFailed > 0 ? fail(String(totalFailed)) : dim('0')}`);
  console.log(`  Pass rate: ${formatScore(passRate)} (${totalPassed}/${totalTests} tests)  |  Assertion rate: ${formatScore(assertionRate)} (${passedAssertions}/${totalAssertions} assertions)`);
  console.log('');
}

// ── Detailed console report (shows all assertions) ───────────────────

export function reportDetailedToConsole(results: EvalSuiteResult[]): void {
  reportToConsole(results);

  for (const suite of results) {
    console.log(bold(`\n--- ${suite.suite} Detail ---\n`));
    for (const r of suite.results) {
      const status = r.passed ? pass('PASS') : fail('FAIL');
      console.log(`${status} ${bold(r.testId)}`);
      console.log(`  Input: ${dim(r.input.slice(0, 100))}`);
      if (r.output) {
        console.log(`  Output: ${dim(r.output.slice(0, 150))}`);
      }
      console.log(`  Latency: ${formatLatency(r.latencyMs)}`);
      console.log('  Assertions:');
      for (const a of r.assertions) {
        console.log(formatAssertionLine(a));
      }
      console.log('');
    }
  }
}

// ── JSON export ──────────────────────────────────────────────────────

/**
 * Export results as a JSON object suitable for the eval UI.
 */
export function toJSON(results: EvalSuiteResult[]): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    suites: results.map(s => ({
      ...s,
      timestamp: s.timestamp.toISOString(),
      results: s.results.map(r => ({
        ...r,
        timestamp: r.timestamp.toISOString(),
      })),
    })),
    summary: (() => {
      const totalTests = results.reduce((s, r) => s + r.totalTests, 0);
      const totalPassed = results.reduce((s, r) => s + r.passed, 0);
      const totalFailed = results.reduce((s, r) => s + r.failed, 0);
      const totalAssertions = results.reduce((s, r) => s + r.results.reduce((as, t) => as + t.assertions.length, 0), 0);
      const passedAssertions = results.reduce((s, r) => s + r.results.reduce((as, t) => as + t.assertions.filter(a => a.passed).length, 0), 0);
      return {
        totalSuites: results.length,
        totalTests,
        totalPassed,
        totalFailed,
        passRate: totalTests > 0 ? totalPassed / totalTests : 0,
        assertionPassRate: totalAssertions > 0 ? passedAssertions / totalAssertions : 0,
        totalAssertions,
        passedAssertions,
      };
    })(),
  }, null, 2);
}

// ── File persistence ─────────────────────────────────────────────────

/**
 * Save results to eval/results/ with timestamp-based filename.
 */
export async function saveResults(
  results: EvalSuiteResult[],
  outputDir?: string,
): Promise<string> {
  const dir = outputDir || resolve(process.cwd(), 'eval', 'results');

  // Ensure directory exists
  const { mkdirSync } = await import('fs');
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `eval-${ts}.json`;
  const filePath = resolve(dir, filename);

  await Bun.write(filePath, toJSON(results));

  return filePath;
}
