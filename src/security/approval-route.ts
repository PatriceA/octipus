/**
 * One decision function for every tool call (docs/plans/coworking-spec.md
 * §5.6; I4, I6, D5).
 *
 * `routeApprovalFor(context, call, permission)` replaces the bare
 * `routeApproval` at all six dispatch paths (tool executor, base tool, CLI
 * permission relay, MCP transport, scorer gate, action recovery). For a
 * space context it:
 *
 *   1. re-reads the requester's membership and the space's archive state
 *      from the database — removal, downgrade and archive bite at the next
 *      tool decision;
 *   2. applies the role cap BEFORE anything else, because `routeApproval`
 *      executes any non-ASK level straight away: a commenter (or guest) runs
 *      only `COMMENTER_TOOLS`, nobody runs a personal-only tool;
 *   3. applies the I6 rule: once the session has read the requester's
 *      private data (flow label `private`), any call that is not a read is
 *      ASK — whatever the flow-guard mode — because it writes personal data
 *      into the space; and in a room (a shared audience, D8) a call that
 *      reads the requester's private data is ASK to the requester, because
 *      the answer is posted where every member of the room reads it;
 *   4. calls the pure `routeApproval`.
 *
 * A lint test (`approval-route.test.ts`) fails on `routeApproval(` in any
 * other source file.
 */
import type { AgentSpace, PermissionLevel } from '@/core/types';
import { type ApprovalDecision, routeApproval } from './approval-policy';
import { classifyFlow, getFlowLabel, isSharedAudience } from './flow-guard';
import { can } from './space-access';
import { commenterMayRun, isReadCall, personalOnlyReason, type SpaceToolCall } from './space-tools';
import { isKnownSharedWorkspace } from './workspace-fs';

/** The agent making the call (an `AgentContext`, or the scorer's view of one). */
export interface ApprovalCaller {
  userId: string;
  sessionId?: string;
  role?: string;
  root?: boolean;
  attended?: boolean;
  workspaceId?: string | null;
  space?: AgentSpace | null;
}

export interface ApprovalPermission {
  level: PermissionLevel;
  reason?: string;
  source?: string;
}

export interface RoutedApproval extends ApprovalDecision {
  /** The level the decision was taken on (I6 may have raised ALLOW to ASK). */
  level: PermissionLevel;
  /** Where the level came from (`space-role`, `space-flow`, or the permission's own source). */
  source?: string;
}

function deny(reason: string): RoutedApproval {
  return { route: 'deny', level: 'DENY', reason, source: 'space-role' };
}

export async function routeApprovalFor(
  context: ApprovalCaller,
  call: SpaceToolCall,
  permission: ApprovalPermission,
  options: { unattendedDenyActions?: string[] } = {},
): Promise<RoutedApproval> {
  let level = permission.level;
  let reason = permission.reason;
  let source = permission.source;
  const space = context.space ?? null;
  // Fail closed: an agent in a space workspace that carries no space scope
  // was built outside `buildAgentContext`.
  if (!space && isKnownSharedWorkspace(context.workspaceId)) {
    return deny('this agent has no space scope, so nothing may run in the space');
  }
  if (space) {
    const { getMembership, isSpaceArchived } = await import('@/core/spaces/service');
    const membership = await getMembership(context.userId, space.workspaceId);
    if (!membership) return deny('you are no longer a member of this space');
    if (await isSpaceArchived(space.workspaceId)) return deny('this space is archived');
    if (!can(membership.role, 'run_agent')) return deny(`your role (${membership.role}) cannot run the agent in this space`);
    if (!can(membership.role, 'run_agent_write') && !commenterMayRun(call)) {
      return deny(`your role (${membership.role}) can only read and comment in this space; ${call.toolId}.${call.toolName ?? call.action} is not allowed`);
    }
    const personal = personalOnlyReason(call);
    if (personal) return deny(personal);
    if (level !== 'DENY' && isSharedAudience(context.sessionId) && classifyFlow({ toolId: call.toolId, action: call.action }).taints.includes('private')) {
      level = 'ASK';
      source = 'space-room';
      reason = `${call.toolId}.${call.toolName ?? call.action} reads your private data, and the answer is posted in this room `
        + 'where every member reads it: approving shares it with them';
    }
    if (level !== 'DENY' && !isReadCall(call) && getFlowLabel(context.sessionId).private) {
      const { getSpace } = await import('@/core/spaces/service');
      const { name } = await getSpace({ userId: context.userId }, space.workspaceId);
      level = 'ASK';
      source = 'space-flow';
      reason = `${call.toolId}.${call.toolName ?? call.action} writes data from your personal sources `
        + `(${getFlowLabel(context.sessionId).sources.private}) into ${name}`;
    }
  }
  const decision = routeApproval({
    level,
    role: context.role,
    root: context.root,
    attended: context.attended,
    toolId: call.toolId,
    action: call.action,
    unattendedDenyActions: options.unattendedDenyActions,
  });
  return { ...decision, level, reason: reason ?? decision.reason, source };
}
