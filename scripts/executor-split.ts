#!/usr/bin/env tsx
/**
 * executor-split.ts — is the planner→executor split actually saving anything?
 *
 * The W9 split routes a child to a lane's cheap `executorModel` *when the
 * parent supplied a plan*. Phases 1–4 shipped the routing; nothing measured
 * the outcome, and the brief was explicit that routing is not the point:
 *
 *   "Make sure it is like that, and not the 'big' model actually did all the
 *    work beforehand (planned in such detail that doing it would be nearly no
 *    difference) and the local model just uses a few tokens to run 5 commands."
 *
 * That failure mode is measurable. A plan whose executor makes ~no tool calls
 * did not delegate work — it transcribed a finished answer, paid the planner
 * for all of it, and added a hop. So this reports, per planned spawn:
 *
 *   plannerTokens    the parent's tokens (counted once per parent)
 *   executorTokens   the planned child's tokens
 *   executorToolCalls  `action` events the child actually emitted
 *
 * and gates on the two conditions the plan named: enough executor tool calls
 * to be real work, and enough of the token mass moved off the paid planner.
 *
 * Two honesty rules the numbers depend on:
 *
 *  - **Paid ≠ total.** A local executor's tokens are free; counting them as
 *    "saved cost" would let a lane look thriftier the more it rambles. Tokens
 *    are classified by the model's provider (`model_config.provider`) — the
 *    `cost_log` money column exists but is all zeros on this install because
 *    per-model prices were never configured, so currency is not available.
 *  - **Zero is not cheap.** CLI-backed providers frequently report 0 tokens.
 *    Those spawns are counted as *unmeasured* and excluded from the ratios
 *    rather than being folded in as a free executor, which would manufacture
 *    a saving out of missing telemetry.
 *
 * Usage:
 *   npx tsx scripts/executor-split.ts               # last 30 days
 *   npx tsx scripts/executor-split.ts --days 7
 *   npx tsx scripts/executor-split.ts --gate        # exit 1 if the split fails
 *
 * The pure logic lives in `evaluateSplit` so it is unit-testable without a DB;
 * everything below it is a thin CLI wrapper (same shape as coverage-check.ts).
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initializeDb } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { initializeVault } from '../src/security/vault';

/** One planned spawn, joined to its parent and its tool-call count. */
export interface SplitRow {
  node_id: string;
  role: string;
  child_model: string;
  child_provider: string | null;
  child_tokens: number;
  tool_calls: number;
  parent_id: string;
  parent_model: string;
  parent_provider: string | null;
  parent_tokens: number;
  created_at: string;
}

/**
 * Providers whose tokens cost nothing: models running on this machine
 * (`ollama`) and CLI sub-agents billed through someone's existing seat
 * (`cli`). Everything else is a metered API. An unknown provider (a model
 * row deleted after the run) counts as paid — the conservative direction,
 * since guessing "free" would understate spend.
 */
export const FREE_PROVIDERS = new Set(['ollama', 'cli']);

export function isPaid(provider: string | null | undefined): boolean {
  return !FREE_PROVIDERS.has((provider ?? '').trim());
}

export interface SplitThresholds {
  /** Below this many executor tool calls, a planned spawn is transcription. */
  minToolCalls: number;
  /** Fail if more than this share (%) of measurable planned spawns are trivial. */
  maxTrivialPct: number;
  /** Fail if less than this share (%) of paid tokens moved off the planner. */
  minOffloadPct: number;
}

export const DEFAULT_THRESHOLDS: SplitThresholds = {
  minToolCalls: 3,
  maxTrivialPct: 25,
  minOffloadPct: 20,
};

export interface SplitVerdict {
  /** Planned spawns seen in the window. */
  spawns: number;
  /** Planned spawns whose child reported 0 tokens — excluded from ratios. */
  unmeasured: number;
  /** Measurable spawns whose PARENT reported 0 tokens — no offload can be priced. */
  uncosted: number;
  /** Planned spawns with < minToolCalls executor tool calls. */
  trivial: SplitRow[];
  plannerTokens: number;
  executorTokens: number;
  paidPlannerTokens: number;
  paidExecutorTokens: number;
  /** Executor share of all tokens, 0–100. */
  executorSharePct: number;
  /**
   * Share of *paid* tokens that landed on the executor rather than the
   * planner, 0–100. This is the saving: a planned run whose executor is local
   * scores 0% paid-executor — which is the win — so the reported number is
   * `paidOffloadPct`: how much of the work left the paid planner.
   */
  paidOffloadPct: number;
  medianToolCalls: number;
  ok: boolean;
  failures: string[];
  summary: string;
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : (n / d) * 100);

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * Score a window of planned spawns.
 *
 * `plannerTokens` is summed over *distinct* parents: a parent that spawned
 * three planned children is one planner, and counting its tokens three times
 * would make the split look worse the more it fans out.
 *
 * ponytail: a parent with a mix of planned and unplanned children contributes
 * all of its tokens here, including the thinking it did for the unplanned
 * ones. There is no per-child attribution of a parent's tokens to split them
 * with, so this over-attributes to the planner — the conservative direction
 * (it understates the saving). Attribute properly only if a lane ever mixes
 * planned and unplanned children in the same run often enough to matter.
 */
