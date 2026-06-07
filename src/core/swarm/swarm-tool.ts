import { randomUUID } from 'crypto';
import type { ToolHandler } from '@/core/agent-worker';
import type { AgentRole } from '@/core/orchestrator/types';
import { coreLogger } from '@/utils/logger';
import { getSwarmSpawner, type SwarmSpawner } from './spawner';
import type { AgentNode, ChildResult, PendingChild, SpawnChildParams } from './types';

/**
 * Hooks passed in by the worker that owns this tool so detach-mode can
 * register pending children, enforce the cap, and let `collect_children`
 * pick up results later. If omitted, the tool treats every call as
 * `mode: 'await'` regardless of what the LLM passes in — safe default
 * for older call-sites that haven't wired the worker in.
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
      execute: async (args, context) => {
        const validated = validateSpawnChildArgs(args);
        if ('error' in validated) return `spawn_child: ${validated.error}`;
        try {
          const result = await spawner.spawnChild(parent, validated.params, context);
          return formatChildResult(result);
        } catch (err) {
          coreLogger.error({ err, parentNodeId: parent.id }, 'lite spawn_child execution threw');
          return `spawn_child failed: ${(err as Error).message || 'spawn failed'}`;
        }
      },
    };
  }

  return {
    name: 'spawn_child',
    // Not `final` — the parent is expected to synthesize after children
    // return. Multiple `spawn_child` calls per turn are allowed.
    final: false,
    description:
      'Delegate a sub-topic to a better-fit specialist agent. The child runs autonomously with a restricted tool set and budget, then returns a structured result you must synthesize. Default mode="await" blocks until the child returns; mode="detach" returns immediately so you can keep working, narrate to the user, or spawn more siblings — you must later call `collect_children` (or the framework auto-collects before your final answer). Detach when the child output is a datapoint, not a dependency, or when you want to run multiple siblings in parallel without blocking on each one.',
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
        mode: {
          type: 'string',
          enum: ['await', 'detach'],
          description:
            "'await' (default): block until the child returns, synthesize inline. " +
            "'detach': return { nodeId, status: 'pending' } immediately and keep working — available at every depth that has a detach budget (orchestrator can detach agents; agents can detach subagents). " +
            'Call `collect_children` before your final answer, or the framework force-awaits.',
        },
      },
      required: ['topic', 'subtopic', 'taskBrief', 'expectedOutput'],
    },
    execute: async (args, context) => {
      const validated = validateSpawnChildArgs(args);
      if ('error' in validated) {
        return `spawn_child: ${validated.error}`;
      }
      const params = validated.params;
      const mode: 'await' | 'detach' = params.mode ?? 'await';

      // ── Detach path ─────────────────────────────────────────────────
      // Available at any depth whose level config provides a detach
      // budget (orchestrator → agent and agent → subagent today). Depth 2
      // has maxPendingDetached=0 and so will be rejected by the cap check
      // below — no need for a separate depth guard. Hooks carry the
      // pending map + cap — if not wired, downgrade to await so old
      // call-sites don't silently drop children.
      if (mode === 'detach') {
        if (!hooks) {
          coreLogger.warn({ parentNodeId: parent.id }, 'spawn_child detach requested but worker did not wire hooks — falling back to await');
        } else {
          const cap = hooks.maxPendingDetached();
          if (cap <= 0) {
            return `spawn_child: detach-mode disabled (maxPendingDetached=${cap}). Re-call with mode='await'.`;
          }
          if (hooks.pendingCount() >= cap) {
            return `spawn_child: already at max pending detached (${cap}). Call collect_children to pick up results before spawning more.`;
          }
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
          return `<ChildResult nodeId="${childHandle}" status="pending" mode="detach">\n<output>Detached subagent started. Result is NOT yet available — call collect_children (or let the framework auto-collect before your final answer) to retrieve it.</output>\n</ChildResult>`;
        }
      }

      // ── Await path (default) ────────────────────────────────────────
      try {
        const result = await spawner.spawnChild(parent, params, context);
        return formatChildResult(result);
      } catch (err) {
        coreLogger.error(
          { err, parentNodeId: parent.id, topic: params.topic, subtopic: params.subtopic },
          'spawn_child execution threw',
        );
        const msg = (err as Error).message || 'spawn failed';
        return `spawn_child failed: ${msg}`;
      }
    },
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

  const modeRaw = typeof args.mode === 'string' ? args.mode : undefined;
  const mode: 'await' | 'detach' | undefined =
    modeRaw === 'detach' ? 'detach' : modeRaw === 'await' ? 'await' : undefined;

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
    mode,
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
  return `<ChildResult ${meta}>\n<output>${outStr}</output>${notes}\n</ChildResult>`;
}
