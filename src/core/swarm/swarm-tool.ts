import { randomUUID } from 'crypto';
import type { ToolHandler } from '@/core/agent-worker';
import { classifyMessage } from '@/core/orchestrator/classifier';
import type { AgentRole } from '@/core/orchestrator/types';
import { coreLogger } from '@/utils/logger';
import { parseScorers } from './scorers';
import { getSwarmSpawner, type SwarmSpawner } from './spawner';
import type { AgentNode, ChildResult, PendingChild, SpawnChildParams } from './types';

/**
 * Hooks passed in by the worker that owns this tool so spawn_child can
 * register pending children, enforce the cap, and let `collect_children`
 * pick up results later. spawn_child always detaches when these hooks are
 * present and the depth has a detach budget; if omitted (or the budget is 0),
 * it falls back to a blocking await — safe default for legacy call-sites and
 * leaf depths that can't detach.
 */
export interface SpawnChildHooks {
  /** Called when a detach-mode spawn is accepted. */
  registerPending: (pc: PendingChild) => void;
  /** Current count of not-yet-collected detached children on this parent. */
  pendingCount: () => number;
  /** Cap from config (typically `swarm.levelDefaults.agent.maxPendingDetached`). */
  maxPendingDetached: () => number;
}

const CHILD_ROLES_ENUM: AgentRole[] = [
  'research',
  'coding',
  'review',
  'qa',
  'communication',
  'design',
  'devops',
  'security',
  'data',
  'ai',
  'finance',
  'automation',
  'pm',
  'writing',
  'general',
  'architecture',
];

/**
 * One-line capability blurb per spawnable role. Single source for the depth-1
 * "roles you can spawn" menu (see `buildSpawnRoleCatalog`) — a depth-1 agent's
 * system prompt is its own role prompt, which never lists the other roles, so
 * without this the `role` enum is just 16 bare names and cross-specialist
 * fan-out is undiscoverable. The `Record<AgentRole, string>` type forces a
 * blurb whenever a role is added to `AgentRole`.
 *
 * The orchestrator (depth-0) keeps its own role list in prompt.md /
 * prompt.lite.md — kept in sync manually with this map for now; a later change
 * could generate those from here.
 */
const CHILD_ROLE_BLURBS: Record<Exclude<AgentRole, 'orchestrator'>, string> = {
  research: 'web search, investigate, synthesize sources',
  coding: 'write / refactor / fix code, shell, git',
  review: 'read-only code review / audit',
  qa: 'run tests, UI testing',
  communication: 'email, calendar, contacts, messaging',
  design: 'UI/UX, layout, accessibility',
  devops: 'CI/CD, docker, infra',
  security: 'security review, vuln scan',
  data: 'databases, ETL, dashboards, charts',
  ai: 'ML/AI/RAG/prompt engineering',
  finance: 'markets, financial modelling',
  automation: 'scheduling, recurring tasks, reminders',
  pm: 'planning, status, milestones',
  writing: 'docs, README, guides',
  general: 'people/orgs, generic tasks, real-browser work',
  architecture: 'system design, specs',
};

/**
 * Render the spawnable-role menu for injection into a depth-1 agent's task
 * brief. One `- role — blurb` line per role, in enum order.
 */
export function buildSpawnRoleCatalog(): string {
  // CHILD_ROLES_ENUM never contains 'orchestrator', so the cast is safe.
  return CHILD_ROLES_ENUM.map(
    (r) => `- ${r} — ${CHILD_ROLE_BLURBS[r as Exclude<AgentRole, 'orchestrator'>]}`,
  ).join('\n');
}

/**
 * Static delegation guidance for a depth-1 agent (one that can `spawn_child`).
 * ~1.5 KB of policy + mechanics that is IDENTICAL for every such spawn — it
 * belongs in the child's (cacheable) system prompt, NOT re-sent in every
 * per-task brief (Phase 4). Only the spawnable-role catalog varies, and only
 * when roles change. Kept out of `composeChildMessage` so briefs stay compact.
 */
