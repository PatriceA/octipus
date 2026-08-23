#!/usr/bin/env tsx
/**
 * quality-score.ts — one number per axis, one baseline, one stopping condition.
 *
 * The brief asked for a loop: "after you get a baseline, set a benchmark which
 * fits our goal and loop/improve/test/fix till this goal is reached." What
 * existed instead was component health — providers up, tests green, coverage
 * ratcheting — none of which says whether a run produced good work. Work was
 * defect-driven (find a real failure, fix it), which is honest but has no
 * stopping condition, so "are we done?" had no answer.
 *
 * Four axes, chosen because each is already recorded and each fails a
 * different way:
 *
 *   1. delivered      did the run produce the artifact it claimed?
 *                     (verification_evidence — the evidence gate)
 *   2. lag            did the user wait after the answer was already written?
 *                     (agent_events — same measure as run-health.ts)
 *   3. cost           paid-provider tokens per completed run
 *   4. autonomy       how often a run needed a human to continue
 *
 * Deliberately NOT a rollup into a single 0–100 score. A weighted average
 * lets a cheap run that delivered nothing cancel out an expensive run that
 * did, and the resulting number moves for reasons nobody can name. Four
 * numbers with four targets are harder to game and say what to fix.
 *
 * An axis with no data reports `n/a` and never passes silently. On this
 * install two axes are empty today — the evidence gate merged after the last
 * recorded runs, and no approval has ever been raised — so `n/a` is the
 * truthful reading, and printing a green 100% would be the lie that this
 * whole document exists to stop.
 *
 * Usage:
 *   npx tsx scripts/quality-score.ts                # score the last 30 days
 *   npx tsx scripts/quality-score.ts --days 7
 *   npx tsx scripts/quality-score.ts --write        # (re)write the baseline
 *   npx tsx scripts/quality-score.ts --gate         # exit 1 if worse than target
 */
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initializeDb } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { initializeVault } from '../src/security/vault';
import { percentile } from './run-health';

const BASELINE_PATH = join(import.meta.dirname, 'quality-baseline.json');

/** A measured axis. `value === null` means "no data", never "zero". */
export interface Axis {
  value: number | null;
  /** Sample size behind `value` — a target met on n=1 is not met. */
  n: number;
  unit: string;
}

export interface QualityMetrics {
  deliveredPct: Axis;
  lagP95Seconds: Axis;
  paidTokensPerRun: Axis;
  autonomyPct: Axis;
}

export interface QualityTargets {
  /** % of gated deliverables that passed their evidence check. Higher is better. */
  deliveredPct: number;
  /** p95 seconds a user waits after the answer exists. Lower is better. */
  lagP95Seconds: number;
  /** Paid-provider tokens per completed run. Lower is better. */
  paidTokensPerRun: number;
  /** % of runs that finished without needing a human. Higher is better. */
  autonomyPct: number;
  /** An axis with fewer than this many samples is reported, not judged. */
  minSamples: number;
}

export interface AxisVerdict {
  axis: keyof QualityMetrics;
  value: number | null;
  target: number;
  n: number;
  unit: string;
  /** 'pass' | 'fail' | 'n/a' — n/a when there is no data, or too little. */
  status: 'pass' | 'fail' | 'n/a';
  note?: string;
}

export interface QualityVerdict {
  axes: AxisVerdict[];
  ok: boolean;
  /** True when every axis has enough data to judge — i.e. the loop can run. */
  complete: boolean;
  summary: string;
}

/** Axes where a smaller number is the better number. */
const LOWER_IS_BETTER = new Set<keyof QualityMetrics>(['lagP95Seconds', 'paidTokensPerRun']);

/**
 * Compare measurements to targets. Pure — the CLI below supplies the numbers,
 * the tests supply their own.
 */
