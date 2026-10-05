/**
 * Shared spaces — the service (docs/plans/coworking-spec.md §5.3).
 *
 * A space is a workspace with `kind = 'shared'` and no owning user row (D1,
 * D2). Who may do what in it is `workspace_members`, and `getMembership` is
 * the only read of that table: the routes here, the resolver, the access
 * layer, agent contexts and the approval path all go through it (D5, I1).
 *
 * Every function takes an actor `{ userId }`, reads the actor's membership
 * from the database (never a snapshot), and every change writes one audit
 * row carrying the space's `workspace_id` (I10) — in the same transaction as
 * the change, so there is no change without its row.
 *
 * Non-members get `SpaceError('not_found')` for every space id, existing or
 * not (I3); members whose role lacks the action get `forbidden_role`.
 */
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb, queryRaw } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { type AuditDetails, auditLog } from '@/db/schema/audit';
import { type AgentEditMode, newWorkspaceRow, type SpaceRole, type Workspace, workspaceInvites, workspaceMembers, workspaces } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';
import { requireRealUserId } from '@/security/principal';
import { noteSharedWorkspace } from '@/security/workspace-fs';
import {
  can,
  isSpaceRole,
  requireCan,
  SpaceError,
  type SpaceMembership,
} from '@/security/space-access';
import { generateToken } from '@/utils/crypto';
import { securityLogger } from '@/utils/logger';
import { freezeSpace, onMembershipChanged, onMembershipGranted, settleFollowUp } from './membership';

export { can, SpaceError, type SpaceMembership } from '@/security/space-access';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/** Whoever performs a space operation. Rights are read from the database, never from here. */
export interface SpaceActor {
  readonly userId: string;
  /**
   * The admin acting as `userId` (audited impersonation, §5.5): rights are
   * still `userId`'s, and every audit row names the admin too (I10).
   */
  readonly impersonatedBy?: string | null;
}

/** The audit columns of an actor: who acted, and the admin behind them when impersonating. */
export function auditActor(actor: SpaceActor): { actorId: string; impersonatedBy: string | null } {
  return { actorId: actor.userId, impersonatedBy: actor.impersonatedBy ?? null };
}

export type SpaceAuditAction =
  | 'space_created'
  | 'space_updated'
  | 'space_archived'
  | 'space_purged'
  | 'space_member_added'
  | 'space_member_role_changed'
  | 'space_member_removed'
  | 'space_invite_created'
  | 'space_invite_revoked'
  | 'space_invite_accepted'
  | 'space_content_changed';

/** Write one audit row of a space change (I10). Pass the transaction the change runs in. */
export async function writeSpaceAudit(
  db: Executor,
  entry: {
    actorId: string;
    /** The admin impersonating `actorId`, recorded in `details.impersonatedBy`. */
    impersonatedBy?: string | null;
    action: SpaceAuditAction;
    workspaceId: string;
    resourceType?: string;
    resourceId?: string;
    details?: AuditDetails;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: entry.actorId,
    action: entry.action,
    workspaceId: entry.workspaceId,
    resourceType: entry.resourceType ?? 'space',
    resourceId: entry.resourceId ?? entry.workspaceId,
    details: { ...(entry.details ?? {}), ...(entry.impersonatedBy ? { impersonatedBy: entry.impersonatedBy } : {}) },
  });
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new SpaceError('invalid_name', 'Name must be 1–120 characters');
  }
  return trimmed;
}

/**
 * `userId`'s membership of the shared workspace `workspaceId`, or null when
 * they are not a member, the workspace is not shared, or either id is not a
 * uuid. The only read of `workspace_members`.
 *
 * `lock` (inside a transaction) locks the membership row: `share` for an
 * actor's own rights, so a demotion or removal committing meanwhile waits
 * for the operation instead of racing it; `update` for a row about to change.
 */
