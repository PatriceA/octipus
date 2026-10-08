/**
 * Remote member rows (docs/plans/federation-spec.md §6.2, F-D6, FI1).
 *
 * A member of a space here who lives on another install is a `users` row
 * with `kind = 'remote'` (migration 0135): a `~name@<fp8>` username, no
 * email, no password, never an admin, bound to the install that redeemed
 * the invite (`remote_instance_id`) and that install's user id
 * (`remote_user_ref`). `upsertRemoteMember` is the only writer of such a
 * row — a source test fails on any other — and runs only inside the
 * transaction that redeems an invite.
 *
 * `resolveVisitor` is the other half of FI1: a frame's `as` (the member
 * handle) is acted on only for a remote row bound to the link's verified
 * instance, while that instance is `active` and this install hosts.
 * Anything else — another install's member, an unknown handle, a blocked
 * install — reads as the same `null`, answered `not_found`.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/core/spaces/service';
import { getDb } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { federationInstances } from '@/db/schema/federation';
import { workspaceMembers, workspaces } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';
import { REMOTE_USERNAME_PREFIX } from '@/security/user-kinds';
import { shortInstanceLabel } from './identity';
import { federationHosts } from './mode';

/** A remote member as the host operations see it. */
export interface RemoteMember {
  userId: string;
  /** Its username, `~name@<fp8>`: what the visitor install names it by (`as`). */
  handle: string;
  instanceId: string;
}

const NAME_MAX = 32;

/** The name part of a handle: lower-case letters, digits and dashes, from the visitor's display name. */
function handleName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/, '');
  return slug || 'member';
}

/**
 * The remote row of `ref` on install `instanceId`, created on its first
 * join: username `~<slug(name)>@<instanceId[:8]>`, with a numeric suffix
 * (`~anna-2@…`) when that is taken. An existing row keeps its handle (the
 * visitor's display name may change; the handle it is addressed by does
 * not). Runs in the caller's transaction (the invite redemption).
 */
export async function upsertRemoteMember(tx: Tx, instanceId: string, ref: string, name: string): Promise<RemoteMember> {
  const [existing] = await tx
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(and(eq(users.kind, 'remote'), eq(users.remoteInstanceId, instanceId), eq(users.remoteUserRef, ref)))
    .for('update')
    .limit(1);
  if (existing) return { userId: existing.id, handle: existing.username, instanceId };

  const base = handleName(name);
  const host = shortInstanceLabel(instanceId);
  for (let n = 1; n < 1000; n++) {
    const username = `${REMOTE_USERNAME_PREFIX}${n === 1 ? base : `${base}-${n}`}@${host}`;
    const [created] = await tx
      .insert(users)
      .values({
        username,
        kind: 'remote',
        remoteInstanceId: instanceId,
        remoteUserRef: ref,
        email: null,
        passwordHash: null,
        isAdmin: false,
        // A remote row never runs on this install's models (`install-access.ts` refuses it too).
        installModels: false,
      })
      .onConflictDoNothing()
      .returning({ id: users.id, username: users.username });
    if (created) return { userId: created.id, handle: created.username, instanceId };
    // The conflict may be the (instance, ref) pair itself: a concurrent join of the same user.
    const [raced] = await tx
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(and(eq(users.kind, 'remote'), eq(users.remoteInstanceId, instanceId), eq(users.remoteUserRef, ref)))
      .limit(1);
    if (raced) return { userId: raced.id, handle: raced.username, instanceId };
  }
  throw new Error(`No free handle for ${base}@${host}`);
}

/**
 * The remote member a frame's `as` names on a link from `instanceId` (FI1):
 * the row with that handle bound to that instance, while the instance is
 * `active` and this install hosts. Null otherwise — the caller answers a
 * uniform `not_found`.
 */
export async function resolveVisitor(instanceId: string, handle: string | undefined): Promise<RemoteMember | null> {
  if (!handle || !handle.startsWith(REMOTE_USERNAME_PREFIX) || !federationHosts()) return null;
  const [row] = await getDb()
    .select({ id: users.id, username: users.username })
    .from(users)
    .innerJoin(federationInstances, eq(federationInstances.instanceId, users.remoteInstanceId))
    .where(and(
      eq(users.username, handle),
      eq(users.kind, 'remote'),
      eq(users.remoteInstanceId, instanceId),
      eq(users.isActive, true),
      eq(federationInstances.status, 'active'),
    ))
    .limit(1);
  return row ? { userId: row.id, handle: row.username, instanceId } : null;
}

/** How many memberships of shared spaces the remote rows of `instanceId` hold here (the cap of §6.2). */
export async function liveMembershipsOf(instanceId: string, db: Tx | ReturnType<typeof getDb> = getDb()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(users.kind, 'remote'), eq(users.remoteInstanceId, instanceId), eq(workspaces.kind, 'shared')));
  return Number(row?.n ?? 0);
}

/** The spaces `userId` (a remote row) is a member of, whatever their install's state. */
export async function spacesOfRemote(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, 'shared')));
  return rows.map((r) => r.id);
}

/** The remote rows of install `instanceId`, with their handles. */
export async function remoteMembersOf(instanceId: string): Promise<RemoteMember[]> {
  const rows = await getDb()
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(and(eq(users.kind, 'remote'), eq(users.remoteInstanceId, instanceId)));
  return rows.map((r) => ({ userId: r.id, handle: r.username, instanceId }));
}

/** The remote row `userId`, or null for a local account (or no row). */
export async function remoteMemberById(userId: string): Promise<RemoteMember | null> {
  if (!isUuid(userId)) return null;
  const [row] = await getDb()
    .select({ id: users.id, username: users.username, instanceId: users.remoteInstanceId })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.kind, 'remote')))
    .limit(1);
  return row?.instanceId ? { userId: row.id, handle: row.username, instanceId: row.instanceId } : null;
}
