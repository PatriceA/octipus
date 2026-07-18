#!/usr/bin/env bun
/**
 * coverage-check.ts — make test coverage visible and ratchet it.
 *
 * Reads the lcov report bun writes to `coverage/lcov.info` (see bunfig.toml),
 * computes overall line + function coverage, prints a summary (to the GitHub
 * Actions job summary when `$GITHUB_STEP_SUMMARY` is set, else stdout), and
 * fails if coverage has dropped more than `tolerance` below the committed
 * baseline in `scripts/coverage-baseline.json`.
 *
 * This is deliberately self-contained — no Codecov account, token, or
 * third-party upload — so it works on any fork with zero setup and never hits a
 * paywall. Bump the baseline (see the printed hint) when coverage rises so the
 * ratchet keeps pace.
 *
 * The pure logic lives in `evaluateCoverage` so it can be unit-tested without a
 * real lcov file on disk; this file is the thin CLI wrapper.
 */
import { readFileSync, appendFileSync } from 'fs';
import { join } from 'path';

export interface CoverageTotals {
  lines: { hit: number; found: number; pct: number };
  functions: { hit: number; found: number; pct: number };
}

export interface CoverageBaseline {
  lines: number;
  functions: number;
  /** Allowed drop (percentage points) below baseline before failing. */
  tolerance: number;
}

export interface CoverageVerdict {
  totals: CoverageTotals;
  baseline: CoverageBaseline;
  ok: boolean;
  /** Lines that fell below (baseline - tolerance). */
  failures: string[];
  /** Metrics that rose enough to warrant bumping the baseline. */
  improvements: string[];
  summaryMarkdown: string;
}

const pct = (hit: number, found: number): number => (found === 0 ? 100 : (hit / found) * 100);

/** Sum `LF`/`LH`/`FNF`/`FNH` records across an lcov report into overall totals. */
export function parseLcov(lcov: string): CoverageTotals {
  const sum = (re: RegExp): number => {
    let total = 0;
    for (const m of lcov.matchAll(re)) total += Number(m[1]);
    return total;
  };
  const lf = sum(/^LF:(\d+)$/gm);
  const lh = sum(/^LH:(\d+)$/gm);
  const fnf = sum(/^FNF:(\d+)$/gm);
  const fnh = sum(/^FNH:(\d+)$/gm);
  return {
    lines: { hit: lh, found: lf, pct: pct(lh, lf) },
    functions: { hit: fnh, found: fnf, pct: pct(fnh, fnf) },
  };
}

/**
 * Parse + validate the committed baseline. A missing or non-numeric key would
 * make `baseline.<k> - tolerance` NaN and every `pct < NaN` comparison false —
 * i.e. the ratchet silently passes everything. Fail loud instead.
 */
export function parseBaseline(json: string): CoverageBaseline {
  const b = JSON.parse(json) as Record<string, unknown>;
  for (const key of ['lines', 'functions', 'tolerance'] as const) {
    if (typeof b[key] !== 'number' || !Number.isFinite(b[key])) {
      throw new Error(`coverage-baseline.json: "${key}" must be a finite number (got ${JSON.stringify(b[key])})`);
    }
  }
  return { lines: b.lines as number, functions: b.functions as number, tolerance: b.tolerance as number };
}

export function evaluateCoverage(lcov: string, baseline: CoverageBaseline): CoverageVerdict {
  const totals = parseLcov(lcov);
  const floorL = baseline.lines - baseline.tolerance;
  const floorF = baseline.functions - baseline.tolerance;
  const failures: string[] = [];
  const improvements: string[] = [];

  // No data at all (empty/truncated lcov) would otherwise report 100% via the
  // zero-denominator guard and pass the ratchet — a "no data = perfect" false
  // pass. Treat an empty report as a failure.
  if (totals.lines.found === 0) {
    failures.push(
      'no line coverage data in lcov.info — the report is empty or truncated (expected coverage from the full `bun test src scripts` run)',
    );
  }

  if (totals.lines.pct < floorL) {
    failures.push(
      `line coverage ${totals.lines.pct.toFixed(2)}% is below the floor ${floorL.toFixed(2)}% ` +
        `(baseline ${baseline.lines}% − tolerance ${baseline.tolerance}%)`,
    );
  }
  if (totals.functions.pct < floorF) {
    failures.push(
      `function coverage ${totals.functions.pct.toFixed(2)}% is below the floor ${floorF.toFixed(2)}% ` +
        `(baseline ${baseline.functions}% − tolerance ${baseline.tolerance}%)`,
    );
  }
  if (totals.lines.pct > baseline.lines + baseline.tolerance) {
    improvements.push(`lines ${baseline.lines}% → ${totals.lines.pct.toFixed(2)}%`);
  }
  if (totals.functions.pct > baseline.functions + baseline.tolerance) {
    improvements.push(`functions ${baseline.functions}% → ${totals.functions.pct.toFixed(2)}%`);
  }

  const row = (label: string, m: { hit: number; found: number; pct: number }, base: number) =>
    `| ${label} | ${m.pct.toFixed(2)}% | ${m.hit}/${m.found} | ${base}% |`;
  const summaryMarkdown = [
    '## Test coverage',
    '',
    '| Metric | Coverage | Hit/Found | Baseline |',
    '| --- | --- | --- | --- |',
    row('Lines', totals.lines, baseline.lines),
    row('Functions', totals.functions, baseline.functions),
    '',
    failures.length
      ? `❌ **Coverage ratchet failed** (tolerance ${baseline.tolerance}pp):\n\n` +
        failures.map((f) => `- ${f}`).join('\n')
      : '✅ Coverage is at or above the ratchet floor.',
    improvements.length
      ? `\n\n📈 Coverage rose — bump \`scripts/coverage-baseline.json\`: ${improvements.join(', ')}.`
      : '',
  ].join('\n');

  return { totals, baseline, ok: failures.length === 0, failures, improvements, summaryMarkdown };
}

function main(): void {
  const root = join(import.meta.dir, '..');
  let lcov: string;
  try {
    lcov = readFileSync(join(root, 'coverage', 'lcov.info'), 'utf8');
  } catch {
    console.error(
      'coverage/lcov.info not found. Run `bun test src scripts` first (bunfig.toml enables lcov coverage).',
    );
    process.exit(2);
  }
  let baseline: CoverageBaseline;
  try {
    baseline = parseBaseline(readFileSync(join(root, 'scripts', 'coverage-baseline.json'), 'utf8'));
  } catch (err) {
    console.error(`Invalid scripts/coverage-baseline.json: ${(err as Error).message}`);
    process.exit(2);
  }
  const verdict = evaluateCoverage(lcov, baseline);

  console.log(verdict.summaryMarkdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${verdict.summaryMarkdown}\n`);
  }
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.main) main();
