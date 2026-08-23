/**
 * Run health — how long an agent run keeps the user waiting AFTER its answer
 * is already written, plus how much of its wall-clock is dead time.
 *
 * Why this exists: run 4f88751a produced its final text at 10:16:42 and only
 * reported `completed` at 10:30:47. The answer was finished; the user waited
 * 14 more minutes for it. Nothing in the logs named the cause, and no metric
 * would have caught it — `duration_ms` looked like "a slow run", not like "a
 * finished run that wasn't delivered". A sweep over the recorded events showed
 * it was not an outlier: the median run wasted 43s past its answer and 38% of
 * runs wasted over a minute, including a daily cron that burned ~15 min every
 * single day.
 *
 * The measure is deliberately end-user-shaped:
 *
 *   deliveryLag = complete(event) − last assistant text(event)
 *
 * Everything in that window is, by construction, work the user gained nothing
 * from — the words they end up reading already existed when the window opened.
 * Post-answer bookkeeping is legitimate; making someone wait for it is not.
 *
 * Usage:
 *   npx tsx scripts/run-health.ts              # last 30 days
 *   npx tsx scripts/run-health.ts --days 7
 *   npx tsx scripts/run-health.ts --worst 20   # slowest runs, detailed
 *   npx tsx scripts/run-health.ts --p95 10     # gate: fail if p95 lag > 10s
 *
 * Exits 1 when a `--p95` budget is given and exceeded, so CI or a cron can
 * gate on it; otherwise exits 0 and just reports.
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initializeDb } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { initializeVault } from '../src/security/vault';

interface RunRow {
  agent_id: string;
  model: string;
  role: string;
  iterations: number;
  lag_s: number;
  total_s: number;
  answer_at: string;
}

function rows<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { rows?: unknown }).rows)) {
    return (r as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Nearest-rank percentile over an ASCENDING array. Nearest-rank (not
 * interpolated) so every reported number is a lag some real run actually had —
 * an interpolated "p95 = 41.7s" that no run experienced is harder to act on.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

/** Human-readable duration; keeps small values legible instead of "0min". */
export function fmt(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m${String(Math.round(seconds - m * 60)).padStart(2, '0')}s`;
}

/**
 * Pair each run's last assistant text with its terminal event.
 *
 * `thought` rows carrying a `text` key are the assistant's own prose — the
 * thing the user ultimately reads. Runs without one (pure tool runs, crashes
 * before any text) are excluded rather than scored zero: they have no "answer
 * was ready" moment, so a lag is undefined, and counting them as 0 would
 * dilute the statistic that matters.
 */
async function loadRuns(days: number): Promise<RunRow[]> {
  const res = await getDb().execute(sql`
    WITH last_text AS (
      SELECT agent_id, MAX(created_at) AS answer_at
        FROM agent_events
       WHERE type = 'thought' AND data ? 'text'
         AND created_at > now() - (${days}::text || ' days')::interval
       GROUP BY agent_id
    ),
    done AS (
      SELECT agent_id, MIN(created_at) AS done_at
        FROM agent_events
       WHERE type = 'complete'
       GROUP BY agent_id
    )
    SELECT lt.agent_id,
           a.model,
           a.role,
           a.iterations,
           EXTRACT(EPOCH FROM (d.done_at - lt.answer_at))::float8 AS lag_s,
           (a.duration_ms / 1000.0)::float8                       AS total_s,
           lt.answer_at::text                                     AS answer_at
      FROM last_text lt
      JOIN done d USING (agent_id)
      JOIN agents a ON a.id::text = lt.agent_id
     WHERE d.done_at >= lt.answer_at
     ORDER BY lag_s DESC
  `);
  return rows<RunRow>(res);
}

/**
 * Rubber-stamp rate — the share of PASSING audit verdicts the audit-coverage
 * gate had to reject because the auditor could not name the stages it covered
 * (docs/plans/audit-coverage-gate.md).
 *
 * The second dimension this script measures, and the reason the gate is worth
 * more than a unit test: it gives a baseline the day it lands and a target to
 * loop against. Read it as a signal about the PROMPTS, not the gate — a rate
 * that stays high means review stages are being asked the wrong question; a
 * rate that sits at zero for a long window means the gate could relax to
 * sampling.
 *
 * Returns 0 when nothing was audited: no audits is not a clean record.
 */
export function rubberStampRate(total: number, rejected: number): number {
  if (total <= 0) return 0;
  return rejected / total;
}

interface AuditTally {
  total: number;
  rejected: number;
}

/** Audit-coverage verdicts in the window. Only PASSING verdicts are gated, so
 *  every row here is a verdict that claimed success. */
async function loadAuditTally(days: number): Promise<AuditTally> {
  const res = await getDb().execute(sql`
    SELECT COUNT(*)::int                                   AS total,
           COUNT(*) FILTER (WHERE passed = false)::int      AS rejected
      FROM verification_evidence
     WHERE kind = 'audit_coverage'
       AND created_at > now() - (${days}::text || ' days')::interval
  `);
  const [row] = rows<AuditTally>(res);
  return { total: row?.total ?? 0, rejected: row?.rejected ?? 0 };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(arg('days') ?? 30);
  const worst = Number(arg('worst') ?? 10);
  const p95Budget = arg('p95') ? Number(arg('p95')) : null;

  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeVault();

  try {
    const audits = await loadAuditTally(days);
    if (audits.total > 0) {
      const rate = rubberStampRate(audits.total, audits.rejected);
      console.log(`\nRubber-stamp rate — passing audit verdicts that named nothing they audited`);
      console.log(`  window        ${days}d · ${audits.total} passing verdicts`);
      console.log(`  rejected      ${audits.rejected} (${(rate * 100).toFixed(0)}%)`);
    } else {
      console.log(`\nRubber-stamp rate — no audit-coverage verdicts recorded in the last ${days} days.`);
    }

    const runs = await loadRuns(days);
    if (runs.length === 0) {
      console.log(`No completed runs with a recorded answer in the last ${days} days.`);
      return 0;
    }

    const lags = runs.map((r) => r.lag_s).sort((a, b) => a - b);
    const p50 = percentile(lags, 50);
    const p95 = percentile(lags, 95);
    const total = lags.reduce((a, b) => a + b, 0);
    const over10 = lags.filter((l) => l > 10).length;
    const over60 = lags.filter((l) => l > 60).length;
    const pct = (n: number) => `${((n / runs.length) * 100).toFixed(0)}%`;

    console.log(`\nDelivery lag — time users waited AFTER the answer was written`);
    console.log(`  window        ${days}d · ${runs.length} runs`);
    console.log(`  median        ${fmt(p50)}`);
    console.log(`  p95           ${fmt(p95)}`);
    console.log(`  worst         ${fmt(lags[lags.length - 1])}`);
    console.log(`  > 10s         ${over10} runs (${pct(over10)})`);
    console.log(`  > 60s         ${over60} runs (${pct(over60)})`);
    console.log(`  wasted total  ${fmt(total)}`);

    if (worst > 0) {
      console.log(`\nSlowest ${Math.min(worst, runs.length)} to deliver:`);
      for (const r of runs.slice(0, worst)) {
        const share = r.total_s > 0 ? `${((r.lag_s / r.total_s) * 100).toFixed(0)}% of run` : 'n/a';
        console.log(
          `  ${fmt(r.lag_s).padStart(8)}  ${share.padStart(12)}  ` +
            `${r.role}/${r.model} iter=${r.iterations}  ${r.answer_at.slice(0, 19)}  ${r.agent_id.slice(0, 8)}`,
        );
      }
    }

    if (p95Budget != null) {
      if (p95 > p95Budget) {
        console.log(`\nFAIL — p95 delivery lag ${fmt(p95)} exceeds the ${fmt(p95Budget)} budget.`);
        return 1;
      }
      console.log(`\nOK — p95 delivery lag ${fmt(p95)} is within the ${fmt(p95Budget)} budget.`);
    }
    return 0;
  } finally {
    // Always release the handles: this script is meant to be run from cron and
    // from CI, where a leaked pool keeps the process alive past its report.
    await closeDb();
    await closeStorage();
  }
}

// Only run the CLI when executed directly — importing this module from the
// test must not open a DB connection or exit the test process.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Run-health check failed:', err);
      process.exit(2);
    });
}
