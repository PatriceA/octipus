#!/usr/bin/env tsx
/**
 * What the root agent hop costs, from the rows the product already writes.
 *
 * This is the measurement for Phase 9 of the rebuild plan. Run it before the
 * change and after, against comparable traffic, and compare the two.
 *
 * The number that mattered was `answered alone`: a root agent run that
 * spawned no specialist was a model that read the request, decided it needed
 * nobody, and answered — after a classifier had already read the same request
 * to decide the root agent should run at all. Those runs were the hop paying
 * for itself and returning nothing, and Phase 9 succeeds when the class is
 * empty BECAUSE THERE IS NO ORCHESTRATOR LEFT TO RUN: the root agent now holds
 * the general toolset and answering alone is the fast path, not a wasted hop.
 *
 * So the first table is a regression check that reads zero on post-change
 * traffic, and the second is the live measurement that replaces it: what a root
 * turn costs, split by whether it delegated. A root turn is a depth-0
 * `swarm_nodes` row, whose id is 1:1 with `agents.id`.
 *
 * Deliberately reads `agents` rather than a new counter: a measurement that
 * needs instrumentation shipped first is a measurement that never gets taken.
 *
 *   npx tsx --import ./scripts/md-loader.mjs scripts/root-agent-cost.ts
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
  console.error('root-agent-cost: DATABASE_URL is not set');
  process.exit(2);
}

const sql = postgres(url, { max: 1 });
const since = SINCE ? new Date(SINCE) : new Date(0);
if (Number.isNaN(since.getTime())) {
  console.error(`root-agent-cost: --since "${SINCE}" is not a date`);
  process.exit(2);
}

try {
  const [totals] = await sql`
    select
      coalesce(sum(total_tokens), 0)::bigint as all_tokens,
      coalesce(sum(total_tokens) filter (where role = 'orchestrator'), 0)::bigint as orch_tokens,
      count(*) filter (where role = 'orchestrator')::int as orch_runs
    from agents where created_at >= ${since}`;

  // A root agent run "delegated" when its session also holds a
  // non-root agent agent row. Session-scoped rather than parent-scoped
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

  // The live shape: root turns, which are depth-0 swarm nodes. Same split, but
  // "answered alone" here is the fast path rather than the waste — what to watch
  // is the cost of a root turn against the 8,975 tokens the old hop averaged
  // for producing nothing.
  const roots = await sql`
    with root as (
      select n.id, n.root_session_id, a.total_tokens, a.duration_ms
      from swarm_nodes n
      join agents a on a.id = n.id
      where n.depth = 0 and a.created_at >= ${since} and a.role <> 'orchestrator'
    ),
    kids as (
      select r.id, count(c.id)::int as children
      from root r
      left join swarm_nodes c on c.parent_node_id = r.id
      group by r.id
    )
    select
      case when k.children = 0 then 'answered alone' else 'delegated' end as bucket,
      count(*)::int as runs,
      coalesce(round(avg(r.total_tokens)), 0)::int as avg_tokens,
      coalesce(sum(r.total_tokens), 0)::bigint as total_tokens,
      coalesce(round(avg(r.duration_ms)), 0)::int as avg_ms
    from kids k join root r using (id)
    group by 1 order by runs desc`;

  const alone = split.find((r) => r.bucket === 'answered alone');
  const orchRuns = Number(totals.orch_runs);
  const allTokens = Number(totals.all_tokens);
  const orchTokens = Number(totals.orch_tokens);

  const report = {
    since: SINCE ?? 'all time',
    rootAgentRuns: orchRuns,
    answeredAlone: Number(alone?.runs ?? 0),
    answeredAlonePct: orchRuns > 0 ? +((100 * Number(alone?.runs ?? 0)) / orchRuns).toFixed(1) : 0,
    wastedTokens: Number(alone?.total_tokens ?? 0),
    rootAgentTokens: orchTokens,
    allAgentTokens: allTokens,
    rootAgentSharePct: allTokens > 0 ? +((100 * orchTokens) / allTokens).toFixed(1) : 0,
    rootTurns: roots.map((r) => ({
      bucket: r.bucket as string,
      runs: Number(r.runs),
      avgTokens: Number(r.avg_tokens),
      totalTokens: Number(r.total_tokens),
      avgMs: Number(r.avg_ms),
    })),
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
    console.log(`\nroot turns (the one loop) · ${report.since}\n`);
    console.table(report.rootTurns);
    console.log(`\nlegacy orchestrator hop · ${report.since} — expected empty after Phase 9\n`);
    console.table(report.breakdown);
    console.log(
      `\n  ${report.answeredAlone}/${report.rootAgentRuns} orchestrator runs (${report.answeredAlonePct}%) delegated to nobody` +
      `\n  ${report.wastedTokens.toLocaleString()} tokens spent on those runs` +
      `\n  ${report.rootAgentSharePct}% of all agent tokens went on being the orchestrator\n`,
    );
    if (report.rootAgentRuns === 0) {
      console.log('  no orchestrator runs at all — the hop is gone, which is what Phase 9 asserts.\n');
    } else if (report.answeredAlone === 0) {
      console.log('  every orchestrator run delegated — the hop is earning its place.\n');
    }
  }
} finally {
  await sql.end();
}
