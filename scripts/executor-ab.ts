#!/usr/bin/env tsx
/**
 * executor-ab.ts — the A/B run that decides whether the planner→executor split
 * is worth keeping.
 *
 * `executor-split.ts` scores planned spawns that already happened. This runs
 * the experiment that produces them: the SAME task brief, twice, on the same
 * lane —
 *
 *   arm A (control)     no plan  → lane primary          (paid, e.g. deepseek)
 *   arm B (treatment)   a plan   → lane `executorModel`  (cheap/local, e.g. ollama)
 *
 * and reports what each arm cost and did. That comparison is the only thing
 * that answers the brief's question, because the split's cost is invisible
 * from arm B alone: a plan detailed enough to make execution mechanical was
 * paid for on the planner, so "the executor was cheap" proves nothing on its
 * own. Only the pair shows whether the total moved.
 *
 * Both arms spawn through the real `SwarmSpawner`, so the routing under test
 * is the production path, not a reimplementation of it. The plan is supplied
 * by the harness rather than by a parent LLM deciding to write one — that
 * keeps the arms comparable (identical brief, identical tools) and makes the
 * executor path fire deterministically instead of when a model feels like it.
 *
 * Usage:
 *   npx tsx scripts/executor-ab.ts                  # every task, both arms
 *   npx tsx scripts/executor-ab.ts --task read-types
 *   npx tsx scripts/executor-ab.ts --arm b          # treatment only
 *
 * This spends real tokens on whatever the lane binds. It is a deliberate,
 * hand-run experiment — not part of CI.
 */
import { getAgentManager } from '@/core/agent-manager';
import { getSwarmSpawner } from '@/core/swarm/spawner';
import type { AgentNode, PlanStep, SpawnChildParams } from '@/core/swarm/types';
import { LEVEL_DEFAULT } from '@/core/swarm/types';
import { closeDb, getDb, initializeDb } from '@/db/postgres';
import { closeStorage, initializeStorage } from '@/db/storage';
import { loadRolesFromDb } from '@/db/seed-roles';
import { loadTopicConfigs } from '@/models/topic-config';
import { initializeVault } from '@/security/vault';
import { registerBuiltinTools } from '@/tools';
import { loadRuntimeConfig } from '@/config';
import { getSettingsService } from '@/config/settings-service';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/**
 * A task must be *executable* — something with steps a mechanical runner can
 * carry out with tools — or arm B measures nothing but a model refusing to
 * act. Each one is read-only and bounded so the experiment is repeatable and
 * cannot damage the workspace.
 */
interface AbTask {
  id: string;
  taskBrief: string;
  /** The plan for arm B. Deliberately terse: steps, not prose. */
  plan: PlanStep[];
  /** Child role; defaults to `coding`. The non-coding scenario needs its own. */
  role?: 'coding' | 'research' | 'general';
  /** Skip arm B — a scenario that exists to test competence, not the split. */
  controlOnly?: boolean;
}

const TASKS: AbTask[] = [
  {
    id: 'read-types',
    taskBrief:
      'In this repository, list every assertion type the eval harness supports. ' +
      'Read src/eval/types.ts and report the members of the AssertionType union, one per line.',
    plan: [
      { action: 'Read the file src/eval/types.ts using the filesystem tool.' },
      { action: 'Find the AssertionType union declaration.' },
      { action: 'Report each union member on its own line. No commentary.' },
    ],
  },
  {
    id: 'count-migrations',
    taskBrief:
      'Report how many SQL migration files exist in src/db/migrations, and the ' +
      'filename of the most recent one by numeric prefix.',
    plan: [
      { action: 'List the files in src/db/migrations.' },
      { action: 'Count the entries ending in .sql.' },
      { action: 'Report the count and the highest-numbered filename.' },
    ],
  },
  {
    id: 'find-script',
    taskBrief:
      'Find which script in the scripts/ directory measures delivery lag, and ' +
      'report its filename plus the one-line description from its header comment.',
    plan: [
      { action: 'List the files in the scripts/ directory.' },
      { action: 'Read the header comment of the file that looks like a health/lag report.' },
      { action: 'Report the filename and its one-line purpose.' },
    ],
  },
  {
    // The brief's only non-coding scenario, and therefore the only test of
    // whether octipus is a general assistant or just a coding agent. Run as
    // control-only: there is no executor question here, the question is
    // whether the output is something a person could actually use.
    id: 'trip-planning',
    role: 'research',
    controlOnly: true,
    taskBrief:
      'Plan a 3-day trip for two people travelling by car with a dog. We want good food, ' +
      'walks in nature, and dog-friendly stops. Give a day-by-day itinerary with concrete ' +
      'places, rough drive times, and where to eat. Assume we start from Munich, Germany.',
    plan: [],
  },
];

