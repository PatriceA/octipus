import type { ToolHandler } from '@/core/agent-worker';
import type { AgentRole } from '@/core/orchestrator/types';
import { coreLogger } from '@/utils/logger';
import { getSwarmSpawner, type SwarmSpawner } from './spawner';
import type { AgentNode, ChildResult, SpawnChildParams } from './types';

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
): ToolHandler {
  return {
    name: 'spawn_child',
    // Not `final` — the parent is expected to synthesize after children
    // return. Multiple `spawn_child` calls per turn are allowed.
    final: false,
    description:
      'Delegate a sub-topic to a better-fit specialist agent. The child runs autonomously with a restricted tool set and budget, then returns a structured result you must synthesize. Prefer a single `spawn_child` for simple tasks; use multiple calls (same parallelGroup) for truly independent sub-topics.',
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
      },
      required: ['topic', 'subtopic', 'taskBrief', 'expectedOutput'],
    },
    execute: async (args, context) => {
      const validated = validateSpawnChildArgs(args);
      if ('error' in validated) {
        return `spawn_child: ${validated.error}`;
      }
      const params = validated.params;
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
  const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
  const subtopic = typeof args.subtopic === 'string' ? args.subtopic.trim() : '';
  const taskBrief = typeof args.taskBrief === 'string' ? args.taskBrief : '';
  if (!topic) return { error: 'missing required field `topic`' };
  if (!subtopic) return { error: 'missing required field `subtopic`' };
  if (!taskBrief.trim()) return { error: 'missing required field `taskBrief`' };
  if (taskBrief.length > 4000) {
    return { error: 'taskBrief exceeds 4000-char limit' };
  }

  const eo = args.expectedOutput;
  if (!eo || typeof eo !== 'object') {
    return { error: 'missing required field `expectedOutput`' };
  }
  const shape = (eo as Record<string, unknown>).shape;
  if (typeof shape !== 'string' || !['summary', 'json', 'markdown', 'code-diff', 'list'].includes(shape)) {
    return { error: 'expectedOutput.shape must be one of summary|json|markdown|code-diff|list' };
  }
  const maxTokens = (eo as Record<string, unknown>).maxTokens;
  const maxTokensNum =
    typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2000;

  // Role is required to route the child to the right model. If the LLM
  // omits `role` but `topic` happens to be a valid role enum, reuse topic
  // as the role — this matches the common case where the LLM thinks of
  // topic/role as the same concept. Otherwise reject: silent defaulting
  // to 'general' routes specialist work to the wrong model.
  const roleRaw = typeof args.role === 'string' ? args.role : undefined;
  let role: AgentRole | undefined;
  if (roleRaw && CHILD_ROLES_ENUM.includes(roleRaw as AgentRole)) {
    role = roleRaw as AgentRole;
  } else if (CHILD_ROLES_ENUM.includes(topic as AgentRole)) {
    role = topic as AgentRole;
  } else {
    return {
      error:
        `missing or invalid 'role' (got '${roleRaw ?? 'undefined'}', topic '${topic}'). ` +
        `Must be one of: ${CHILD_ROLES_ENUM.join(', ')}. ` +
        `Pick the specialist role that fits the subtopic — don't fall back to 'general' unless the task is genuinely generic.`,
    };
  }

  const params: SpawnChildParams = {
    expertId: typeof args.expertId === 'string' ? args.expertId : undefined,
    role,
    topic,
    subtopic,
    taskBrief,
    expectedOutput: {
      shape: shape as SpawnChildParams['expectedOutput']['shape'],
      schema: (eo as Record<string, unknown>).schema as Record<string, unknown> | undefined,
      maxTokens: maxTokensNum,
    },
    parallelGroup: typeof args.parallelGroup === 'string' ? args.parallelGroup : undefined,
    constraints: Array.isArray(args.constraints)
      ? (args.constraints.filter((c) => typeof c === 'string') as string[])
      : undefined,
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
