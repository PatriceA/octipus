import type { ToolHandler } from '@/core/agent-base';
import type { AgentService } from '@/core/agent/service';
import { routeApprovalFor } from '@/security/approval-route';
import { getFlowLabel } from '@/security/flow-guard';
import { requireCan } from '@/security/space-access';

/**
 * `remember_for_space` (docs/plans/coworking-spec.md §6.5): the agent
 * records a fact in the space memory for its requester, who must have
 * `write` in the space (re-read at the call, D5).
 *
 * A meta-tool skips the executor's permission step, so the call is routed
 * here through `routeApprovalFor` as a write into the space
 * (`space_memory.write`): the role cap applies, and so does I6 — after a
 * private read the requester is asked, whatever the flow-guard mode. When
 * the session has read outsiders' text (`suspicious`, which a room always
 * is) the requester is asked too: a fact injected into every later turn of
 * the space must not be planted by someone else's message.
 */
export function createRememberForSpaceTool(service: AgentService): ToolHandler {
  return {
    name: 'remember_for_space',
    description:
      'Record one durable fact in this shared space\'s memory, which every member\'s sessions in the space receive. '
      + 'Use only for facts the space\'s members will need again (a decision, a convention, a key date) — never for '
      + 'personal details. One short sentence, at most 500 characters. The member may be asked to confirm.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The fact, one short sentence (max 500 characters).' },
      },
      required: ['body'],
    },
    replaySafety: 'mutation',
    execute: async (args, context) => {
      const space = context.space;
      if (!space) return { stored: false, error: 'remember_for_space works only in a shared space' };
      const body = String(args.body ?? '').trim();
      if (!body || body.length > 500) return { stored: false, error: 'The fact must be 1–500 characters' };
      // The role first (read now): a member who may not write is not asked.
      const { getMembership } = await import('./service');
      requireCan(await getMembership(context.userId, space.workspaceId), 'write');
      const decision = await routeApprovalFor(
        context,
        { toolId: 'space_memory', action: 'write', toolName: 'remember_for_space' },
        getFlowLabel(context.sessionId).suspicious
          ? { level: 'ASK', reason: 'the session has read other people\'s text', source: 'space-memory' }
          : { level: 'ALLOW' },
      );
      if (decision.route === 'deny' || decision.route === 'blocked') {
        return { stored: false, error: decision.reason ?? 'Adding to the space memory is not allowed here' };
      }
      if (decision.route === 'ask_human') {
        const answer = await service.requestApproval(
          'Octipus wants to add a fact to the space memory, which every member\'s sessions in this space will receive.'
            + (decision.source === 'space-flow' ? ` ${decision.reason}.` : ''),
          `Add this to the space memory?\n\n"${body}"`,
          context,
          ['Yes', 'No'],
        ) as { approved?: boolean } | undefined;
        if (answer?.approved !== true) return { stored: false, reason: 'The member did not approve adding this to the space memory.' };
      }
      const { rememberForSpace } = await import('./memory');
      const entry = await rememberForSpace(context.userId, space.workspaceId, body, context.sessionId);
      return { stored: true, id: entry.id };
    },
  };
}