export function buildDelegationGuidance(): string {
  return (
    'DELEGATION POLICY: you can spawn your OWN subagents with `spawn_child` ' +
    '(pick a `role`, give a focused `taskBrief`). Decide with these rules:\n' +
    '1. First check: can you do it with your own tools? If yes, just ' +
    "do it — don't spawn.\n" +
    '2. SPAWN when you have 2+ INDEPENDENT units of non-trivial work to run ' +
    'in parallel (per-page research, per-file audit, per-endpoint probe), OR ' +
    "a sub-topic needs a DIFFERENT specialist's toolset.\n" +
    '3. Same-role fan-out is OK: e.g. you are a research agent → spawn three ' +
    'research subagents, one per source.\n' +
    "4. DON'T hand a single task to one same-role subagent — you ARE that " +
    'specialist; do it yourself.\n\n' +
    'Roles you can spawn (`role` — what it does):\n' +
    buildSpawnRoleCatalog() +
    '\n\nHOW SPAWNING WORKS: `spawn_child` returns IMMEDIATELY with a pending ' +
    'handle — the child always runs in the background (there is no `mode` ' +
    'parameter). So you can fire several siblings in one turn, keep working, ' +
    'and pick up results later. Use it for DATAPOINTS you collect at the end ' +
    '(scrape a page, probe an endpoint) — not for a DEPENDENCY you need before ' +
    'your next step (for that, spawn it and immediately `collect_children` ' +
    'before continuing).\n' +
    'Rules: (1) at most 3 subagents pending at any time; (2) call ' +
    '`collect_children` BEFORE your final answer, or the framework force-waits ' +
    'with a hard timeout and you may run out of budget for synthesis; ' +
    "(3) don't spawn trivial work (<30s) — just do it; (4) if you finalize " +
    'without collecting, your pending children are cancelled.'
  );
}

/**
 * Topic-name → role aliases. Orchestrator LLMs frequently pick natural
 * topic phrases ("database", "frontend", "machine-learning") that aren't
 * actual roles. Auto-mapping the obvious synonyms beats rejecting the
 * whole spawn and forcing a retry — the parent gets the work done in one
 * turn and saves a round-trip. Genuinely ambiguous topics still fall
 * through to the strict rejection so the LLM picks deliberately.
 */
const TOPIC_TO_ROLE_ALIAS: Record<string, AgentRole> = {
  // 'development' is always coding. The classifier now emits 'coding' directly,
  // but keep the alias as a safety net for orchestrator LLMs that still phrase
  // the topic the old way.
  development: 'coding',
  dev: 'coding',
  database: 'data',
  db: 'data',
  sql: 'data',
  analytics: 'data',
  etl: 'data',
  ml: 'ai',
  'machine-learning': 'ai',
  llm: 'ai',
  nlp: 'ai',
  frontend: 'coding',
  backend: 'coding',
  fullstack: 'coding',
  api: 'coding',
  ux: 'design',
  ui: 'design',
  infra: 'devops',
  infrastructure: 'devops',
  deployment: 'devops',
  ci: 'devops',
  cd: 'devops',
  testing: 'qa',
  test: 'qa',
  docs: 'writing',
  documentation: 'writing',
  copy: 'writing',
  auth: 'security',
  authentication: 'security',
  authorization: 'security',
  pentest: 'security',
  appsec: 'security',
  product: 'pm',
  project: 'pm',
  scheduling: 'automation',
  workflow: 'automation',
};

/** The set of valid specialist roles, exported for router/lite reuse. */
export const SPAWN_CHILD_ROLES: readonly AgentRole[] = CHILD_ROLES_ENUM;

/**
 * Advisory roles that read/plan/review but must NOT silently absorb hands-on
 * implementation work — their tool grants and prompts assume documents, not
 * code changes. When the orchestrator LLM picks one of these for a task the
 * classifier reads as coding, that's a misroute (see plan §1.8).
 */
