#!/usr/bin/env tsx
/**
 * What the orchestrator hop costs, from the rows the product already writes.
 *
 * This is the measurement for Phase 9 of the rebuild plan. Run it before the
 * change and after, against comparable traffic, and compare the two.
 *
 * The number that matters is `answered alone`: an orchestrator run that spawned
 * no specialist is a model that read the request, decided it needed nobody, and
 * answered — after the classifier had already read the same request to decide
 * the orchestrator should run at all. Those runs are the hop paying for itself
 * and returning nothing, and Phase 9 succeeds when the class is empty because
 * there is no orchestrator left to run.
 *
 * Deliberately reads `agents` rather than a new counter: a measurement that
 * needs instrumentation shipped first is a measurement that never gets taken.
 *
 *   npx tsx --import ./scripts/md-loader.mjs scripts/orchestrator-cost.ts
 *   … --json out.json     write the numbers instead of printing them
 *   … --since 2026-08-01  only runs created on or after this date
 */
import '../src/config/load-env-file';
import postgres from 'postgres';
import { writeFileAt } from '@/utils/fs-file';

const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const SINCE = arg('since');
const JSON_OUT = arg('json');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('orchestrator-cost: DATABASE_URL is not set');
  process.exit(2);
}

const sql = postgres(url, { max: 1 });
const since = SINCE ? new Date(SINCE) : new Date(0);
if (Number.isNaN(since.getTime())) {
  console.error(`orchestrator-cost: --since "${SINCE}" is not a date`);
  process.exit(2);
}

try {
  const [totals] = await sql`
    select
      coalesce(sum(total_tokens), 0)::bigint as all_tokens,
      coalesce(sum(total_tokens) filter (where role = 'orchestrator'), 0)::bigint as orch_tokens,
      count(*) filter (where role = 'orchestrator')::int as orch_runs
    from agents where created_at >= ${since}`;

  // An orchestrator run "delegated" when its session also holds a
  // non-orchestrator agent row. Session-scoped rather than parent-scoped
  // because `parent_agent_id` is null for workers the swarm spawned.
  const split = await sql`
    with orch as (
      select id, session_id, total_tokens, duration_ms
      from agents where role = 'orchestrator' and created_at >= ${since}
    ),
    kids as (
      select o.id, count(a.id)::int as children
      from orch o
      left join agents a on a.session_id = o.session_id and a.role <> 'orchestrator'
      group by o.id
    )
    select
      case when k.children = 0 then 'answered alone' else 'delegated' end as bucket,
      count(*)::int as runs,
      coalesce(round(avg(o.total_tokens)), 0)::int as avg_tokens,
      coalesce(sum(o.total_tokens), 0)::bigint as total_tokens,
      coalesce(round(avg(o.duration_ms)), 0)::int as avg_ms
    from kids k join orch o using (id)
    group by 1 order by runs desc`;

  const alone = split.find((r) => r.bucket === 'answered alone');
  const orchRuns = Number(totals.orch_runs);
  const allTokens = Number(totals.all_tokens);
  const orchTokens = Number(totals.orch_tokens);

  const report = {
    since: SINCE ?? 'all time',
    orchestratorRuns: orchRuns,
    answeredAlone: Number(alone?.runs ?? 0),
    answeredAlonePct: orchRuns > 0 ? +((100 * Number(alone?.runs ?? 0)) / orchRuns).toFixed(1) : 0,
    wastedTokens: Number(alone?.total_tokens ?? 0),
    orchestratorTokens: orchTokens,
    allAgentTokens: allTokens,
    orchestratorSharePct: allTokens > 0 ? +((100 * orchTokens) / allTokens).toFixed(1) : 0,
    breakdown: split.map((r) => ({
      bucket: r.bucket as string,
      runs: Number(r.runs),
      avgTokens: Number(r.avg_tokens),
      totalTokens: Number(r.total_tokens),
      avgMs: Number(r.avg_ms),
    })),
  };

  if (JSON_OUT) {
    await writeFileAt(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${JSON_OUT}`);
  } else {
    console.log(`\norchestrator cost · ${report.since}\n`);
    console.table(report.breakdown);
    console.log(
      `\n  ${report.answeredAlone}/${report.orchestratorRuns} orchestrator runs (${report.answeredAlonePct}%) delegated to nobody` +
      `\n  ${report.wastedTokens.toLocaleString()} tokens spent on those runs` +
      `\n  ${report.orchestratorSharePct}% of all agent tokens went on being the orchestrator\n`,
    );
    if (report.answeredAlone === 0 && report.orchestratorRuns > 0) {
      console.log('  every orchestrator run delegated — the hop is earning its place.\n');
    }
  }
} finally {
  await sql.end();
}