export function evaluateSplit(
  rows: SplitRow[],
  thresholds: SplitThresholds = DEFAULT_THRESHOLDS,
): SplitVerdict {
  const measurable = rows.filter((r) => r.child_tokens > 0);
  const unmeasured = rows.length - measurable.length;

  // The token ratios need BOTH sides. A parent that reports 0 tokens — a
  // CLI-backed orchestrator, or a harness that wrote the plan itself — makes
  // `paidOffloadPct` read 100% no matter what the executor did, which is the
  // mirror image of treating a 0-token executor as free. Such rows still
  // count for the tool-call analysis below; they just cannot price anything.
  const costed = measurable.filter((r) => r.parent_tokens > 0);
  const uncosted = measurable.length - costed.length;

  const parents = new Map<string, SplitRow>();
  for (const r of costed) if (!parents.has(r.parent_id)) parents.set(r.parent_id, r);

  const plannerTokens = [...parents.values()].reduce((a, r) => a + r.parent_tokens, 0);
  const paidPlannerTokens = [...parents.values()]
    .filter((r) => isPaid(r.parent_provider))
    .reduce((a, r) => a + r.parent_tokens, 0);
  const executorTokens = costed.reduce((a, r) => a + r.child_tokens, 0);
  const paidExecutorTokens = costed
    .filter((r) => isPaid(r.child_provider))
    .reduce((a, r) => a + r.child_tokens, 0);

  // Trivial spawns are judged on measurable rows only. A spawn that reported
  // no tokens may still have made real tool calls, but we cannot say whether
  // it saved anything, so it is neither credited nor blamed.
  const trivial = measurable.filter((r) => r.tool_calls < thresholds.minToolCalls);

  const totalTokens = plannerTokens + executorTokens;
  const paidTotal = paidPlannerTokens + paidExecutorTokens;
  // How much work left the paid planner: everything that is not paid-planner
  // tokens. A local executor scores 100% here, which is the intended win.
  const paidOffloadPct = totalTokens === 0 ? 0 : pct(totalTokens - paidPlannerTokens, totalTokens);

  const trivialPct = pct(trivial.length, measurable.length);
  const failures: string[] = [];
  if (measurable.length > 0) {
    if (trivialPct > thresholds.maxTrivialPct) {
      failures.push(
        `${trivial.length}/${measurable.length} planned spawns (${trivialPct.toFixed(0)}%) made ` +
          `< ${thresholds.minToolCalls} tool calls — the plan was detailed enough that execution ` +
          `was transcription, so the split moved work instead of saving it.`,
      );
    }
    if (costed.length > 0 && paidOffloadPct < thresholds.minOffloadPct) {
      failures.push(
        `only ${paidOffloadPct.toFixed(0)}% of tokens left the paid planner ` +
          `(want ≥ ${thresholds.minOffloadPct}%) — the executor is carrying almost none of the run.`,
      );
    }
  }

  const summary =
    measurable.length === 0
      ? rows.length === 0
        ? 'No planned spawns in the window — the executor path was never exercised.'
        : `${rows.length} planned spawns, all reporting 0 tokens — nothing measurable.`
      : `${measurable.length} measurable planned spawns · ` +
        (costed.length === 0
          ? 'no planner token cost recorded, so no saving can be priced · '
          : `${paidOffloadPct.toFixed(0)}% of tokens off the paid planner · `) +
        `${trivial.length} trivial (< ${thresholds.minToolCalls} tool calls)`;

  return {
    spawns: rows.length,
    unmeasured,
    uncosted,
    trivial,
    plannerTokens,
    executorTokens,
    paidPlannerTokens,
    paidExecutorTokens,
    executorSharePct: pct(executorTokens, totalTokens),
    paidOffloadPct,
    medianToolCalls: median(measurable.map((r) => r.tool_calls)),
    ok: failures.length === 0,
    failures,
    summary,
  };
}