const ADVISORY_ROLES: ReadonlySet<AgentRole> = new Set(['architecture', 'review', 'pm']);

/**
 * Classifier topics that mean "hands-on coding/ops". An advisory pick for one
 * of these is rewritten to `coding`.
 */
const CODING_TOPICS: ReadonlySet<string> = new Set(['coding', 'devops', 'automation']);

/**
 * Deterministic role-fit guard (Phase 2.6). Before spawning, validate the
 * LLM's role choice against the classifier's read of the task text: if an
 * advisory role was chosen but the task classifies coding-like, rewrite to
 * `coding`. A fixed mapping table beats prompt hints for small orchestrator
 * models. Returns `rewrittenFrom` when it changed the role so the caller logs.
 */
export function applyRoleFit(
  role: AgentRole,
  taskText: string,
): { role: AgentRole; rewrittenFrom?: AgentRole } {
  if (!ADVISORY_ROLES.has(role)) return { role };
  const topic = classifyMessage(taskText).topic;
  if (topic && CODING_TOPICS.has(topic)) {
    return { role: 'coding', rewrittenFrom: role };
  }
  return { role };
}

/**
 * Resolve a specialist role from an explicit role arg and/or a topic, using the
 * same ladder `spawn_child` validation uses:
 *   1. explicit `role` if it's a valid role
 *   2. `topic` itself if it happens to be a role
 *   3. `TOPIC_TO_ROLE_ALIAS` lookup on the role arg, then the topic
 * Returns undefined when nothing matches (caller decides how to handle).
 *
 * Shared by `validateSpawnChildArgs` and the router-mode turn so deterministic
 * routing and LLM-driven spawning never diverge.
 */
export function resolveRoleFromTopic(roleRaw: string | undefined, topic: string): AgentRole | undefined {
  if (roleRaw && CHILD_ROLES_ENUM.includes(roleRaw as AgentRole)) return roleRaw as AgentRole;
  if (CHILD_ROLES_ENUM.includes(topic as AgentRole)) return topic as AgentRole;
  if (roleRaw && TOPIC_TO_ROLE_ALIAS[roleRaw.toLowerCase()]) return TOPIC_TO_ROLE_ALIAS[roleRaw.toLowerCase()];
  if (TOPIC_TO_ROLE_ALIAS[topic.toLowerCase()]) return TOPIC_TO_ROLE_ALIAS[topic.toLowerCase()];
  return undefined;
}

/**
 * Factory: produce a `spawn_child` tool handler bound to a specific parent
 * node (usually the current Orchestrator). The returned handler is what the
 * parent agent's LLM will see + invoke.
 *
 * The handler validates parameters, calls `SwarmSpawner.spawnChild`, and
 * serializes the `ChildResult` into the tool-result string that will land
 * back into the parent's conversation context.
 */
