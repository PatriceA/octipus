/**
 * Space invites (docs/plans/coworking-spec.md §5.3, I8).
 *
 * An invite is a bearer secret: the raw token leaves the server once, in the
 * create response, and only `sha256(token)` is stored. A use is taken by one
 * conditional UPDATE (not revoked, not expired, uses left), so two people
 * racing for a single-use link cannot both get in. Expiry is clamped to
 * `[1, spaces.inviteMaxTtlHours]` hours; `owner` is never invitable. Revoking
 * is scoped to the invite's own space.
 *
 * Delivery is a link (`/join/<token>`); the install has no mail transport.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { type InvitableSpaceRole, workspaceInvites, workspaceMembers, workspaces } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';
import { can, type GuestScope, isInvitableRole, requireCan, SPACE_ROLES, SpaceError } from '@/security/space-access';
import { generateToken, sha256 } from '@/utils/crypto';
import { securityLogger } from '@/utils/logger';
import { onMembershipGranted } from './membership';
import { addMemberInTx, auditActor, getMembership, guestScopeForWrite, type SpaceActor, type Tx, writeSpaceAudit } from './service';

/** The roles that may hand out invites: an invite is good only while its creator still holds one. */
const INVITING_ROLES = SPACE_ROLES.filter((r) => can(r, 'manage_invites'));

/**
 * The invite's creator still may invite: removing, demoting or losing an
 * owner ends their links (I5), even one not revoked yet.
 */
function creatorMayInvite() {
  return sql`EXISTS (SELECT 1 FROM ${workspaceMembers} m
    WHERE m.workspace_id = ${workspaceInvites.workspaceId}
      AND m.user_id = ${workspaceInvites.createdBy}
      AND m.role IN (${sql.join(INVITING_ROLES.map((r) => sql`${r}`), sql`, `)}))`;
}

/** Default lifetime of an invite when the owner names none (then clamped like any other). */
export const DEFAULT_INVITE_TTL_HOURS = 7 * 24;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface CreatedInvite {
  id: string;
  /** The raw token. Returned here only; never stored. */
  token: string;
  role: InvitableSpaceRole;
  expiresAt: Date;
  maxUses: number;
}

/** Clamp a requested lifetime to `[1, spaces.inviteMaxTtlHours]` hours. */
export function clampInviteTtlHours(requested: number | undefined): number {
  const max = getConfig().spaces.inviteMaxTtlHours;
  const hours = requested ?? DEFAULT_INVITE_TTL_HOURS;
  if (!Number.isFinite(hours)) throw new SpaceError('invalid_input', 'expiresInHours must be a number');
  return Math.min(Math.max(hours, 1), max);
}

/** Create an invite link (owner only). */
export async function createInvite(
  actor: SpaceActor,
  workspaceId: string,
  input: { role: string; scope?: unknown; expiresInHours?: number; maxUses?: number },
): Promise<CreatedInvite> {
  if (!isInvitableRole(input.role)) {
    throw new SpaceError('invalid_role', input.role === 'owner' ? 'Owners cannot be invited; promote a member instead' : `Unknown role: ${input.role}`);
  }
  const role = input.role;
  if (input.scope != null && role !== 'guest') throw new SpaceError('invalid_input', 'Only a guest invite has a scope');
  const maxUses = input.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
    throw new SpaceError('invalid_input', 'maxUses must be an integer between 1 and 100');
  }
  const hours = clampInviteTtlHours(input.expiresInHours);
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + hours * 3600_000);

  const invite = await getDb().transaction(async (tx) => {
    requireCan(await getMembership(actor.userId, workspaceId, tx, { lock: 'share' }), 'manage_invites');
    const [space] = await tx.select({ archivedAt: workspaces.archivedAt }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (space?.archivedAt) throw new SpaceError('archived', 'This space is archived');
    // A guest invite carries the scope the guest joins with (validated: shape, rooms of this space).
    const scope = role === 'guest' ? await guestScopeForWrite(tx, workspaceId, input.scope ?? null) : null;
    const [row] = await tx
      .insert(workspaceInvites)
      .values({
        workspaceId,
        role,
        scope,
        tokenHash: sha256(token),
        createdBy: actor.userId,
        expiresAt,
        maxUses,
      })
      .returning();
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_invite_created',
      workspaceId,
      resourceType: 'space_invite',
      resourceId: row.id,
      details: { role, expiresAt: expiresAt.toISOString(), maxUses, ...(scope ? { scope } : {}) },
    });
    return row;
  });
  return { id: invite.id, token, role, expiresAt: invite.expiresAt, maxUses: invite.maxUses };
}

export interface InvitePreview {
  spaceName: string;
  inviterName: string | null;
  role: InvitableSpaceRole;
  expiresAt: Date;
}

/**
 * What a token invites to — no member list, no content — or null when it is
 * unknown, revoked, expired, used up, or its space is archived.
 */
export async function previewInvite(token: string): Promise<InvitePreview | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [row] = await getDb()
    .select({
      spaceName: workspaces.name,
      inviterName: users.username,
      role: workspaceInvites.role,
      expiresAt: workspaceInvites.expiresAt,
    })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
    .leftJoin(users, eq(users.id, workspaceInvites.createdBy))
    .where(and(
      eq(workspaceInvites.tokenHash, sha256(token)),
      isNull(workspaceInvites.revokedAt),
      sql`${workspaceInvites.expiresAt} > now()`,
      sql`${workspaceInvites.useCount} < ${workspaceInvites.maxUses}`,
      eq(workspaces.kind, 'shared'),
      isNull(workspaces.archivedAt),
      creatorMayInvite(),
    ))
    .limit(1);
  return row ?? null;
}