export async function getMembership(
  userId: string,
  workspaceId: string,
  db: Executor = getDb(),
  opts: { lock?: 'share' | 'update' } = {},
): Promise<SpaceMembership | null> {
  if (!isUuid(userId) || !isUuid(workspaceId)) return null;
  const query = db
    .select({ role: workspaceMembers.role, scope: workspaceMembers.scope })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaces.kind, 'shared'),
    ))
    .limit(1);
  const [row] = opts.lock ? await query.for(opts.lock, { of: workspaceMembers }) : await query;
  if (!row) return null;
  // The synchronous file-root lookups (`WorkspaceFS.forAgent` / `forSession`)
  // learn the space from here: every path into a space reads a membership.
  noteSharedWorkspace(workspaceId);
  return { workspaceId, userId, role: row.role, scope: row.scope ?? null };
}

/** Whether `workspaceId` names a shared workspace (read from the database). */
export async function isSharedWorkspace(workspaceId: string, db: Executor = getDb()): Promise<boolean> {
  return (await loadSpace(workspaceId, db)) !== null;
}

/**
 * Drop the rows of shared workspaces from `rows` — for a personal list built
 * by code outside the repositories (I2: personal paths never return a
 * space's rows).
 */
export async function withoutSpaceRows<T extends { workspaceId: string | null }>(rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.map((r) => r.workspaceId).filter((id): id is string => !!id && isUuid(id)))];
  if (ids.length === 0) return rows;
  const shared = await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(inArray(workspaces.id, ids), eq(workspaces.kind, 'shared')));
  const drop = new Set(shared.map((r) => r.id));
  return drop.size === 0 ? rows : rows.filter((r) => !r.workspaceId || !drop.has(r.workspaceId));
}

/** The space row, or null when `workspaceId` names no shared workspace. */
async function loadSpace(workspaceId: string, db: Executor = getDb()): Promise<Workspace | null> {
  if (!isUuid(workspaceId)) return null;
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, 'shared')))
    .limit(1);
  return row ?? null;
}

/**
 * The actor's membership with the action allowed, and the space row. Given a
 * transaction, the actor's membership row is locked `FOR SHARE` until it
 * ends: an owner demoted or removed concurrently cannot still finish a
 * removal, an invite or a purge they no longer have the right to.
 */
async function authorize(
  actor: SpaceActor,
  workspaceId: string,
  action: Parameters<typeof can>[1],
  db: Executor = getDb(),
): Promise<{ membership: SpaceMembership; space: Workspace }> {
  const lock = db === getDb() ? {} : { lock: 'share' as const };
  const membership = requireCan(await getMembership(actor.userId, workspaceId, db, lock), action);
  const space = await loadSpace(workspaceId, db);
  if (!space) throw new SpaceError('not_found', 'Space not found');
  return { membership, space };
}

function assertNotArchived(space: Workspace): void {
  if (space.archivedAt) throw new SpaceError('archived', 'This space is archived');
}

async function memberCount(workspaceId: string, db: Executor = getDb()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return Number(row?.n ?? 0);
}

export interface SpaceSummary {
  id: string;
  name: string;
  slug: string;
  /** The caller's role. */
  role: SpaceRole;
  memberCount: number;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  /**
   * Who pays for agent runs in the space: each member for their own
   * (`own`). A space-sponsored agent arrives in S5.
   */
  funding: 'own';
  /** How the agent edits the space's notes (§7.4). */
  agentEditMode: AgentEditMode;
  /** Set when the change committed but its follow-up (stopping agents, expiring requests) failed; logged. */
  warning?: string;
}

function summarize(space: Workspace, role: SpaceRole, members: number): SpaceSummary {
  return {
    id: space.id,
    name: space.name,
    slug: space.slug,
    role,
    memberCount: members,
    archivedAt: space.archivedAt,
    createdBy: space.createdBy,
    createdAt: space.createdAt,
    funding: 'own',
    agentEditMode: space.agentEditMode,
  };
}

/**
 * Create a space with the actor as its owner. `spaces.creation` decides who
 * may (D17): every user, or admins only (read from the database).
 */