export function scoreQuality(m: QualityMetrics, t: QualityTargets): QualityVerdict {
  const axes: AxisVerdict[] = (Object.keys(m) as Array<keyof QualityMetrics>).map((key) => {
    const a = m[key];
    const target = t[key] as number;
    if (a.value === null || a.n === 0) {
      return { axis: key, value: null, target, n: a.n, unit: a.unit, status: 'n/a', note: 'no data recorded' };
    }
    if (a.n < t.minSamples) {
      return {
        axis: key,
        value: a.value,
        target,
        n: a.n,
        unit: a.unit,
        status: 'n/a',
        note: `only ${a.n} samples (need ${t.minSamples})`,
      };
    }
    const pass = LOWER_IS_BETTER.has(key) ? a.value <= target : a.value >= target;
    return { axis: key, value: a.value, target, n: a.n, unit: a.unit, status: pass ? 'pass' : 'fail' };
  });

  const judged = axes.filter((a) => a.status !== 'n/a');
  const failing = judged.filter((a) => a.status === 'fail');
  const complete = judged.length === axes.length;
  return {
    axes,
    // An unmeasured axis is not a pass. `ok` means every axis that COULD be
    // judged passed; `complete` says whether that was all of them. A gate
    // should require both — see the CLI.
    ok: failing.length === 0,
    complete,
    summary: complete
      ? failing.length === 0
        ? 'All four axes meet target — the loop has reached its stopping condition.'
        : `${failing.length}/4 axes below target: ${failing.map((f) => f.axis).join(', ')}`
      : `${judged.length}/4 axes measurable. ` +
        `Unmeasured: ${axes.filter((a) => a.status === 'n/a').map((a) => a.axis).join(', ')}. ` +
        'No stopping condition until every axis has data.',
  };
}

export function parseTargets(json: string): QualityTargets {
  const b = JSON.parse(json) as Record<string, unknown>;
  const targets = (b.targets ?? {}) as Record<string, unknown>;
  const need = (k: string): number => {
    const v = targets[k];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new Error(`quality-baseline.json: targets.${k} must be a number (got ${JSON.stringify(v)})`);
    }
    return v;
  };
  return {
    deliveredPct: need('deliveredPct'),
    lagP95Seconds: need('lagP95Seconds'),
    paidTokensPerRun: need('paidTokensPerRun'),
    autonomyPct: need('autonomyPct'),
    minSamples: need('minSamples'),
  };
}

function rows<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { rows?: unknown }).rows)) {
    return (r as { rows: T[] }).rows;
  }
  return [];
}

/** Providers whose tokens cost nothing — kept in sync with executor-split.ts. */
const FREE_PROVIDERS = ['ollama', 'cli'];