interface ArmResult {
  task: string;
  arm: 'A (no plan)' | 'B (planned)';
  status: string;
  model: string;
  provider: string;
  tokens: number;
  toolCalls: number;
  durationMs: number;
  outputChars: number;
  nodeId: string;
}

/** A synthetic depth-0 root agent to hang the spawn off. */
function makeParent(sessionId: string, signal: AbortSignal): AgentNode {
  return {
    id: `ab-parent-${randomUUID().slice(0, 8)}`,
    rootSessionId: sessionId,
    parentNodeId: null,
    kind: 'root',
    depth: 0,
    role: 'general',
    topicPath: 'coding',
    model: 'harness',
    budget: {
      tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 },
      wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() },
      fanOut: { cap: LEVEL_DEFAULT[0].fanOut, used: 0 },
      depth: 0,
    },
    // The child intersects with this, so it bounds what either arm can do.
    // Both arms of a task get the identical set — a difference here would
    // confound the comparison with a permissions difference.
    //
    // It must be a superset of what the task's role actually needs: granting
    // only the coding tools made the trip-planning scenario "research" a
    // German road trip by grepping the local filesystem, because `websearch`
    // had been intersected away. That looked exactly like a product defect
    // and was a harness bug.
    allowedToolIds: new Set([
      'filesystem', 'shell', 'git',
      'websearch', 'knowledge', 'task_state', 'profiles', 'artifacts', 'mcp',
    ]),
    signal,
  };
}