export async function createSpace(actor: SpaceActor, input: { name: string }): Promise<SpaceSummary> {
  requireRealUserId(actor.userId);
  const name = assertName(input.name);
  const db = getDb();
  const [user] = await db
    .select({ isAdmin: users.isAdmin, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!user?.isActive) throw new SpaceError('not_found', 'User not found');
  if (getConfig().spaces.creation === 'admins' && !user.isAdmin) {
    throw new SpaceError('forbidden_role', 'Only admins may create spaces on this install');
  }

  const space = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(workspaces)
      .values(newWorkspaceRow({
        kind: 'shared',
        userId: null,
        createdBy: actor.userId,
        // Spaces have no owner namespace; the slug is only a handle.
        slug: `space-${generateToken(6)}`,
        name,
        isDefault: false,
      }))
      .returning();
    await tx.insert(workspaceMembers).values({ workspaceId: created.id, userId: actor.userId, role: 'owner' });
    // Every space starts with an open room, "General" (§5.3, S2).
    const { createRoomInTx, DEFAULT_ROOM_TITLE } = await import('@/core/rooms/service');
    await createRoomInTx(tx, { workspaceId: created.id, createdBy: actor.userId, title: DEFAULT_ROOM_TITLE, visibility: 'space' });
    await writeSpaceAudit(tx, { ...auditActor(actor), action: 'space_created', workspaceId: created.id, details: { name } });
    return created;
  });
  securityLogger.info({ workspaceId: space.id, by: actor.userId }, 'Space created');
  return summarize(space, 'owner', 1);
}

/** The spaces the actor is a member of, with their role, newest first. */
export async function listSpaces(actor: SpaceActor): Promise<SpaceSummary[]> {
  if (!isUuid(actor.userId)) return [];
  const rows = await getDb()
    .select({
      space: workspaces,
      role: workspaceMembers.role,
      members: sql<number>`(SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = ${workspaces.id})`,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, actor.userId), eq(workspaces.kind, 'shared')))
    .orderBy(desc(workspaces.createdAt));
  return rows.map((r) => summarize(r.space, r.role, Number(r.members)));
}

/** One space, for a member. */
export async function getSpace(actor: SpaceActor, workspaceId: string): Promise<SpaceSummary> {
  const { membership, space } = await authorize(actor, workspaceId, 'read');
  return summarize(space, membership.role, await memberCount(workspaceId));
}

export async function renameSpace(actor: SpaceActor, workspaceId: string, name: string): Promise<SpaceSummary> {
  const trimmed = assertName(name);
  return getDb().transaction(async (tx) => {
    const { membership, space } = await authorize(actor, workspaceId, 'manage_space', tx);
    assertNotArchived(space);
    const [updated] = await tx
      .update(workspaces)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_updated',
      workspaceId,
      details: { previousValue: space.name, newValue: trimmed },
    });
    return summarize(updated, membership.role, await memberCount(workspaceId, tx));
  });
}

/**
 * Archive a space: read-only from now on (no writes, no agent runs), and
 * every agent running in it stops. Archiving an archived space changes
 * nothing.
 */
export async function archiveSpace(actor: SpaceActor, workspaceId: string): Promise<SpaceSummary> {
  const result = await getDb().transaction(async (tx) => {
    const { membership, space } = await authorize(actor, workspaceId, 'manage_space', tx);
    if (space.archivedAt) return { summary: summarize(space, membership.role, await memberCount(workspaceId, tx)), changed: false };
    const [updated] = await tx
      .update(workspaces)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    await writeSpaceAudit(tx, { ...auditActor(actor), action: 'space_archived', workspaceId, details: { archived: true } });
    return { summary: summarize(updated, membership.role, await memberCount(workspaceId, tx)), changed: true };
  });
  if (!result.changed) return result.summary;
  const warning = await settleFollowUp('Space archive', { workspaceId }, () => freezeSpace(workspaceId));
  return warning ? { ...result.summary, warning } : result.summary;
}

export async function unarchiveSpace(actor: SpaceActor, workspaceId: string): Promise<SpaceSummary> {
  const result = await getDb().transaction(async (tx) => {
    const { membership, space } = await authorize(actor, workspaceId, 'manage_space', tx);
    if (!space.archivedAt) return { summary: summarize(space, membership.role, await memberCount(workspaceId, tx)), changed: false };
    const [updated] = await tx
      .update(workspaces)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    await writeSpaceAudit(tx, { ...auditActor(actor), action: 'space_updated', workspaceId, details: { archived: false } });
    return { summary: summarize(updated, membership.role, await memberCount(workspaceId, tx)), changed: true };
  });
  if (!result.changed) return result.summary;
  // Open live documents become editable again (S3).
  const warning = await settleFollowUp('Space unarchive', { workspaceId }, async () => {
    const { getDocHub } = await import('@/core/docs');
    await getDocHub().setSpaceArchived(workspaceId, false);
  });
  return warning ? { ...result.summary, warning } : result.summary;
}

