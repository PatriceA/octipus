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
 *      tool decision — and, in a room, `roomAccess` (a private room's
 *      member removed while still in the space);
 *   2. applies the role cap BEFORE anything else, because `routeApproval`
 *      executes any non-ASK level straight away: a commenter (or guest) runs
 *      only `COMMENTER_TOOLS`, a `listen` turn only reads, nobody runs a
 *      personal-only tool or writes a coding agent's configuration
 *      (`.claude/`, …) in the space;
 *   3. applies the I6 rule: once the session has read the requester's
 *      private data (flow label `private`, loaded from the session row so a
 *      restart keeps it), any call that is not a read is ASK — whatever the
 *      flow-guard mode — because it writes personal data into the space;
 *      and in a room (a shared audience, D8) a call that reads the
 *      requester's private data is ASK to the requester, because the answer
 *      is posted where every member of the room reads it;
 *   4. calls the pure `routeApproval`;
 *   5. marks the session `private` when the call goes ahead and reads
 *      through one of the requester's personal connections
 *      (`personalSourceRead`) — before it runs, so a failed read still
 *      counts: the guard asks more, never less.
 *
 * A lint test (`approval-route.test.ts`) fails on `routeApproval(` in any
 * other source file.
 */
import type { AgentSpace, AgentTrigger, PermissionLevel } from '@/core/types';
import { type ApprovalDecision, routeApproval } from './approval-policy';
import { classifyFlow, federatedAudienceReason, getFlowLabel, isSharedAudience, loadFlowLabel, observeFlow } from './flow-guard';
import { can } from './space-access';
import { agentConfigWriteReason, commenterMayRun, isReadCall, personalOnlyReason, personalSourceRead, type SpaceToolCall } from './space-tools';
import { isSharedWorkspaceId } from './workspace-fs';

/** The agent making the call (an `AgentContext`, or the scorer's view of one). */
export interface ApprovalCaller {
  userId: string;
  sessionId?: string;
  role?: string;
  root?: boolean;
  attended?: boolean;
  workspaceId?: string | null;
  space?: AgentSpace | null;
  /**
   * What started the agent: a `listen` turn (nobody asked, §9.3) only reads;
   * a `remote` turn (a member of another install asked, federation §7.5)
   * never asks its requester — an approval would be denied.
   */
  trigger?: AgentTrigger;
  /** Members of other installs read the run (federation §7.5): the audience `federated`. */
  audienceFederated?: boolean;
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
  // was built outside `buildAgentContext`. The database answers when this
  // process has not seen the workspace yet.
  if (!space && await isSharedWorkspaceId(context.workspaceId)) {
    return deny('this agent has no space scope, so nothing may run in the space');
  }
  if (space) {
    const { getMembership, isSpaceArchived } = await import('@/core/spaces/service');
    const membership = await getMembership(context.userId, space.workspaceId);
    if (!membership) return deny('you are no longer a member of this space');
    if (await isSpaceArchived(space.workspaceId)) return deny('this space is archived');
    if (!can(membership.role, 'run_agent')) return deny(`your role (${membership.role}) cannot run the agent in this space`);
    // In a room, the room's own door too (a private room's member list, I5).
    if (context.sessionId) {
      const { accessToRoom, loadRoom } = await import('@/core/rooms/access');
      const room = await loadRoom(context.sessionId);
      if (room && !(await accessToRoom(context.userId, room))) return deny('you no longer have access to this room');
    }
    if (!can(membership.role, 'run_agent_write') && !commenterMayRun(call)) {
      return deny(`your role (${membership.role}) can only read and comment in this space; ${call.toolId}.${call.toolName ?? call.action} is not allowed`);
    }
    // A listen turn answers a question nobody handed to the agent, from a
    // conversation of other members' untrusted text: it reads, never writes
    // (§9.3) — whatever the requester's role.
    if (context.trigger === 'listen' && !isReadCall(call)) {
      return deny(`nobody asked for this turn, so it only reads; ${call.toolId}.${call.toolName ?? call.action} is not allowed`);
    }
    const personal = personalOnlyReason(call) ?? agentConfigWriteReason(call);
    if (personal) return deny(personal);
    await loadFlowLabel(context.sessionId);
    // A federated run (federation §7.5, FI5): personal data of host members
    // and credential material never reach members of other installs —
    // refused, where a room would ask.
    if (context.audienceFederated && level !== 'DENY') {
      const contract = classifyFlow({ toolId: call.toolId, action: call.action, args: call.args });
      const federated = federatedAudienceReason(getFlowLabel(context.sessionId), call, contract, personalSourceRead(call));
      if (federated) return { route: 'deny', level: 'DENY', reason: federated, source: 'space-federated' };
    }
    // A read through a personal connection reads private data too (`personalSourceRead`).
    if (level !== 'DENY' && isSharedAudience(context.sessionId)
      && (classifyFlow({ toolId: call.toolId, action: call.action }).taints.includes('private') || personalSourceRead(call))) {
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
        + `(${getFlowLabel(context.sessionId).sources.private}) into ${name}`
        + (context.audienceFederated ? '; members of this room on other installs will read it' : '');
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
  // A turn a member of another install asked for has nobody here to ask
  // (federation §7.5, F-D9): what would wait for its requester is denied.
  if (context.trigger === 'remote' && decision.route === 'ask_human') {
    return deny(`${call.toolId}.${call.toolName ?? call.action} needs an approval, and this turn was asked for from another install: a host member must run this`);
  }
  if (space && (decision.route === 'execute' || decision.route === 'ask_human') && personalSourceRead(call)) {
    observeFlow(context.sessionId, { toolId: call.toolId, action: call.action }, { taints: ['private'] });
  }
  return { ...decision, level, reason: reason ?? decision.reason, source };
}
