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
 *   member's next turn — and every child of a running one — fails;
 *   `recheckSponsor` re-reads a sponsored agent's funding the same way.
 * - `withAgentUsage` / `usageContextOf` carry the user, workspace and funding
 *   to every model call of the turn, so each `cost_log` row of a space turn
 *   names the space and who paid.
 */
import type { AgentContext, AgentFunding, AgentSpace, AgentSponsor, AgentStatus, AgentTrigger } from '@/core/types';
import type { AgentFundingMode } from '@/db/schema/organizations';
import { type ProviderUsageContext, withProviderUsageContext, withSponsor } from '@/models/providers/instrumented';
import { isRealUserId } from '@/security/principal';
import { can, SpaceError } from '@/security/space-access';
import { generateId } from '@/utils/crypto';

/** The workspace, space, trigger and funding of an agent — what children inherit. */
export interface AgentScope {
  readonly workspaceId: string | null;
  readonly space: AgentSpace | null;
  readonly trigger: AgentTrigger;
  readonly funding: AgentFunding;
  /** Who pays when `funding` is `sponsor` (§9.1); null or absent otherwise. */
  readonly sponsor?: AgentSponsor | null;
  /** Members of other installs read the run (federation §7.5, `AgentContext.audienceFederated`). Absent means no. */
  readonly audienceFederated?: boolean;
}

/** Triggers that have a producer inside a space (S1: private sessions; rooms and listen from S2/S5). */
const SPACE_TRIGGERS: ReadonlySet<AgentTrigger> = new Set(['user', 'room', 'listen', 'remote']);

/** A space's funding settings (`workspaces.agent_funding`, `sponsor_user_id`, `sponsor_models`). */
export interface SpaceFundingSettings {
  readonly mode: AgentFundingMode;
  readonly sponsorUserId: string | null;
  readonly sponsorModels: readonly string[];
}

/** Triggers a person starts — a turn they asked for. */
const ASKED_TRIGGERS: ReadonlySet<AgentTrigger> = new Set(['user', 'room']);

/**
 * Who pays for an agent started by `trigger` (D13, §9.1). Never derived from
 * `attended`. Outside a space it is always `own`. In a space, by the space's
 * `agent_funding`:
 *
 *   | mode         | user, room            | listen  | remote  |
 *   |--------------|-----------------------|---------|---------|
 *   | `own`        | own                   | off     | off     |
 *   | `unattended` | own                   | sponsor | sponsor |
 *   | `sponsored`  | sponsor (member cap)  | sponsor | sponsor |
 *
 * "off", a sponsored cell without a sponsor (removed or never named), and
 * a trigger with no producer in a space throw `SpaceError('funding_off')`:
 * the work does not run rather than fall back to someone else's money.
 */
export function fundingFor(trigger: AgentTrigger, space: AgentSpace | null, settings: SpaceFundingSettings | null = null): AgentFunding {
  if (!space) return 'own';
  if (!settings) throw new Error('fundingFor: a space turn needs the space\'s funding settings');
  if (!SPACE_TRIGGERS.has(trigger)) throw new SpaceError('funding_off', `A ${trigger} run has no funding in a space`);
  if (ASKED_TRIGGERS.has(trigger) && settings.mode !== 'sponsored') return 'own';
  if (settings.mode === 'own') {
    throw new SpaceError('funding_off', 'This space pays for nothing unprompted: an owner can name a sponsor in the space settings');
  }
  if (!settings.sponsorUserId) {
    throw new SpaceError('funding_off', 'This space has no sponsor: an owner can name one in the space settings');
  }
  return 'sponsor';
}

/** The scope of a turn in `space` (or none): its funding and, when sponsored, the sponsor. */
async function scopeIn(workspaceId: string | null, space: AgentSpace | null, trigger: AgentTrigger): Promise<AgentScope> {
  if (!space) return { workspaceId, space: null, trigger, funding: fundingFor(trigger, null), sponsor: null };
  const { spaceFunding } = await import('@/core/spaces/funding');
  const settings = await spaceFunding(space.workspaceId);
  const funding = fundingFor(trigger, space, settings);
  const sponsor = funding === 'sponsor' ? { userId: settings.sponsorUserId as string, models: [...settings.sponsorModels] } : null;
  return { workspaceId, space, trigger, funding, sponsor };
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
  return { workspaceId, role: membership.role, scope: membership.scope, remote: !!membership.remote };
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
    return { workspaceId: null, space: null, trigger, funding: fundingFor(trigger, null), sponsor: null };
  }
  const resolved = await resolveTurnWorkspace(userId, session ? session.workspaceId : input.workspaceId);
  if (resolved.space && !SPACE_TRIGGERS.has(trigger)) {
    throw new SpaceError('forbidden_role', `A ${trigger} run cannot start in a space`);
  }
  // A member of another install starts host turns only in rooms, and only
  // as `remote` turns (federation §7.5): no private session, agent or
  // pipeline of theirs runs here.
  if (resolved.space?.remote || trigger === 'remote') {
    throw new SpaceError('forbidden_role', 'A member from another install asks Octipus only in rooms');
  }
  // A guest's `run_agent` holds in the rooms of their scope only (S6): no
  // private session, agent or pipeline of theirs runs in the space.
  if (resolved.space?.scope) {
    throw new SpaceError('forbidden_role', 'A guest asks Octipus only in the rooms they were given');
  }
  return scopeIn(resolved.workspaceId, resolved.space, trigger);
}