export function createSpawnChildTool(
  parent: AgentNode,
  spawner: SwarmSpawner = getSwarmSpawner(),
  hooks?: SpawnChildHooks,
  opts?: { lite?: boolean },
): ToolHandler {
  // Detach-or-await execute, shared by the lite and full schemas so both
  // behave identically. Every spawn returns a pending handle immediately when
  // detach is possible (hooks wired + depth has a detach budget) so the parent
  // stays free to spawn siblings, narrate, or absorb a mid-run message; the
  // parent picks results up with `collect_children` (or the framework
  // auto-collects before the final answer). Falls back to a blocking await when
  // detach isn't possible: no hooks (legacy call-sites / CLI workers) or no
  // detach budget (depth-2 subagents: maxPendingDetached=0).
  const executeSpawn: ToolHandler['execute'] = async (args, context) => {
    const validated = validateSpawnChildArgs(args);
    if ('error' in validated) return `spawn_child: ${validated.error}`;
    const params = validated.params;

    const cap = hooks?.maxPendingDetached() ?? 0;
    if (hooks && cap > 0) {
      if (hooks.pendingCount() >= cap) {
        return `spawn_child: already at max pending detached (${cap}). Call collect_children to pick up results before spawning more.`;
      }
      params.mode = 'detach';
      const childHandle = randomUUID();
      const promise = (async () => {
        try {
          return await spawner.spawnChild(parent, params, context);
        } catch (err) {
          coreLogger.error(
            { err, parentNodeId: parent.id, topic: params.topic, subtopic: params.subtopic },
            'Detached spawn_child execution threw',
          );
          return {
            nodeId: childHandle,
            kind: 'subagent' as const,
            status: 'tool_error' as const,
            output: null,
            usedTokens: 0,
            durationMs: 0,
            spawnedChildren: [],
            notes: (err as Error).message || 'spawn failed',
          };
        }
      })();
      hooks.registerPending({
        childId: childHandle,
        startedAt: Date.now(),
        taskBrief: params.taskBrief,
        topic: params.topic,
        subtopic: params.subtopic,
        promise,
      });
      return `<ChildResult nodeId="${childHandle}" status="pending" mode="detach">\n<output>Subagent started in the background. Result is NOT yet available — call collect_children (or let the framework auto-collect before your final answer) to retrieve it.</output>\n</ChildResult>`;
    }

    // ── Await fallback (no detach budget / no hooks) ─────────────────
    try {
      params.mode = 'await';
      const result = await spawner.spawnChild(parent, params, context);
      return formatChildResult(result);
    } catch (err) {
      coreLogger.error(
        { err, parentNodeId: parent.id, topic: params.topic, subtopic: params.subtopic },
        'spawn_child execution threw',
      );
      return `spawn_child failed: ${(err as Error).message || 'spawn failed'}`;
    }
  };

  // Lite schema for small models: just `role` + `taskBrief`. topic/subtopic/
  // expectedOutput are synthesized by the validator. A flatter schema means
  // far fewer malformed tool calls from ≤14B models.
  if (opts?.lite) {
    return {
      name: 'spawn_child',
      final: false,
      description:
        'Delegate the task to a specialist agent. Pick the role that best fits and write a one- or two-sentence taskBrief. The child does the work and returns a result you relay to the user.',
      previewParam: 'taskBrief',
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: CHILD_ROLES_ENUM,
            description: 'Specialist role for the child.',
          },
          taskBrief: {
            type: 'string',
            maxLength: 4000,
            description: 'What the child should do.',
          },
        },
        required: ['role', 'taskBrief'],
      },
      execute: executeSpawn,
    };
  }

  return {
    name: 'spawn_child',
    // Not `final` — the parent is expected to synthesize after children
    // return. Multiple `spawn_child` calls per turn are allowed.
    final: false,
    description:
      'Delegate a sub-topic to a better-fit specialist agent. The child runs autonomously with a restricted tool set and budget. The call returns IMMEDIATELY with a pending handle — the child runs in the background so you can spawn more siblings, narrate to the user, or stay responsive. Call `collect_children` to pick up results (or the framework auto-collects before your final answer). Spawn multiple in one turn for parallel work.',
    previewParam: 'subtopic',
    parameters: {
      type: 'object',
      properties: {
        expertId: {
          type: 'string',
          description: 'Optional exact expert ID. Preferred when known; otherwise the spawner picks a system expert for the role.',
        },
        role: {
          type: 'string',
          enum: CHILD_ROLES_ENUM,
          description:
            'Specialist role for the child. Determines the available tool set (permission-intersected with yours).',
        },
        topic: {
          type: 'string',
          description: 'High-level topic area (e.g. "security", "research", "coding").',
        },
        subtopic: {
          type: 'string',
          description: 'Specific sub-topic focus (e.g. "oauth/pkce", "benchmark results").',
        },
        taskBrief: {
          type: 'string',
          maxLength: 4000,
          description: 'Focused task description for the child. ≤2000 tokens recommended.',
        },
        expectedOutput: {
          type: 'object',
          properties: {
            shape: {
              type: 'string',
              enum: ['summary', 'json', 'markdown', 'code-diff', 'list'],
              description: 'Strict output shape the child must return.',
            },
            schema: {
              type: 'object',
              description: 'Optional JSON schema for `shape=json`.',
            },
            maxTokens: {
              type: 'number',
              description: 'Upper bound on the deliverable size. Defaults to 2000.',
            },
          },
          required: ['shape'],
        },
        parallelGroup: {
          type: 'string',
          description: 'Same group in the same LLM turn = parent will Promise.all the calls.',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional hard constraints the child must respect (e.g. "read-only").',
        },
        scorers: {
          type: 'array',
          description:
            'Optional deterministic checks the child output MUST pass. Run after the child returns; any failure marks the result contract_failed so you can retry or correct. Kinds: {"kind":"non_empty"}, {"kind":"contains","value":"...","on":"output|notes"}, {"kind":"regex","pattern":"...","flags":"i","on":"output|notes"}, {"kind":"json","requiredKeys":["a","b"]}, {"kind":"file_exists","path":"report.md"}.',
          items: { type: 'object' },
        },
      },
      required: ['topic', 'subtopic', 'taskBrief', 'expectedOutput'],
    },
    execute: executeSpawn,
  };
}