function rows<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { rows?: unknown }).rows)) {
    return (r as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Planned children joined to their parent node and their `action` event count.
 *
 * `agent_events.agent_id` matches `swarm_nodes.id` (the node id *is* the agent
 * id), so tool calls come straight from the event trail — no extra
 * instrumentation, and it counts what the child actually did rather than what
 * it claimed.
 */
async function loadPlanned(days: number): Promise<SplitRow[]> {
  const res = await getDb().execute(sql`
    SELECT c.id                                        AS node_id,
           c.role,
           c.model                                     AS child_model,
           cm.provider                                 AS child_provider,
           c.tokens_used                               AS child_tokens,
           COALESCE(tc.n, 0)::int                      AS tool_calls,
           p.id                                        AS parent_id,
           p.model                                     AS parent_model,
           pm.provider                                 AS parent_provider,
           p.tokens_used                               AS parent_tokens,
           c.created_at::text                          AS created_at
      FROM swarm_nodes c
      JOIN swarm_nodes p  ON p.id = c.parent_node_id
      LEFT JOIN model_config cm ON cm.model_id = c.model
      LEFT JOIN model_config pm ON pm.model_id = p.model
      LEFT JOIN (
        -- One row per invocation. An action event is emitted up to three
        -- times for the same call (tool_call, then tool_call_complete, plus
        -- an untyped batch row carrying a toolCalls array), so counting every
        -- action row runs ~3x high and would clear the did-real-work bar on
        -- a single tool call.
        SELECT agent_id, COUNT(*)::int AS n
          FROM agent_events
         WHERE type = 'action'
           AND data->>'type' IN ('tool_call', 'cli_tool_use')
         GROUP BY agent_id
      ) tc ON tc.agent_id = c.id
     WHERE c.planned = true
       AND c.created_at > now() - (${days}::text || ' days')::interval
     ORDER BY c.created_at DESC
  `);
  return rows<SplitRow>(res);
}

/** Context for the report: how often the executor path is taken at all. */
async function loadSpawnMix(days: number): Promise<{ planned: number; unplanned: number }> {
  const res = await getDb().execute(sql`
    SELECT COUNT(*) FILTER (WHERE planned)::int      AS planned,
           COUNT(*) FILTER (WHERE NOT planned)::int  AS unplanned
      FROM swarm_nodes
     WHERE parent_node_id IS NOT NULL
       AND created_at > now() - (${days}::text || ' days')::interval
  `);
  return rows<{ planned: number; unplanned: number }>(res)[0] ?? { planned: 0, unplanned: 0 };
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(arg('days') ?? 30);
  const gate = argv.includes('--gate');
  const thresholds: SplitThresholds = {
    minToolCalls: Number(arg('min-tool-calls') ?? DEFAULT_THRESHOLDS.minToolCalls),
    maxTrivialPct: Number(arg('max-trivial') ?? DEFAULT_THRESHOLDS.maxTrivialPct),
    minOffloadPct: Number(arg('min-offload') ?? DEFAULT_THRESHOLDS.minOffloadPct),
  };

  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeVault();

  try {
    const [planned, mix] = await Promise.all([loadPlanned(days), loadSpawnMix(days)]);
    const v = evaluateSplit(planned, thresholds);

    console.log(`\nPlanner→executor split — ${days}d window`);
    console.log(`  child spawns     ${mix.planned + mix.unplanned} (${mix.planned} planned, ${mix.unplanned} plan-less)`);
    if (v.spawns === 0) {
      console.log(`\n${v.summary}`);
      // Not a failure: a window with no planned spawns says the feature is
      // unused, not that it is broken. Gating on it would turn a quiet week
      // into a red build.
      console.log(`  (configure an executorModel on a lane and pass a plan to exercise it)`);
      return 0;
    }
    console.log(`  measurable       ${v.spawns - v.unmeasured}/${v.spawns} (${v.unmeasured} reported 0 tokens)`);
    if (v.uncosted > 0) {
      console.log(`  unpriced         ${v.uncosted} spawn(s) whose planner reported 0 tokens`);
    }
    console.log(`\n  planner tokens   ${k(v.plannerTokens)} (${k(v.paidPlannerTokens)} paid)`);
    console.log(`  executor tokens  ${k(v.executorTokens)} (${k(v.paidExecutorTokens)} paid)`);
    console.log(`  executor share   ${v.executorSharePct.toFixed(0)}% of tokens`);
    console.log(`  off paid planner ${v.paidOffloadPct.toFixed(0)}%`);
    console.log(`  tool calls       median ${v.medianToolCalls} per executor`);

    if (v.trivial.length > 0) {
      console.log(`\n  Trivial executors — a plan this detailed did the work already:`);
      for (const r of v.trivial.slice(0, 15)) {
        console.log(
          `    ${String(r.tool_calls).padStart(2)} calls  ${r.role}/${r.child_model}  ` +
            `${k(r.child_tokens)} tok  planner ${r.parent_model} ${k(r.parent_tokens)} tok  ` +
            `${r.created_at.slice(0, 19)}  ${r.node_id.slice(0, 8)}`,
        );
      }
      if (v.trivial.length > 15) console.log(`    … and ${v.trivial.length - 15} more`);
    }

    console.log(`\n${v.summary}`);
    if (!v.ok) {
      for (const f of v.failures) console.log(`  FAIL — ${f}`);
      return gate ? 1 : 0;
    }
    if (v.spawns - v.unmeasured > 0) console.log(`  OK — the executor is doing real work on cheap tokens.`);
    return 0;
  } finally {
    await closeDb();
    await closeStorage();
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Executor-split check failed:', err);
      process.exit(2);
    });
}