async function resolveRoomScope(
  session: { id?: string; workspaceId?: string | null },
  userId: string,
  trigger: AgentTrigger,
): Promise<AgentScope> {
  // A room turn someone asked for, the turn after a positive listen probe
  // (§9.3), or a turn a member of another install asked for (federation §7.5).
  if (trigger !== 'room' && trigger !== 'listen' && trigger !== 'remote') throw new Error('Session not found');
  if (!session.id || !isRealUserId(userId)) throw new Error('Session not found');
  const { roomAccess } = await import('@/core/rooms/access');
  const access = await roomAccess(userId, session.id);
  if (!access) throw new SpaceError('not_found', 'Room not found');
  // A remote member's turns are `remote` turns, and only theirs are.
  if ((trigger === 'remote') !== (access.remote !== null)) {
    throw new SpaceError('forbidden_role', trigger === 'remote' ? 'Only a member from another install starts a remote turn' : 'A member from another install starts remote turns only');
  }
  const resolved = await resolveTurnWorkspace(userId, access.room.workspaceId);
  if (!resolved.space) throw new Error('A room lives in a space');
  const scope = await scopeIn(resolved.workspaceId, resolved.space, trigger);
  return { ...scope, audienceFederated: trigger === 'remote' || await roomHasRemoteMember(session.id, access.room.workspaceId) };
}

/**
 * Whether a member of another install may enter the room (federation
 * §7.5): a remote member of the space for an open room, a remote
 * `room_members` row for a private one, or a remote guest whose scope names
 * the room. Whatever the state of their install — a blocked one still read
 * what was there: the run is federated either way, the stricter answer.
 */
async function roomHasRemoteMember(roomId: string, workspaceId: string): Promise<boolean> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(
    `SELECT EXISTS (
       SELECT 1 FROM workspace_members m
       JOIN users u ON u.id = m.user_id AND u.kind = 'remote'
       JOIN sessions s ON s.id = $1 AND s.kind = 'room'
       WHERE m.workspace_id = $2
         AND CASE WHEN m.role = 'guest' THEN coalesce(m.scope->'rooms', '[]'::jsonb) ? $1::text
                  WHEN s.room_visibility = 'private' THEN EXISTS (SELECT 1 FROM room_members rm WHERE rm.session_id = s.id AND rm.user_id = m.user_id)
                  ELSE true END
     ) AS federated`,
    [roomId, workspaceId],
  );
  return (rows[0] as { federated: boolean } | undefined)?.federated === true;
}

/** A child's scope: its parent's workspace, space, trigger, funding, sponsor and audience, unchanged. */
export function inheritScope(parent: Pick<AgentContext, 'workspaceId' | 'space' | 'trigger' | 'funding' | 'sponsor' | 'audienceFederated'>): AgentScope {
  return {
    workspaceId: parent.workspaceId ?? null, space: parent.space, trigger: parent.trigger, funding: parent.funding, sponsor: parent.sponsor ?? null,
    audienceFederated: parent.audienceFederated === true,
  };
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

/**
 * Re-read the space's funding before sponsored work goes on (§9.1), as
 * `recheckSpace` re-reads the membership: the scope's funding was decided
 * when the turn started, and the sponsor may have gone since (removed,
 * downgraded, cleared, account deleted) or the mode may pay for less. Throws
 * `funding_off` when the mode no longer funds the trigger or the sponsor is
 * not the one the work started under. Returns the sponsor as it is now —
 * the sponsor models as listed now. Null for work that is not sponsored.
 */
export async function recheckSponsor(scope: Pick<AgentScope, 'space' | 'trigger' | 'funding' | 'sponsor'>): Promise<AgentSponsor | null> {
  if (scope.funding !== 'sponsor') return null;
  if (!scope.space || !scope.sponsor) throw new Error('A sponsored agent needs its space and sponsor (resolveAgentScope / inheritScope)');
  const { spaceFunding } = await import('@/core/spaces/funding');
  const settings = await spaceFunding(scope.space.workspaceId);
  const funding = fundingFor(scope.trigger, scope.space, settings);
  if (funding !== 'sponsor' || settings.sponsorUserId !== scope.sponsor.userId) {
    throw new SpaceError('funding_off', 'The space\'s funding changed since this work started: its sponsor no longer pays for it');
  }
  return { userId: settings.sponsorUserId, models: [...settings.sponsorModels] };
}

/**
 * Whether a space turn holds no writing tools: a role that cannot write
 * (§5.6), or a `listen` turn — nobody asked for it, and the conversation it
 * answers is other members' untrusted text (§9.3). Its writes are also
 * refused at call time (`routeApprovalFor`).
 */
export function writesWithheld(space: Pick<AgentSpace, 'role'>, trigger: AgentTrigger | undefined): boolean {
  return !can(space.role, 'run_agent_write') || trigger === 'listen';
}

export interface AgentContextInput {
  /** Defaults to a fresh id. */
  id?: string;
  sessionId: string;
  userId: string;
  scope: AgentScope;
  topic: string;
  model: string;
  /** Registry row of `model` — see `AgentContext.modelName`. */
  modelName?: string;
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
    sponsor: input.scope.funding === 'sponsor' ? requireSponsor(input.scope) : null,
    audienceFederated: input.scope.audienceFederated === true,
    topic: input.topic,
    model: input.model,
    modelName: input.modelName,
    role: input.role,
    root: input.root === true,
    attended: input.attended,
    status: input.status ?? 'idle',
    createdAt: now,
    updatedAt: now,
    metadata: { ...(input.metadata ?? {}) },
  };
}

function requireSponsor(scope: AgentScope): AgentSponsor {
  if (!scope.sponsor) throw new Error('A sponsored agent needs its sponsor (resolveAgentScope / inheritScope)');
  return scope.sponsor;
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
  const sponsor = scope.funding === 'sponsor' ? scope.sponsor ?? null : null;
  return withSponsor(sponsor, () => withProviderUsageContext({ userId, workspaceId: scope.workspaceId, funding: scope.funding }, run));
}