/**
 * How the agent edits the space's notes (§7.4): `suggest` (its writes
 * become edit proposals) or `direct`. Owners only.
 */
export async function setAgentEditMode(actor: SpaceActor, workspaceId: string, mode: AgentEditMode): Promise<SpaceSummary> {
  if (mode !== 'suggest' && mode !== 'direct') throw new SpaceError('invalid_input', 'agentEditMode must be suggest or direct');
  return getDb().transaction(async (tx) => {
    const { membership, space } = await authorize(actor, workspaceId, 'manage_space', tx);
    assertNotArchived(space);
    const [updated] = await tx
      .update(workspaces)
      .set({ agentEditMode: mode, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_updated',
      workspaceId,
      details: { field: 'agentEditMode', previousValue: space.agentEditMode, newValue: mode },
    });
    return summarize(updated, membership.role, await memberCount(workspaceId, tx));
  });
}

/**
 * Whether the space is archived. Throws `not_found` for an id that names no
 * space. The access layer and the agent refuse writes and runs when true.
 */
export async function isSpaceArchived(workspaceId: string): Promise<boolean> {
  const space = await loadSpace(workspaceId);
  if (!space) throw new SpaceError('not_found', 'Space not found');
  return space.archivedAt !== null;
}

export interface SpaceMemberView {
  userId: string;
  username: string;
  role: SpaceRole;
  joinedAt: Date;
}

/** What a committed membership change reports: a failed follow-up (§5.9), logged. */
export interface MembershipChangeResult {
  warning?: string;
}

/**
 * Revoke the open invites `creatorId` made in the space, in the caller's
 * transaction, one audit row each (I10). Runs when an owner is removed,
 * leaves or loses `manage_invites`: their links must not let them, or
 * whomever they shared them with, back in (I5).
 */
async function revokeInvitesBy(tx: Tx, actor: SpaceActor, workspaceId: string, creatorId: string): Promise<number> {
  const revoked = await tx
    .update(workspaceInvites)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(workspaceInvites.workspaceId, workspaceId),
      eq(workspaceInvites.createdBy, creatorId),
      isNull(workspaceInvites.revokedAt),
    ))
    .returning({ id: workspaceInvites.id });
  for (const row of revoked) {
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_invite_revoked',
      workspaceId,
      resourceType: 'space_invite',
      resourceId: row.id,
      details: { reason: 'creator_lost_access', createdBy: creatorId },
    });
  }
  return revoked.length;
}

/**
 * The members of a space, for any member. A guest sees only themselves:
 * guests see the members of their rooms, and rooms arrive in S2.
 */
export async function listMembers(actor: SpaceActor, workspaceId: string): Promise<SpaceMemberView[]> {
  const { membership } = await authorize(actor, workspaceId, 'read');
  const rows = await getDb()
    .select({
      userId: workspaceMembers.userId,
      username: users.username,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      membership.role === 'guest' ? eq(workspaceMembers.userId, actor.userId) : undefined,
    ))
    .orderBy(workspaceMembers.joinedAt);
  return rows;
}

/**
 * Lock the space's owner rows and refuse when `userId` is its only owner.
 * Locking serialises two owners demoting each other at once, which would
 * otherwise leave a space without an owner.
 */
async function assertNotLastOwner(tx: Tx, workspaceId: string, userId: string): Promise<void> {
  const owners = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')))
    .for('update');
  if (owners.length === 1 && owners[0].userId === userId) {
    throw new SpaceError('last_owner', 'The last owner of a space cannot be removed, demoted or leave; make another member an owner first');
  }
}

/** Whether going from `from` to `to` loses any grant (a downgrade). */
function losesGrant(from: SpaceRole, to: SpaceRole): boolean {
  const actions = ['read', 'comment', 'write', 'run_agent', 'run_agent_write', 'manage_members', 'manage_invites', 'manage_space'] as const;
  return actions.some((a) => can(from, a) && !can(to, a));
}

