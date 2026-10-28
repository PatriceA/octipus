import type { AgentWorker, ToolHandler } from '@/core/agent-worker';
import { agentLogger } from '@/utils/logger';
import { getAgentManager } from '@/core/agent-manager';

/** Only the parent can choose which of its pending children needs new guidance. */
export function createSteerChildTool(workerRef: { current: AgentWorker | null }): ToolHandler {
  return {
    name: 'steer_child',
    description: 'Pipeline handles are not steerable workers: inspect get_pipeline_status; stop_pipeline before editing its active item with update_pipeline_items; preserve its full existing requirements, then resume_pipeline. Send focused guidance to one of your own running detached children. User steering is delivered to you, never automatically forwarded. Decide whether the child needs to change course or whether you can handle the change after collecting its result. This does not cancel or restart the child.',
    parameters: {
      type: 'object',
      properties: {
        childId: { type: 'string', description: 'Pending child handle returned by spawn_child.' },
        message: { type: 'string', description: 'The specific change this child should make.' },
      },
      required: ['childId', 'message'],
      additionalProperties: false,
    },
    execute: async args => {
      const parent = workerRef.current;
      const refuse = (reason: string) => {
        agentLogger.warn({ agentId: parent?.getContext().id, sessionId: parent?.getContext().sessionId, childId: args.childId, reason }, 'Child steering refused');
        return `steer_child: ${reason}`;
      };
      if (!parent || typeof args.childId !== 'string' || typeof args.message !== 'string' || !args.message.trim()) {
        return refuse('a pending childId and nonempty message are required.');
      }
      const pending = parent.listPendingDetached().find(child => child.childId === args.childId);
      if (!pending) {
        return refuse('this child is not pending under you. Collect its result and handle the change yourself or delegate a follow-up.');
      }
      if (pending.kind === 'pipeline') {
        return refuse('pipeline handles cannot be steered with this tool. Use get_pipeline_status to identify the current item. For an active item, stop_pipeline first, then update_pipeline_items using its full existing detail/acceptance plus the new guidance; preserve all requirements, then resume_pipeline. This call did not deliver guidance.');
      }
      // The handle is not the child's agent id; the spawner records that once
      // the child's worker exists.
      if (!pending.agentId) {
        return refuse('this child has not started running yet. Try again shortly, or handle the change after collecting its result.');
      }
      const child = getAgentManager().get(pending.agentId);
      const owner = parent.getContext();
      if (!child || child.getContext().userId !== owner.userId || child.getContext().sessionId !== owner.sessionId || child.getStatus() !== 'running') {
        return refuse('child is no longer running or unavailable. Collect its result and decide on a follow-up.');
      }
      child.steer({ role: 'user', content: args.message, timestamp: new Date() });
      return 'Guidance queued for the selected child. Delivery occurs at its next supported input boundary; this is not confirmation that it has applied the change.';
    },
  };
}
