import type { AgentWorker, ToolHandler } from '@/core/agent-worker';
import { getAgentManager } from '@/core/agent-manager';

/** Only the parent can choose which of its pending children needs new guidance. */
export function createSteerChildTool(workerRef: { current: AgentWorker | null }): ToolHandler {
  return {
    name: 'steer_child',
    description: 'Send focused guidance to one of your own running detached children. User steering is delivered to you, never automatically forwarded. Decide whether the child needs to change course or whether you can handle the change after collecting its result. This does not cancel or restart the child.',
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
      if (!parent || typeof args.childId !== 'string' || typeof args.message !== 'string' || !args.message.trim()) {
        return 'steer_child: a pending childId and nonempty message are required.';
      }
      if (!parent.listPendingDetached().some(child => child.childId === args.childId)) {
        return 'steer_child: this child is not pending under you. Collect its result and handle the change yourself or delegate a follow-up.';
      }
      const child = getAgentManager().get(args.childId);
      const owner = parent.getContext();
      if (!child || child.getContext().userId !== owner.userId || child.getContext().sessionId !== owner.sessionId || child.getStatus() !== 'running') {
        return 'steer_child: child is no longer running or unavailable. Collect its result and decide on a follow-up.';
      }
      child.steer({ role: 'user', content: args.message, timestamp: new Date() });
      return 'Guidance queued for the selected child. Delivery occurs at its next supported input boundary; this is not confirmation that it has applied the change.';
    },
  };
}