/** Change a member's role (owner only). `scope` applies to guests and is cleared for every other role. */
export async function setRole(
  actor: SpaceActor,
  workspaceId: string,
  targetUserId: string,
  input: { role: string; scope?: Record<string, unknown> | null },
): Promise<SpaceMemberView & MembershipChangeResult> {
  if (!isSpaceRole(input.role)) throw new SpaceError('invalid_role', `Unknown role: ${input.role}`);
  const role = input.role;
  if (input.scope != null && role !== 'guest') {
    throw new SpaceError('invalid_input', 'Only a guest has a scope');
  }
  const scope = role === 'guest' ? (input.scope ?? null) : null;

  const outcome = await getDb().transaction(async (tx) => {
    await authorize(actor, workspaceId, 'manage_members', tx);
    // Locked: a target leaving meanwhile waits, or is already gone here.
    const target = await getMembership(targetUserId, workspaceId, tx, { lock: 'update' });
    if (!target) throw new SpaceError('not_found', 'Member not found');
    if (target.role === 'owner' && role !== 'owner') await assertNotLastOwner(tx, workspaceId, targetUserId);
    const [updated] = await tx
      .update(workspaceMembers)
      .set({ role, scope })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .returning();
    if (!updated) throw new SpaceError('not_found', 'Member not found');
    if (can(target.role, 'manage_invites') && !can(role, 'manage_invites')) {
      await revokeInvitesBy(tx, actor, workspaceId, targetUserId);
    }
    const scopeChanged = JSON.stringify(target.scope ?? null) !== JSON.stringify(scope);
    if (target.role !== role || scopeChanged) {
      await writeSpaceAudit(tx, {
        ...auditActor(actor),
        action: 'space_member_role_changed',
        workspaceId,
        resourceType: 'space_member',
        resourceId: targetUserId,
        details: { previousValue: target.role, newValue: role, ...(scopeChanged ? { scopeChanged: true } : {}) },
      });
    }
    const [user] = await tx.select({ username: users.username }).from(users).where(eq(users.id, targetUserId)).limit(1);
    return {
      view: { userId: targetUserId, username: user?.username ?? '', role: updated.role, joinedAt: updated.joinedAt },
      revoked: losesGrant(target.role, role) || (role === 'guest' && scopeChanged),
      granted: target.role !== role && !losesGrant(target.role, role),
    };
  });
  const context = { workspaceId, userId: targetUserId };
  const warning = outcome.revoked
    ? await settleFollowUp('Space role change', context, () => onMembershipChanged(workspaceId, targetUserId))
    : outcome.granted
      ? await settleFollowUp('Space role change', context, () => onMembershipGranted(workspaceId, targetUserId))
      : null;
  return warning ? { ...outcome.view, warning } : outcome.view;
}

/**
 * Remove a member (owner only). Removing oneself is leaving. The last owner
 * can do neither.
 */
export async function removeMember(actor: SpaceActor, workspaceId: string, targetUserId: string): Promise<MembershipChangeResult> {
  if (targetUserId === actor.userId) return leaveSpace(actor, workspaceId);
  await getDb().transaction(async (tx) => {
    await authorize(actor, workspaceId, 'manage_members', tx);
    const target = await getMembership(targetUserId, workspaceId, tx, { lock: 'update' });
    if (!target) throw new SpaceError('not_found', 'Member not found');
    if (target.role === 'owner') await assertNotLastOwner(tx, workspaceId, targetUserId);
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)));
    await revokeInvitesBy(tx, actor, workspaceId, targetUserId);
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_member_removed',
      workspaceId,
      resourceType: 'space_member',
      resourceId: targetUserId,
      details: { previousValue: target.role },
    });
  });
  securityLogger.info({ workspaceId, userId: targetUserId, by: actor.userId }, 'Space member removed');
  const warning = await settleFollowUp('Space member removal', { workspaceId, userId: targetUserId }, () => onMembershipChanged(workspaceId, targetUserId));
  return warning ? { warning } : {};
}

