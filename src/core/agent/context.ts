/**
 * One place builds agent contexts (docs/plans/coworking-spec.md §5.6).
 *
 * - `resolveAgentScope({ session, userId, trigger })` resolves the workspace
 *   a turn runs in, reads the requester's membership when it is a space, and
 *   decides the funding. It fails closed: a session of another user, a
 *   workspace the user neither owns nor is a member of, a role without
 *   `run_agent` (viewers), an archived space, or a trigger with no producer
 *   in a space all throw before any worker exists.
 * - `buildAgentContext(...)` is the only constructor of an `AgentContext`
 *   literal; a test fails on a hand-built one anywhere else. Children get
 *   their parent's scope through `inheritScope`.
 * - `recheckSpace` re-reads the membership at every spawn (D5), so a removed
 *   member's next turn — and every child of a running one — fails.
 * - `withAgentUsage` / `usageContextOf` carry the user, workspace and funding
 *   to every model call of the turn, so each `cost_log` row of a space turn
 *   names the space and who paid.
 */
import type { AgentContext, AgentFunding, AgentSpace, AgentStatus, AgentTrigger } from '@/core/types';
import { type ProviderUsageContext, withProviderUsageContext } from '@/models/providers/instrumented';
import { isRealUserId } from '@/security/principal';
import { can, SpaceError } from '@/security/space-access';
import { generateId } from '@/utils/crypto';

/** The workspace, space, trigger and funding of an agent — what children inherit. */
export interface AgentScope {
  readonly workspaceId: string | null;
  readonly space: AgentSpace | null;
  readonly trigger: AgentTrigger;
  readonly funding: AgentFunding;
}

/** Triggers that have a producer inside a space (S1: private sessions; rooms and listen from S2/S5). */
const SPACE_TRIGGERS: ReadonlySet<AgentTrigger> = new Set(['user', 'room', 'listen', 'remote']);

/**
 * Who pays for an agent started by `trigger` (D13). Every trigger is funded
 * by the requester (`own`) until S5 adds sponsors (§9.1); never derived from
 * `attended`.
 */
export function fundingFor(_trigger: AgentTrigger, _space: AgentSpace | null): AgentFunding {
  return 'own';
}

/** Channels whose turns a schedule starts (hooks, heartbeats, recurring tasks). */
const SCHEDULE_CHANNELS = new Set(['hook', 'heartbeat', 'cron']);

/**
 * The trigger of a root turn that entered through `channel` (the spawn-site
 * table of §5.6): a group-channel mention is `room`, hook, heartbeat and
 * cron turns are `schedule`, a monitor wake-up is `monitor`, and every
 * person-facing channel (web, TUI, messaging DMs, REST, voice) is `user`.
 */
export function triggerForChannel(channel: string | undefined, groupTurn: boolean): AgentTrigger {
  if (groupTurn) return 'room';
  if (channel && SCHEDULE_CHANNELS.has(channel)) return 'schedule';
  if (channel === 'monitor') return 'monitor';
  return 'user';
}

/**
 * The workspace a turn of `userId` runs in, and the space when it is one:
 * `workspaceId` when given, else the user's default workspace. A personal
 * workspace must be the user's own; a shared one needs a membership whose
 * role may run the agent, and must not be archived. Anything else throws —
 * a turn never runs unscoped.
 */
export async function resolveTurnWorkspace(
  userId: string,
  workspaceId: string | null | undefined,
): Promise<{ workspaceId: string; space: AgentSpace | null }> {
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const mgr = getOrgWorkspaceManager();
  if (!workspaceId) return { workspaceId: (await mgr.ensureDefaultWorkspace(userId)).id, space: null };
  const owned = await mgr.findOwnedById(userId, workspaceId);
  if (owned) return { workspaceId: owned.id, space: null };
  const space = await readSpace(userId, workspaceId);
  if (!space) throw new Error('Workspace not found');
  return { workspaceId, space };
}

/**
 * The requester's membership of `workspaceId` as an `AgentSpace`, checked
 * for `run_agent` and archive; null when `workspaceId` is not a space they
 * belong to. Read from the database every call (D5).
 */
async function readSpace(userId: string, workspaceId: string): Promise<AgentSpace | null> {
  const { getMembership, isSpaceArchived } = await import('@/core/spaces/service');
  const membership = await getMembership(userId, workspaceId);
  if (!membership) return null;
  if (!can(membership.role, 'run_agent')) {
    throw new SpaceError('forbidden_role', `Your role (${membership.role}) cannot run the agent in this space`);
  }
  if (await isSpaceArchived(workspaceId)) throw new SpaceError('archived', 'This space is archived');
  return { workspaceId, role: membership.role, scope: membership.scope };
}

