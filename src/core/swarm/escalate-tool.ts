/**
 * Swarm Phase 2 — `escalate_to_different_expert` tool factory.
 *
 * Thin wrapper over `spawn_child` that:
 *  1. Selects a *different* `expertId` for the same role.
 *  2. Checks the `SwarmCallGraph` to enforce the one-escalation-per-Agent cap.
 *  3. Delegates to `SwarmSpawner.spawnChild` using the existing parent node.
 *
 * Only registered on Agents (depth 1). Orchestrator does not escalate — it
 * re-plans via `spawn_child`. Subagent has no children to begin with.
 *
 * Trigger contract (Agent system prompt / runtime):
 *   Invoke only when fan-out exhausted AND every child returned `budget`
 *   or `timeout`. Capped at 1 call per Agent lifetime.
 */

import type { ToolHandler } from '@/core/agent-worker';
import { coreLogger } from '@/utils/logger';
import { getCallGraph } from './call-graph';
import { getSwarmSpawner, type SwarmSpawner } from './spawner';
import { formatChildResult, validateSpawnChildArgs } from './swarm-tool';
import type { AgentNode, SpawnChildParams } from './types';

export function createEscalateTool(
  parent: AgentNode,
  spawner: SwarmSpawner = getSwarmSpawner(),
): ToolHandler {
  return {
    name: 'escalate_to_different_expert',
    final: false,
    description:
      'Escalate the current subtopic to a *different* expert with the same role. ' +
      'Use this ONLY after fan-out is exhausted and every child you spawned returned `budget` or `timeout`. ' +
      'Capped at 1 call per agent lifetime. Acts like `spawn_child` but picks a fresh expert.',
    previewParam: 'subtopic',
    parameters: {
      type: 'object',
      properties: {
        // Same schema as spawn_child, minus `expertId` (picked automatically).
        role: {
          type: 'string',
          description: 'Specialist role for the replacement expert. Defaults to the same role as the parent.',
        },
        topic: { type: 'string' },
        subtopic: { type: 'string' },
        taskBrief: { type: 'string', maxLength: 4000 },
        expectedOutput: {
          type: 'object',
          properties: {
            shape: { type: 'string', enum: ['summary', 'json', 'markdown', 'code-diff', 'list'] },
            schema: { type: 'object' },
            maxTokens: { type: 'number' },
          },
          required: ['shape'],
        },
        constraints: { type: 'array', items: { type: 'string' } },
        previousExpertId: {
          type: 'string',
          description: 'Optional exclusion — the expert that failed. The spawner will not pick it again.',
        },
      },
      required: ['topic', 'subtopic', 'taskBrief', 'expectedOutput'],
    },
    execute: async (args, context) => {
      // Enforce the one-per-lifetime cap.
      const graph = getCallGraph(parent.rootSessionId);
      if (graph.hasEscalated(parent.id)) {
        return (
          'escalate_to_different_expert: already used once for this agent. ' +
          'Escalation is capped at 1/lifetime. Synthesize with what you have.'
        );
      }

      const validated = validateSpawnChildArgs(args);
      if ('error' in validated) {
        return `escalate_to_different_expert: ${validated.error}`;
      }

      // Reserve the escalation slot up front to block concurrent escalations
      // from the same parent in the same turn. If the spawn fails we *don't*
      // release the slot — the design doc is explicit: "Capped 1/Agent lifetime.
      // Blocks thrashing." A failed escalation still counts.
      const reserved = graph.markEscalated(parent.id);
      if (!reserved) {
        return (
          'escalate_to_different_expert: already used once for this agent. ' +
          'Escalation is capped at 1/lifetime. Synthesize with what you have.'
        );
      }

      const params: SpawnChildParams = {
        ...validated.params,
        // Force a different expert: exclude the previously-used one.
        expertId: undefined,
      };

      try {
        coreLogger.info(
          { parentNodeId: parent.id, topic: params.topic, subtopic: params.subtopic },
          'Escalating to different expert',
        );
        const result = await spawner.spawnChild(parent, params, context, {
          excludeExpertId: (args.previousExpertId as string | undefined) || parent.expertId,
          reason: 'escalation',
        });
        return formatChildResult(result);
      } catch (err) {
        coreLogger.error(
          { err, parentNodeId: parent.id },
          'escalate_to_different_expert threw',
        );
        return `escalate_to_different_expert failed: ${(err as Error).message}`;
      }
    },
  };
}