export interface AcceptedInvite {
  workspaceId: string;
  role: InvitableSpaceRole | 'owner';
  /** The actor already was a member: their role is kept and the use refunded. */
  alreadyMember: boolean;
}

/**
 * Join the space an invite names. One conditional UPDATE takes a use; any
 * refusal after it (archived, full) rolls the transaction back, and an
 * existing member gets the use refunded.
 */
export async function acceptInvite(actor: SpaceActor, token: string): Promise<AcceptedInvite> {
  const result = await getDb().transaction((tx) => acceptInviteInTx(tx, actor, token));
  await afterInviteAccepted(actor, result);
  return result;
}

/**
 * `acceptInvite` inside the caller's transaction: the use is taken and the
 * membership written there, so they commit or roll back with the caller's
 * own writes (registration redeems an invite in the same transaction that
 * creates the user, S6). The caller runs `afterInviteAccepted` once it has
 * committed.
 */
export async function acceptInviteInTx(tx: Tx, actor: SpaceActor, token: string): Promise<AcceptedInvite> {
  if (!isUuid(actor.userId)) throw new SpaceError('not_found', 'Invite not found or expired');
  if (!TOKEN_PATTERN.test(token)) throw new SpaceError('not_found', 'Invite not found or expired');
  const tokenHash = sha256(token);
  const [taken] = await tx
    .update(workspaceInvites)
    .set({ useCount: sql`${workspaceInvites.useCount} + 1` })
    .where(and(
      eq(workspaceInvites.tokenHash, tokenHash),
      isNull(workspaceInvites.revokedAt),
      sql`${workspaceInvites.expiresAt} > now()`,
      sql`${workspaceInvites.useCount} < ${workspaceInvites.maxUses}`,
      creatorMayInvite(),
    ))
    .returning({
      id: workspaceInvites.id,
      workspaceId: workspaceInvites.workspaceId,
      role: workspaceInvites.role,
      scope: workspaceInvites.scope,
      createdBy: workspaceInvites.createdBy,
    });
  if (!taken) throw new SpaceError('not_found', 'Invite not found or expired');

  const added = await addMemberInTx(tx, taken.workspaceId, {
    userId: actor.userId,
    role: taken.role,
    scope: taken.scope,
    invitedBy: taken.createdBy,
  });
  if (!added) {
    // An existing member keeps their role; the use goes back.
    await tx
      .update(workspaceInvites)
      .set({ useCount: sql`${workspaceInvites.useCount} - 1` })
      .where(eq(workspaceInvites.id, taken.id));
    const existing = await getMembership(actor.userId, taken.workspaceId, tx);
    return { workspaceId: taken.workspaceId, role: existing?.role ?? taken.role, alreadyMember: true };
  }
  await writeSpaceAudit(tx, {
    ...auditActor(actor),
    action: 'space_invite_accepted',
    workspaceId: taken.workspaceId,
    resourceType: 'space_invite',
    resourceId: taken.id,
    details: { role: taken.role, invitedBy: taken.createdBy },
  });
  return { workspaceId: taken.workspaceId, role: taken.role, alreadyMember: false };
}

/** After an accepted invite committed: log it and run the membership follow-up (§5.9). */
export async function afterInviteAccepted(actor: SpaceActor, result: AcceptedInvite): Promise<void> {
  if (result.alreadyMember) return;
  securityLogger.info({ workspaceId: result.workspaceId, userId: actor.userId, role: result.role }, 'Space invite accepted');
  await onMembershipGranted(result.workspaceId, actor.userId);
}

/** Revoke an invite of this space (owner only). An id of another space is `not_found`. */
export async function revokeInvite(actor: SpaceActor, workspaceId: string, inviteId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    requireCan(await getMembership(actor.userId, workspaceId, tx, { lock: 'share' }), 'manage_invites');
    if (!isUuid(inviteId)) throw new SpaceError('not_found', 'Invite not found');
    const [row] = await tx
      .select({ id: workspaceInvites.id, revokedAt: workspaceInvites.revokedAt })
      .from(workspaceInvites)
      .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new SpaceError('not_found', 'Invite not found');
    if (row.revokedAt) return;
    await tx
      .update(workspaceInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, workspaceId)));
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_invite_revoked',
      workspaceId,
      resourceType: 'space_invite',
      resourceId: inviteId,
    });
  });
}

export interface InviteView {
  id: string;
  role: InvitableSpaceRole;
  scope: GuestScope | null;
  createdBy: string;
  createdByName: string | null;
  expiresAt: Date;
  maxUses: number;
  useCount: number;
  revokedAt: Date | null;
  createdAt: Date;
}

/** The space's invites, newest first (owner only). Never the token or its hash. */
export async function listInvites(actor: SpaceActor, workspaceId: string): Promise<InviteView[]> {
  requireCan(await getMembership(actor.userId, workspaceId), 'manage_invites');
  return getDb()
    .select({
      id: workspaceInvites.id,
      role: workspaceInvites.role,
      scope: workspaceInvites.scope,
      createdBy: workspaceInvites.createdBy,
      createdByName: users.username,
      expiresAt: workspaceInvites.expiresAt,
      maxUses: workspaceInvites.maxUses,
      useCount: workspaceInvites.useCount,
      revokedAt: workspaceInvites.revokedAt,
      createdAt: workspaceInvites.createdAt,
    })
    .from(workspaceInvites)
    .leftJoin(users, eq(users.id, workspaceInvites.createdBy))
    .where(eq(workspaceInvites.workspaceId, workspaceId))
    .orderBy(desc(workspaceInvites.createdAt));
}