async function runArm(
  task: AbTask,
  arm: 'A' | 'B',
  sessionId: string,
  userId: string,
): Promise<ArmResult> {
  const ac = new AbortController();
  // Each arm gets its own root session, and therefore its own call graph.
  // Both arms send the *same* brief by design, which is exactly what the
  // duplicate-spawn guard exists to collapse: sharing a root made arm B come
  // back `cancelled` with arm A's node id, and the comparison then reported a
  // free executor that had never run. Separate roots is also the honest model
  // of the experiment — two independent runs of one task.
  const parent = makeParent(`${sessionId}`, ac.signal);
  const spawner = getSwarmSpawner();

  // Persist the parent as a real depth-0 node. A production root agent
  // always has its own swarm_nodes row, and executor-split.ts joins a planned
  // child to its parent to get the planner's token cost — without this row the
  // harness's own spawns are invisible to the report that scores them.
  await getDb().execute(sql`
    INSERT INTO swarm_nodes (id, root_session_id, user_id, parent_node_id, depth, kind,
                             role, topic_path, model, status, token_cap, tokens_used,
                             wall_clock_cap_ms, fan_out_cap, brief_hash, planned)
    VALUES (${parent.id}, ${sessionId}, ${userId}, NULL, 0, 'root',
            'root', ${task.role ?? 'coding'}, 'harness', 'completed',
            ${parent.budget.tokens.cap}, 0, ${parent.budget.wallClockMs.cap},
            ${parent.budget.fanOut.cap}, ${`ab-${task.id}-${arm}`}, false)
    ON CONFLICT (id) DO NOTHING
  `);

  const params: SpawnChildParams = {
    role: task.role ?? 'coding',
    topic: task.role ?? 'coding',
    subtopic: task.id,
    taskBrief: task.taskBrief,
    expectedOutput: { shape: 'summary', maxTokens: 800 },
    // The only difference between the arms.
    ...(arm === 'B' ? { plan: task.plan } : {}),
  };

  const started = Date.now();
  const result = await spawner.spawnChild(parent, params, {
    id: parent.id,
    sessionId,
    userId,
    topic: 'coding',
    model: 'harness',
    role: 'general',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: { originalRequest: task.taskBrief },
  } as never);

  // Read back what the run actually did rather than what it reported: the
  // node row carries the resolved model, and the event trail carries the tool
  // calls. `usedTokens` from the result is self-reported by the provider.
  const nodeId = result.nodeId;
  let model = '(unknown)';
  let provider = '(unknown)';
  let toolCalls = 0;
  if (nodeId) {
    const rows = await getDb().execute(sql`
      SELECT n.model,
             COALESCE(m.provider, '(unregistered)') AS provider,
             -- tool_call only: the same invocation also emits
             -- tool_call_complete and an untyped batch row, so counting
             -- every action row triples the figure.
             (SELECT COUNT(*) FROM agent_events e
               WHERE e.agent_id = n.id AND e.type = 'action'
                 AND e.data->>'type' IN ('tool_call', 'cli_tool_use'))::int AS tool_calls
        FROM swarm_nodes n
        LEFT JOIN model_config m ON m.model_id = n.model
       WHERE n.id = ${nodeId}
    `);
    const r = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows)[0] as
      | { model: string; provider: string; tool_calls: number }
      | undefined;
    if (r) {
      model = r.model;
      provider = r.provider;
      toolCalls = r.tool_calls;
    }
  }

  return {
    task: task.id,
    arm: arm === 'A' ? 'A (no plan)' : 'B (planned)',
    status: result.status,
    model,
    provider,
    tokens: result.usedTokens,
    toolCalls,
    durationMs: Date.now() - started,
    outputChars: typeof result.output === 'string' ? result.output.length : JSON.stringify(result.output ?? '').length,
    nodeId: nodeId || '(none)',
  };
}

