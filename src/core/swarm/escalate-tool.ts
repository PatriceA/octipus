/**
 * `escalate_to_other_lane` — retry stuck work on a different MODEL.
 *
 * It used to pick a different expert row for the same role, which meant the
 * retry ran on the same model with a different persona: the one thing that
 * could not fix work that failed because the model was not up to it. What an
 * escalation actually wants is a different brain, and a lane is how this system
 * names one.
 *
 * Thin wrapper over `spawn_child` that:
 *  1. Sends the same subtopic to the lane the agent names.
 *  2. Refuses when that lane resolves to the model already running, because
 *     retrying identical work on an identical model is the definition of
 *     thrashing.
 *  3. Checks the `SwarmCallGraph` to enforce the one-escalation-per-Agent cap.
 *
 * Only registered on Agents (depth 1). The root does not escalate — it
 * re-plans via `spawn_child`. Subagent has no children to begin with.
 *
 * Trigger contract (Agent system prompt / runtime):
 *   Invoke only when fan-out exhausted AND every child returned `budget`
 *   or `timeout`. Capped at 1 call per Agent lifetime.
 */

import type { ToolHandler } from '@/core/agent-worker';
import { asLane } from '@/core/agent/lane-intent';
import { getModelRegistry } from '@/models/model-registry';
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
    name: 'escalate_to_other_lane',
    final: false,
    description:
      'Retry the current subtopic on a DIFFERENT model by sending it to another lane: '
      + '"build" for implementation strength, "verify" for an independent check, "everyday" for bulk work. '
      + 'Use this ONLY after fan-out is exhausted and every child you spawned returned `budget` or `timeout`. '
      + 'Refused when the lane you name runs the same model you do — that is a retry, not an escalation. '
      + 'Capped at 1 call per agent lifetime.',
    previewParam: 'subtopic',
    parameters: {
      type: 'object',
      properties: {
        // Same schema as spawn_child, minus `expertId` (picked automatically).
        role: {
          type: 'string',
          description: 'Specialist role for the retry. Defaults to the same role as the parent.',
        },
        topic: {
          type: 'string',
          description: 'The lane to retry on — "build", "verify", "everyday" or "research". Must not be the lane you are already running.',
        },
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
      },
      required: ['topic', 'subtopic', 'taskBrief', 'expectedOutput'],
    },
    execute: async (args, context) => {
      // Enforce the one-per-lifetime cap.
      const graph = getCallGraph(parent.rootSessionId);
      if (graph.hasEscalated(parent.id)) {
        return (
          'escalate_to_other_lane: already used once for this agent. ' +
          'Escalation is capped at 1/lifetime. Synthesize with what you have.'
        );
      }

      // The role defaults to the parent's, as the schema promises. It used to
      // fall out of `topic` — which worked only while `topic` held a role name
      // like "security". `topic` is the LANE now, and a lane is not a role.
      const validated = validateSpawnChildArgs({ role: parent.role, ...args });
      if ('error' in validated) {
        return `escalate_to_other_lane: ${validated.error}`;
      }

      // The point of escalating is a different model. A lane that resolves to
      // the one already running makes this a retry of identical work by an
      // identical model, which is the thrashing the lifetime cap exists to stop
      // — so it is refused BEFORE the cap is spent on it.
      const lane = asLane(validated.params.topic);
      if (!lane) {
        return 'escalate_to_other_lane: `topic` must name a lane — build, verify, everyday or research.';
      }
      // A registry that cannot answer must not veto an escalation: the check
      // exists to stop a pointless retry, not to add a way for the retry to fail.
      let laneModel: { modelId: string } | null = null;
      try {
        laneModel = await getModelRegistry().getModelForTopic(lane);
      } catch (err) {
        coreLogger.warn({ err, lane }, 'Lane lookup failed during escalation — allowing the spawn');
      }
      if (laneModel && laneModel.modelId === parent.model) {
        return `escalate_to_other_lane: the "${lane}" lane runs ${parent.model}, which is what you are running. `
          + 'Escalation means a different model; name another lane or synthesize with what you have.';
      }

      // Reserve the escalation slot up front to block concurrent escalations
      // from the same parent in the same turn. If the spawn fails we *don't*
      // release the slot — the design doc is explicit: "Capped 1/Agent lifetime.
      // Blocks thrashing." A failed escalation still counts.
      const reserved = graph.markEscalated(parent.id);
      if (!reserved) {
        return (
          'escalate_to_other_lane: already used once for this agent. ' +
          'Escalation is capped at 1/lifetime. Synthesize with what you have.'
        );
      }

      const params: SpawnChildParams = { ...validated.params };

      try {
        coreLogger.info(
          { parentNodeId: parent.id, topic: params.topic, subtopic: params.subtopic },
          'Escalating to another lane',
        );
        const result = await spawner.spawnChild(parent, params, context, { reason: 'escalation' });
        return formatChildResult(result);
      } catch (err) {
        coreLogger.error(
          { err, parentNodeId: parent.id },
          'escalate_to_other_lane threw',
        );
        return `escalate_to_other_lane failed: ${(err as Error).message}`;
      }
    },
  };
}