// ── Exported helpers (unit-tested) ─────────────────────────────────────

export type ValidatedSpawn =
  | { params: SpawnChildParams }
  | { error: string };

export function validateSpawnChildArgs(args: Record<string, unknown>): ValidatedSpawn {
  let topic = typeof args.topic === 'string' ? args.topic.trim() : '';
  let subtopic = typeof args.subtopic === 'string' ? args.subtopic.trim() : '';
  const taskBrief = typeof args.taskBrief === 'string' ? args.taskBrief : '';

  // Resolve the specialist role FIRST. Resolution order (shared with router
  // mode via resolveRoleFromTopic):
  //   1. explicit `role` arg if valid
  //   2. `topic` itself if it's a role enum
  //   3. TOPIC_TO_ROLE_ALIAS synonym lookup ('database' → 'data', …)
  //   4. reject — silent defaulting to 'general' routes specialist work wrong.
  // In lite mode the LLM passes only `role` + `taskBrief`; topic/subtopic then
  // default from the role so the downstream topic-path invariants still hold.
  const roleRaw = typeof args.role === 'string' ? args.role : undefined;
  const role = resolveRoleFromTopic(roleRaw, topic);
  if (!role) {
    return {
      error:
        `missing or invalid 'role' (got '${roleRaw ?? 'undefined'}', topic '${topic}'). ` +
        `Must be one of: ${CHILD_ROLES_ENUM.join(', ')}. ` +
        `Pick the specialist role that fits the subtopic — don't fall back to 'general' unless the task is genuinely generic.`,
    };
  }
  if (!topic) topic = role;
  if (!subtopic) subtopic = topic;

  if (!taskBrief.trim()) return { error: 'missing required field `taskBrief`' };
  if (taskBrief.length > 4000) {
    return { error: 'taskBrief exceeds 4000-char limit' };
  }

  // Default expectedOutput when omitted or malformed. Nested required
  // object params get dropped across providers (observed on deepseek-chat,
  // also common on OpenAI/Anthropic), which otherwise bails the
  // orchestrator mid-delegation. Only reject an *explicit* invalid shape
  // so the LLM learns when it picks a bogus value on purpose.
  const eoRaw = args.expectedOutput;
  const eo = (eoRaw && typeof eoRaw === 'object' ? eoRaw : {}) as Record<string, unknown>;
  const shapeRaw = eo.shape;
  const validShapes = ['summary', 'json', 'markdown', 'code-diff', 'list'] as const;
  let shape: (typeof validShapes)[number];
  if (shapeRaw === undefined) {
    shape = 'summary';
  } else if (typeof shapeRaw === 'string' && (validShapes as readonly string[]).includes(shapeRaw)) {
    shape = shapeRaw as (typeof validShapes)[number];
  } else {
    return { error: 'expectedOutput.shape must be one of summary|json|markdown|code-diff|list' };
  }
  const maxTokens = eo.maxTokens;
  const maxTokensNum =
    typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2000;

  // Scorers are opt-in deterministic gates. A malformed spec is rejected loud
  // (not silently dropped) so the parent LLM learns to fix it.
  const parsedScorers = parseScorers(args.scorers);
  if ('error' in parsedScorers) {
    return { error: `invalid scorers: ${parsedScorers.error}` };
  }

  // `mode` is no longer LLM-controlled — spawn_child always detaches when the
  // depth has a detach budget, else awaits. The execute path sets params.mode
  // to reflect what actually happened (for spawn_node bookkeeping).
  const params: SpawnChildParams = {
    expertId: typeof args.expertId === 'string' ? args.expertId : undefined,
    role,
    topic,
    subtopic,
    taskBrief,
    expectedOutput: {
      shape: shape as SpawnChildParams['expectedOutput']['shape'],
      schema: eo.schema as Record<string, unknown> | undefined,
      maxTokens: maxTokensNum,
    },
    parallelGroup: typeof args.parallelGroup === 'string' ? args.parallelGroup : undefined,
    constraints: Array.isArray(args.constraints)
      ? (args.constraints.filter((c) => typeof c === 'string') as string[])
      : undefined,
    scorers: parsedScorers.scorers.length > 0 ? parsedScorers.scorers : undefined,
  };

  return { params };
}