/** Leave a space. The last owner cannot. */
export async function leaveSpace(actor: SpaceActor, workspaceId: string, details: Record<string, unknown> = {}): Promise<MembershipChangeResult> {
  await getDb().transaction(async (tx) => {
    const membership = await getMembership(actor.userId, workspaceId, tx, { lock: 'update' });
    if (!membership) throw new SpaceError('not_found', 'Space not found');
    if (membership.role === 'owner') await assertNotLastOwner(tx, workspaceId, actor.userId);
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actor.userId)));
    await revokeInvitesBy(tx, actor, workspaceId, actor.userId);
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_member_removed',
      workspaceId,
      resourceType: 'space_member',
      resourceId: actor.userId,
      details: { previousValue: membership.role, left: true, ...details },
    });
  });
  const warning = await settleFollowUp('Leaving a space', { workspaceId, userId: actor.userId }, () => onMembershipChanged(workspaceId, actor.userId));
  return warning ? { warning } : {};
}

/**
 * Before a user account is deleted: leave every space it belongs to, each
 * with its audit row and `onMembershipChanged` (I5, I10), instead of the
 * membership rows vanishing in the account's cascade. The caller has
 * already refused the last owner (`assertDeletable`).
 */
export async function leaveAllSpaces(userId: string): Promise<void> {
  if (!isUuid(userId)) return;
  const rows = await getDb()
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  for (const row of rows) {
    await leaveSpace({ userId }, row.workspaceId, { accountDeleted: true });
  }
}

/**
 * Add a member inside the caller's transaction, enforcing `spaces.maxMembers`.
 * The space row is locked first, so two joins racing for the last seat
 * cannot both get it. Returns false when the user already is a member (their
 * role is kept). The caller writes the audit row.
 */
export async function addMemberInTx(
  tx: Tx,
  workspaceId: string,
  input: { userId: string; role: SpaceRole; scope?: Record<string, unknown> | null; invitedBy?: string | null },
): Promise<boolean> {
  const [space] = await tx
    .select({ id: workspaces.id, archivedAt: workspaces.archivedAt })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, 'shared')))
    .for('update');
  if (!space) throw new SpaceError('not_found', 'Space not found');
  if (space.archivedAt) throw new SpaceError('archived', 'This space is archived');
  if (await getMembership(input.userId, workspaceId, tx)) return false;
  if ((await memberCount(workspaceId, tx)) >= getConfig().spaces.maxMembers) {
    throw new SpaceError('space_full', 'This space has reached its member limit');
  }
  const inserted = await tx
    .insert(workspaceMembers)
    .values({
      workspaceId,
      userId: input.userId,
      role: input.role,
      scope: input.role === 'guest' ? (input.scope ?? null) : null,
      invitedBy: input.invitedBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ userId: workspaceMembers.userId });
  return inserted.length > 0;
}

export interface SpaceActivityEntry {
  id: string;
  action: string;
  userId: string | null;
  username: string | null;
  resourceType: string | null;
  resourceId: string | null;
  details: AuditDetails | null;
  createdAt: Date;
}

/**
 * The space's audit rows, newest first, for any member. Paged by `before`
 * (the `createdAt` of the last row of the previous page).
 */
export async function listActivity(
  actor: SpaceActor,
  workspaceId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<SpaceActivityEntry[]> {
  await authorize(actor, workspaceId, 'read');
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await getDb()
    .select({
      id: auditLog.id,
      action: auditLog.action,
      userId: auditLog.userId,
      username: users.username,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      details: auditLog.details,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, sql`${users.id}::text = ${auditLog.userId}`)
    .where(and(
      eq(auditLog.workspaceId, workspaceId),
      opts.before ? lt(auditLog.createdAt, opts.before) : undefined,
    ))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
  return rows;
}

/**
 * The spaces `userId` is the only owner of — what `assertDeletable` refuses
 * a user deletion over (I9).
 */
export async function spacesSolelyOwnedBy(userId: string): Promise<Array<{ id: string; name: string }>> {
  if (!isUuid(userId)) return [];
  const { rows } = await queryRaw(
    `SELECT w.id, w.name FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.role = 'owner' AND w.kind = 'shared'
       AND NOT EXISTS (SELECT 1 FROM workspace_members o
                       WHERE o.workspace_id = m.workspace_id AND o.role = 'owner' AND o.user_id <> $1)
     ORDER BY w.name`,
    [userId],
  );
  return rows.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }));
}
