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
import { and, count, desc, eq, lt, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb, queryRaw } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { type AuditDetails, auditLog } from '@/db/schema/audit';
import { type SpaceRole, type Workspace, workspaceMembers, workspaces } from '@/db/schema/organizations';
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
import { onMembershipChanged, onMembershipGranted, stopSpaceAgents } from './membership';

export { can, SpaceError, type SpaceMembership } from '@/security/space-access';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/** Whoever performs a space operation. Rights are read from the database, never from here. */
export interface SpaceActor {
  readonly userId: string;
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
    details: entry.details ?? {},
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
 */
export async function getMembership(
  userId: string,
  workspaceId: string,
  db: Executor = getDb(),
): Promise<SpaceMembership | null> {
  if (!isUuid(userId) || !isUuid(workspaceId)) return null;
  const [row] = await db
    .select({ role: workspaceMembers.role, scope: workspaceMembers.scope })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaces.kind, 'shared'),
    ))
    .limit(1);
  if (!row) return null;
  // The synchronous file-root lookups (`WorkspaceFS.forAgent` / `forSession`)
  // learn the space from here: every path into a space reads a membership.
  noteSharedWorkspace(workspaceId);
  return { workspaceId, userId, role: row.role, scope: row.scope ?? null };
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

/** The actor's membership with the action allowed, and the space row. */
async function authorize(
  actor: SpaceActor,
  workspaceId: string,
  action: Parameters<typeof can>[1],
  db: Executor = getDb(),
): Promise<{ membership: SpaceMembership; space: Workspace }> {
  const membership = requireCan(await getMembership(actor.userId, workspaceId, db), action);
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
      .values({
        kind: 'shared',
        userId: null,
        createdBy: actor.userId,
        // Spaces have no owner namespace; the slug is only a handle.
        slug: `space-${generateToken(6)}`,
        name,
        isDefault: false,
      })
      .returning();
    await tx.insert(workspaceMembers).values({ workspaceId: created.id, userId: actor.userId, role: 'owner' });
    await writeSpaceAudit(tx, { actorId: actor.userId, action: 'space_created', workspaceId: created.id, details: { name } });
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
      actorId: actor.userId,
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
    await writeSpaceAudit(tx, { actorId: actor.userId, action: 'space_archived', workspaceId, details: { archived: true } });
    return { summary: summarize(updated, membership.role, await memberCount(workspaceId, tx)), changed: true };
  });
  if (result.changed) await stopSpaceAgents(workspaceId);
  return result.summary;
}

export async function unarchiveSpace(actor: SpaceActor, workspaceId: string): Promise<SpaceSummary> {
  return getDb().transaction(async (tx) => {
    const { membership, space } = await authorize(actor, workspaceId, 'manage_space', tx);
    if (!space.archivedAt) return summarize(space, membership.role, await memberCount(workspaceId, tx));
    const [updated] = await tx
      .update(workspaces)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    await writeSpaceAudit(tx, { actorId: actor.userId, action: 'space_updated', workspaceId, details: { archived: false } });
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
): Promise<SpaceMemberView> {
  if (!isSpaceRole(input.role)) throw new SpaceError('invalid_role', `Unknown role: ${input.role}`);
  const role = input.role;
  if (input.scope != null && role !== 'guest') {
    throw new SpaceError('invalid_input', 'Only a guest has a scope');
  }
  const scope = role === 'guest' ? (input.scope ?? null) : null;

  const outcome = await getDb().transaction(async (tx) => {
    await authorize(actor, workspaceId, 'manage_members', tx);
    const target = await getMembership(targetUserId, workspaceId, tx);
    if (!target) throw new SpaceError('not_found', 'Member not found');
    if (target.role === 'owner' && role !== 'owner') await assertNotLastOwner(tx, workspaceId, targetUserId);
    const [updated] = await tx
      .update(workspaceMembers)
      .set({ role, scope })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .returning();
    const scopeChanged = JSON.stringify(target.scope ?? null) !== JSON.stringify(scope);
    if (target.role !== role || scopeChanged) {
      await writeSpaceAudit(tx, {
        actorId: actor.userId,
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
  if (outcome.revoked) await onMembershipChanged(workspaceId, targetUserId);
  else if (outcome.granted) await onMembershipGranted(workspaceId, targetUserId);
  return outcome.view;
}

/**
 * Remove a member (owner only). Removing oneself is leaving. The last owner
 * can do neither.
 */
export async function removeMember(actor: SpaceActor, workspaceId: string, targetUserId: string): Promise<void> {
  if (targetUserId === actor.userId) return leaveSpace(actor, workspaceId);
  await getDb().transaction(async (tx) => {
    await authorize(actor, workspaceId, 'manage_members', tx);
    const target = await getMembership(targetUserId, workspaceId, tx);
    if (!target) throw new SpaceError('not_found', 'Member not found');
    if (target.role === 'owner') await assertNotLastOwner(tx, workspaceId, targetUserId);
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)));
    await writeSpaceAudit(tx, {
      actorId: actor.userId,
      action: 'space_member_removed',
      workspaceId,
      resourceType: 'space_member',
      resourceId: targetUserId,
      details: { previousValue: target.role },
    });
  });
  securityLogger.info({ workspaceId, userId: targetUserId, by: actor.userId }, 'Space member removed');
  await onMembershipChanged(workspaceId, targetUserId);
}

/** Leave a space. The last owner cannot. */
export async function leaveSpace(actor: SpaceActor, workspaceId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const membership = await getMembership(actor.userId, workspaceId, tx);
    if (!membership) throw new SpaceError('not_found', 'Space not found');
    if (membership.role === 'owner') await assertNotLastOwner(tx, workspaceId, actor.userId);
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actor.userId)));
    await writeSpaceAudit(tx, {
      actorId: actor.userId,
      action: 'space_member_removed',
      workspaceId,
      resourceType: 'space_member',
      resourceId: actor.userId,
      details: { previousValue: membership.role, left: true },
    });
  });
  await onMembershipChanged(workspaceId, actor.userId);
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