/**
 * Resolve the scope of a turn: the session's workspace (or `workspaceId` for
 * a turn without a session row yet), the requester's space membership, the
 * trigger and the funding. Fails closed (see the module comment). A caller
 * with no real user behind it (a `'system'` hook) gets no workspace.
 */
export async function resolveAgentScope(input: {
  session: { id?: string; userId: string; workspaceId?: string | null; kind?: string | null } | null;
  userId: string;
  trigger: AgentTrigger;
  /** Only when there is no session row: the workspace the turn is asked to run in. */
  workspaceId?: string | null;
}): Promise<AgentScope> {
  const { session, userId, trigger } = input;
  // A room (§6.2) is no one's own session: its turns run as their requester,
  // who must be able to enter the room now, and only as room turns.
  if (session?.kind === 'room') return resolveRoomScope(session, userId, trigger);
  if (session && session.userId !== userId) throw new Error('Session not found');
  if (!isRealUserId(userId)) {
    return { workspaceId: null, space: null, trigger, funding: fundingFor(trigger, null) };
  }
  const resolved = await resolveTurnWorkspace(userId, session ? session.workspaceId : input.workspaceId);
  if (resolved.space && !SPACE_TRIGGERS.has(trigger)) {
    throw new SpaceError('forbidden_role', `A ${trigger} run cannot start in a space`);
  }
  return { workspaceId: resolved.workspaceId, space: resolved.space, trigger, funding: fundingFor(trigger, resolved.space) };
}

async function resolveRoomScope(
  session: { id?: string; workspaceId?: string | null },
  userId: string,
  trigger: AgentTrigger,
): Promise<AgentScope> {
  if (trigger !== 'room') throw new Error('Session not found');
  if (!session.id || !isRealUserId(userId)) throw new Error('Session not found');
  const { roomAccess } = await import('@/core/rooms/access');
  const access = await roomAccess(userId, session.id);
  if (!access) throw new SpaceError('not_found', 'Room not found');
  const resolved = await resolveTurnWorkspace(userId, access.room.workspaceId);
  if (!resolved.space) throw new Error('A room lives in a space');
  return { workspaceId: resolved.workspaceId, space: resolved.space, trigger, funding: fundingFor(trigger, resolved.space) };
}

/** A child's scope: its parent's workspace, space, trigger and funding, unchanged. */
export function inheritScope(parent: Pick<AgentContext, 'workspaceId' | 'space' | 'trigger' | 'funding'>): AgentScope {
  return { workspaceId: parent.workspaceId ?? null, space: parent.space, trigger: parent.trigger, funding: parent.funding };
}

/**
 * Re-read a space membership before an agent of it starts (D5, I5): throws
 * `not_found` once the requester was removed, `forbidden_role` once their
 * role may no longer run the agent, `archived` once the space is archived.
 * Returns the current role (it may have changed since the scope was built).
 */
export async function recheckSpace(userId: string, space: AgentSpace): Promise<AgentSpace> {
  const current = await readSpace(userId, space.workspaceId);
  if (!current) throw new SpaceError('not_found', 'You are no longer a member of this space');
  return current;
}

export interface AgentContextInput {
  /** Defaults to a fresh id. */
  id?: string;
  sessionId: string;
  userId: string;
  scope: AgentScope;
  topic: string;
  model: string;
  role: string;
  root?: boolean;
  attended?: boolean;
  /** Defaults to `idle` (a worker not started yet). */
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
}

/** The one constructor of an `AgentContext`. */
export function buildAgentContext(input: AgentContextInput): AgentContext {
  const now = new Date();
  return {
    id: input.id ?? generateId(),
    sessionId: input.sessionId,
    userId: input.userId,
    workspaceId: input.scope.workspaceId,
    space: input.scope.space,
    trigger: input.scope.trigger,
    funding: input.scope.funding,
    topic: input.topic,
    model: input.model,
    role: input.role,
    root: input.root === true,
    attended: input.attended,
    status: input.status ?? 'idle',
    createdAt: now,
    updatedAt: now,
    metadata: { ...(input.metadata ?? {}) },
  };
}

/** The usage context of one agent's model calls. */
export function usageContextOf(context: Pick<AgentContext, 'userId' | 'sessionId' | 'id' | 'workspaceId' | 'funding'>): ProviderUsageContext {
  return {
    userId: context.userId,
    sessionId: context.sessionId,
    agentId: context.id,
    workspaceId: context.workspaceId ?? null,
    funding: context.funding,
  };
}

/**
 * Run a whole turn with its requester, workspace and funding as the ambient
 * usage context: every model call underneath (the agent's, its children's,
 * the turn's helpers') lands in `cost_log` with that workspace and funding,
 * unless it is an install-topic call, which stamps `install` itself.
 */
export function withAgentUsage<T>(userId: string, scope: AgentScope, run: () => T): T {
  return withProviderUsageContext({ userId, workspaceId: scope.workspaceId, funding: scope.funding }, run);
}