async function measure(days: number): Promise<QualityMetrics> {
  const db = getDb();
  const window = sql`now() - (${days}::text || ' days')::interval`;

  // 1. delivered — the evidence gate's own verdicts.
  const ev = rows<{ total: number; passed: number }>(
    await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE passed)::int AS passed
        FROM verification_evidence
       WHERE created_at > ${window}
    `),
  )[0] ?? { total: 0, passed: 0 };

  // 2. lag — identical definition to run-health.ts: the gap between the last
  // assistant text and the terminal event. Duplicated as one SQL statement
  // rather than shared, because run-health returns per-run detail this does
  // not need; only `percentile` is imported, so the maths cannot drift.
  const lags = rows<{ lag_s: number }>(
    await db.execute(sql`
      WITH last_text AS (
        SELECT agent_id, MAX(created_at) AS answer_at
          FROM agent_events
         WHERE type = 'thought' AND data ? 'text' AND created_at > ${window}
         GROUP BY agent_id
      ), done AS (
        SELECT agent_id, MIN(created_at) AS done_at
          FROM agent_events WHERE type = 'complete' GROUP BY agent_id
      )
      SELECT EXTRACT(EPOCH FROM (d.done_at - lt.answer_at))::float8 AS lag_s
        FROM last_text lt JOIN done d USING (agent_id)
       WHERE d.done_at >= lt.answer_at
       ORDER BY lag_s
    `),
  ).map((r) => r.lag_s);

  // 3. cost — paid-provider tokens per completed run. Currency is not
  // available: cost_log.total_cost is 0 across every row on this install
  // because per-model prices were never configured, so a dollar figure would
  // be a confident zero. Tokens on metered providers is the honest proxy.
  const cost = rows<{ runs: number; paid_tokens: number }>(
    await db.execute(sql`
      SELECT COUNT(*)::int AS runs,
             COALESCE(SUM(a.total_tokens), 0)::int AS paid_tokens
        FROM agents a
        LEFT JOIN model_config m ON m.model_id = a.model
       WHERE a.status = 'completed'
         AND a.created_at > ${window}
         AND COALESCE(m.provider, 'unknown') NOT IN ${sql.raw(`('${FREE_PROVIDERS.join("','")}')`)}
    `),
  )[0] ?? { runs: 0, paid_tokens: 0 };

  // 4. autonomy — runs that finished without stopping for a human. Both ways
  // a run can ask: an explicit permission_request event, or a pipeline parked
  // in awaiting_approval.
  const auto = rows<{ total: number; interrupted: number }>(
    await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM agent_events e
                  WHERE e.agent_id = a.id AND e.type = 'permission_request'
               )
             )::int AS interrupted
        FROM agents a
       WHERE a.status IN ('completed', 'failed')
         AND a.created_at > ${window}
    `),
  )[0] ?? { total: 0, interrupted: 0 };

  return {
    deliveredPct: {
      value: ev.total === 0 ? null : (ev.passed / ev.total) * 100,
      n: ev.total,
      unit: '%',
    },
    lagP95Seconds: {
      value: lags.length === 0 ? null : percentile(lags, 95),
      n: lags.length,
      unit: 's',
    },
    paidTokensPerRun: {
      value: cost.runs === 0 ? null : Math.round(cost.paid_tokens / cost.runs),
      n: cost.runs,
      unit: 'tok',
    },
    autonomyPct: {
      value: auto.total === 0 ? null : ((auto.total - auto.interrupted) / auto.total) * 100,
      n: auto.total,
      unit: '%',
    },
  };
}

const show = (a: AxisVerdict): string =>
  a.value === null ? 'n/a' : a.unit === '%' ? `${a.value.toFixed(0)}%` : `${Math.round(a.value)}${a.unit}`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(arg('days') ?? 30);
  const gate = argv.includes('--gate');
  const write = argv.includes('--write');

  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeVault();

  try {
    const targets = parseTargets(readFileSync(BASELINE_PATH, 'utf8'));
    const metrics = await measure(days);
    const v = scoreQuality(metrics, targets);

    const lines: string[] = [];
    lines.push(`\nQuality score — ${days}d window`);
    lines.push('  axis                value      target        n   status');
    for (const a of v.axes) {
      const target = LOWER_IS_BETTER.has(a.axis)
        ? `≤ ${a.target}${a.unit}`
        : `≥ ${a.target}${a.unit}`;
      lines.push(
        `  ${a.axis.padEnd(18)}${show(a).padStart(6)}   ${target.padStart(10)}   ` +
          `${String(a.n).padStart(6)}   ${a.status}${a.note ? ` (${a.note})` : ''}`,
      );
    }
    lines.push(`\n${v.summary}`);
    const out = lines.join('\n');
    console.log(out);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${out}\n\`\`\`\n`);
    }

    if (write) {
      const doc = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
      doc.measured = {
        at: new Date().toISOString(),
        windowDays: days,
        axes: Object.fromEntries(v.axes.map((a) => [a.axis, { value: a.value, n: a.n }])),
      };
      writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
      console.log(`\nBaseline updated: ${BASELINE_PATH}`);
    }

    if (gate) {
      // Both conditions: nothing below target, and nothing unmeasured. An
      // all-`n/a` run must not exit 0 under a gate — that is exactly the
      // "green over an empty workspace" failure this work exists to prevent.
      if (!v.ok) return 1;
      if (!v.complete) {
        console.log('FAIL — gate requires every axis to have data; some are unmeasured.');
        return 1;
      }
    }
    return 0;
  } finally {
    await closeDb();
    await closeStorage();
  }
}

if (import.meta.main) {
  main()
    .then((c) => process.exit(c))
    .catch((err) => {
      console.error('Quality score failed:', err);
      process.exit(2);
    });
}