const FREE = new Set(['ollama', 'cli']);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = arg('task');
  const armFilter = (arg('arm') ?? 'ab').toLowerCase();
  const tasks = only ? TASKS.filter((t) => t.id === only) : TASKS;
  if (tasks.length === 0) {
    console.error(`No such task '${only}'. Known: ${TASKS.map((t) => t.id).join(', ')}`);
    return 2;
  }

  // Always embedded: the only thing storage backs here is the settings cache,
  // and a one-shot experiment has nothing to share with the running backend.
  // Using external would make the harness need a live Valkey to measure a
  // model-routing question that has nothing to do with caching.
  initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeVault();
  await getSettingsService().initialize();
  await loadRuntimeConfig();
  await loadRolesFromDb();
  await loadTopicConfigs();
  await registerBuiltinTools();

  // Reuse an existing user+session so the spawn writes against real rows
  // (agents.user_id is a real owner; the swarm root is a real session).
  const owner = await getDb().execute(sql`SELECT id FROM users ORDER BY created_at LIMIT 1`);
  const userId = ((Array.isArray(owner) ? owner : (owner as { rows: unknown[] }).rows)[0] as { id: string })?.id;
  if (!userId) {
    console.error('No user row to run as — seed a user first.');
    return 2;
  }
  /** One fresh root session per arm — see the note in `runArm`. */
  const newSession = async (label: string): Promise<string> => {
    const id = randomUUID();
    await getDb().execute(sql`
      INSERT INTO sessions (id, user_id, channel_type, channel_id, title, created_at, updated_at)
      VALUES (${id}, ${userId}, 'api', 'executor-ab', ${`executor A/B — ${label}`}, now(), now())
    `);
    return id;
  };

  const results: ArmResult[] = [];
  try {
    for (const task of tasks) {
      for (const arm of ['A', 'B'] as const) {
        if (!armFilter.includes(arm.toLowerCase())) continue;
        if (arm === 'B' && task.controlOnly) continue;
        console.log(`\n▶ ${task.id} — arm ${arm}${arm === 'B' ? ' (planned)' : ''} …`);
        try {
          const r = await runArm(task, arm, await newSession(`${task.id}/${arm}`), userId);
          results.push(r);
          console.log(
            `  ${r.status} · ${r.model} (${r.provider}) · ${r.tokens} tok · ` +
              `${r.toolCalls} tool calls · ${(r.durationMs / 1000).toFixed(1)}s`,
          );
        } catch (err) {
          console.log(`  ERROR ${(err as Error).message}`);
        }
      }
    }

    console.log(`\n${'─'.repeat(78)}`);
    console.log('task            arm           model                 provider     tokens  tools   secs');
    for (const r of results) {
      console.log(
        `${r.task.padEnd(16)}${r.arm.padEnd(14)}${r.model.slice(0, 21).padEnd(22)}` +
          `${r.provider.slice(0, 12).padEnd(13)}${String(r.tokens).padStart(6)}` +
          `${String(r.toolCalls).padStart(7)}${(r.durationMs / 1000).toFixed(0).padStart(7)}`,
      );
    }

    // The verdict the brief asked for, in the only currency that matters:
    // tokens billed by a metered provider.
    const paid = (rs: ArmResult[]) =>
      rs.filter((r) => !FREE.has(r.provider)).reduce((a, r) => a + r.tokens, 0);
    // Only completed arms are comparable. A `cancelled` / `cache_hit` arm
    // returns someone else's node with 0 tokens, which reads as a free
    // executor — the most flattering possible lie about the split.
    const usable = results.filter((r) => r.status === 'ok');
    const dropped = results.length - usable.length;
    if (dropped > 0) {
      console.log(
        `\n${dropped} arm(s) did not complete (${results
          .filter((r) => r.status !== 'ok')
          .map((r) => `${r.task}/${r.arm}=${r.status}`)
          .join(', ')}) — excluded from the comparison, not counted as free.`,
      );
    }
    const a = usable.filter((r) => r.arm.startsWith('A'));
    const b = usable.filter((r) => r.arm.startsWith('B'));
    if (a.length > 0 && b.length > 0) {
      const pa = paid(a);
      const pb = paid(b);
      console.log(`\npaid tokens — control ${pa} · treatment ${pb}`);
      const delta = pa === 0 ? 0 : ((pa - pb) / pa) * 100;
      console.log(`saving: ${delta.toFixed(0)}% of paid tokens`);
      const trivial = b.filter((r) => r.toolCalls < 3);
      if (trivial.length > 0) {
        console.log(
          `WARNING — ${trivial.length}/${b.length} planned arms made < 3 tool calls: ` +
            `the plan did the work, the executor only transcribed it. ` +
            `A saving measured this way is the planner's cost moved, not removed.`,
        );
      }
      // The planner's own cost is NOT in these numbers: the harness wrote the
      // plan, so arm B is missing whatever a real parent would have spent
      // producing it. State it rather than let the number flatter the split.
      console.log(
        `NOTE — the harness supplied the plan, so arm B excludes the planner's ` +
          `authoring cost. Treat the saving as an upper bound.`,
      );
    }
    return 0;
  } finally {
    await getAgentManager().stopAll?.();
    await closeDb();
    await closeStorage();
  }
}

if (import.meta.main) {
  main()
    .then((c) => process.exit(c))
    .catch((err) => {
      console.error('A/B harness failed:', err);
      process.exit(2);
    });
}
