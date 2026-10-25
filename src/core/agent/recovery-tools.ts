import type { ToolHandler } from '@/core/agent-base';
import { toolActionRepository } from '@/db/repositories/tool-action-repository';
import { actionRecovery } from '@/core/action-recovery';

/** Inspection acknowledges a specific known outcome; it never authorizes repeating an action. */
export function createActionRecoveryTools(): ToolHandler[] {
  return [{ name: 'inspect_uncertain_actions', discoverOnly: true, permissionAction: 'read', replaySafety: 'read_only',
    description: 'Read uncertain tool action records in this session before checking their actual external state.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => toolActionRepository.pending(context.userId, context.sessionId),
  }, { name: 'resolve_tool_action', discoverOnly: true,
    description: 'After inspecting actual files, status or external state, record the known outcome of one uncertain action. Requires concrete inspection evidence. This does not grant permission to repeat it.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, outcome: { type: 'string', enum: ['effect_confirmed', 'no_effect_confirmed'] },
      evidence: { type: 'string', description: 'Concrete observed state and the read-only check used to establish it.' } }, required: ['id', 'outcome', 'evidence'] },
    execute: async (args, context) => {
      if (typeof args.id !== 'string' || !['effect_confirmed', 'no_effect_confirmed'].includes(String(args.outcome))
        || typeof args.evidence !== 'string' || args.evidence.trim().length < 20) throw new Error('A record id, known outcome and concrete inspection evidence (at least 20 characters) are required');
      const row = (await toolActionRepository.pending(context.userId, context.sessionId)).find(row => row.id === args.id);
      if (!row || actionRecovery.isActive(row.id)) throw new Error('Uncertain action not found, or the original action is still executing');
      await toolActionRepository.acknowledge(context.userId, context.sessionId, [row.id],
        JSON.stringify({ kind: 'inspection', agentId: context.id, outcome: args.outcome, evidence: args.evidence.slice(0, 4000), at: new Date().toISOString() }));
      return { id: row.id, resolved: true, outcome: args.outcome, evidence: args.evidence };
    },
  }];
}