/**
 * Marshal a `ChildResult` into a tool-result string the parent LLM can
 * digest. Uses the `<ChildResult .../>` envelope described in the design
 * doc so the parent learns status + metadata, not just the raw output.
 */
export function formatChildResult(result: ChildResult): string {
  const outStr =
    typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output);
  const meta =
    `nodeId="${result.nodeId}" status="${result.status}" ` +
    `tokens="${result.usedTokens}" durationMs="${result.durationMs}"`;
  const notes = result.notes ? `\n<notes>${result.notes}</notes>` : '';
  // Surface failed scorer gates explicitly so the parent can't overlook a
  // contract miss buried in the output.
  const scorerFail =
    result.scorerOutcome && !result.scorerOutcome.passed
      ? `\n<scorers passed="false">${result.scorerOutcome.failures
          .map((f) => `${f.scorer}: ${f.reason}`)
          .join('; ')}</scorers>`
      : '';
  return `<ChildResult ${meta}>${formatReceiptBlock(result.receipt)}\n<output>${outStr}</output>${notes}${scorerFail}\n</ChildResult>`;
}

/**
 * Render the deterministic swarm receipt into the envelope so the parent LLM
 * audits the child against ground truth (real tool-execution counters) instead
 * of the child's self-narration — "claims success but wrote no files / had
 * denied calls" is detectable without re-reading the transcript. Empty when no
 * receipt (e.g. a node with no worker run).
 */
function formatReceiptBlock(receipt: ChildResult['receipt']): string {
  if (!receipt) return '';
  const s = receipt.sideEffects;
  const attrs =
    `toolCalls="${s.toolCalls}" filesChanged="${s.filesChanged}" ` +
    `commandsRun="${s.commandsRun}" toolErrors="${s.toolErrors}" ` +
    `denials="${s.permissionDenials}"`;
  // Fail loud: if the framework couldn't capture side effects, say so rather
  // than let zeros read as "did nothing".
  const unavailable = receipt.unavailable.length
    ? ` unavailable="${receipt.unavailable.join('; ')}"`
    : '';
  return `\n<receipt ${attrs}${unavailable}/>`;
}
