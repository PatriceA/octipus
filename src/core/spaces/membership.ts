/**
 * What a membership change does at once (docs/plans/coworking-spec.md §5.9,
 * I5): removal and downgrade take effect on the next request, the next tool
 * decision and the next socket frame — and running work of that member in
 * the space stops now.
 *
 * - `membershipVersion` is the in-process counter (D5, D16) that paths too
 *   hot to read the database on every event (document updates, S3) compare
 *   against; every change bumps it.
 * - `onMembershipChanged` runs for a removal, a downgrade or a guest scope
 *   change: stops the member's agents in the space, cancels their queued
 *   background jobs there (learning checks, document processing), expires
 *   their pending permission and approval requests there, and pauses the
 *   data sources they own on the space's artifacts; their live documents
 *   follow the new role (dropped when they may no longer read, read-only
 *   when they may no longer write) and their file leases go when they may
 *   no longer write (S3); in rooms (S2) it drops their queued and running
 *   room turns, prunes their room and space subscriptions and expires their
 *   requests there (`onRoomsMembershipChanged`); a group channel they bound
 *   to the space is unbound when they are no longer one of its owners
 *   (`endBindingsOfFormerOwner`, §9.4).
 * - `onMembershipGranted` runs for a join or an upgrade: bumps the version
 *   and resumes the member's data sources if they may write again.
 * - `freezeSpace` runs for an archive: every agent of the space stops, its
 *   queued jobs are cancelled and every pending request in it expires, so
 *   nothing writes into a read-only space (or races its purge).
 *
 * Each step runs even when another fails; failures are logged and thrown
 * together at the end, so the caller (and the person) hears about them.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { artifactDataSources } from '@/db/schema/artifact-data-sources';
import { artifacts } from '@/db/schema/artifacts';
import { backgroundJobs } from '@/db/schema/background-jobs';
import { sessions } from '@/db/schema/sessions';
import { workspaceMembers, workspaces } from '@/db/schema/organizations';
import { can } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { getMembership, writeSpaceAudit } from './service';

const versions = new Map<string, number>();
const versionKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;

/** The in-process version of `userId`'s membership of `workspaceId`; changes on every membership change. */
export function membershipVersion(workspaceId: string, userId: string): number {
  return versions.get(versionKey(workspaceId, userId)) ?? 0;
}

function bumpVersion(workspaceId: string, userId: string): void {
  const key = versionKey(workspaceId, userId);
  versions.set(key, (versions.get(key) ?? 0) + 1);
}

/** Why a data source is paused when its principal lost write access to the space. */
export const MEMBERSHIP_PAUSE_REASON = 'membership';

const REMOVED_MESSAGE = 'Your access to this space changed.';

async function runSteps(
  what: string,
  context: Record<string, unknown>,
  steps: Array<[string, () => Promise<unknown> | unknown]>,
): Promise<void> {
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      coreLogger.error({ err, ...context, step: name }, `${what} step failed`);
      failed.push(name);
    }
  }
  if (failed.length > 0) throw new Error(`${what}: ${failed.join(', ')} failed`);
}

/**
 * Cancel the space's queued background jobs — `userId`'s only, when given.
 * A queued job has not begun, so cancelling it loses nothing; a running one
 * is past this point and finishes (its writes go through the space door,
 * which refuses a removed member or an archived space). Returns how many.
 */
export async function cancelQueuedJobs(workspaceId: string, userId?: string): Promise<number> {
  const cancelled = await getDb()
    .update(backgroundJobs)
    .set({ status: 'cancelled', error: 'Space access changed before the job started', finishedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(backgroundJobs.workspaceId, workspaceId),
      eq(backgroundJobs.status, 'queued'),
      userId === undefined ? undefined : eq(backgroundJobs.userId, userId),
    ))
    .returning({ id: backgroundJobs.id });
  if (cancelled.length > 0) coreLogger.info({ workspaceId, userId, count: cancelled.length }, 'Queued space jobs cancelled');
  return cancelled.length;
}

/**
 * Session ids where `userId` may hold requests in `workspaceId`: their
 * private chats there, and every room of the space (a room turn runs as its
 * requester, whoever created the room).
 */
async function sessionIdsIn(workspaceId: string, userId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), or(eq(sessions.userId, userId), eq(sessions.kind, 'room'))));
  return new Set(rows.map((r) => r.id));
}

/**
 * Pause the data sources `userId` owns on the space's artifacts when they may
 * no longer write there; resume the ones this module paused when they may.
 * Returns how many rows changed.
 */
export async function syncDataSources(workspaceId: string, userId: string): Promise<number> {
  const membership = await getMembership(userId, workspaceId);
  const mayWrite = can(membership?.role, 'write');
  const inSpace = inArray(
    artifactDataSources.artifactId,
    getDb().select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId)),
  );
  const owned = and(eq(artifactDataSources.principalId, userId), inSpace);
  const changed = mayWrite
    ? await getDb()
      .update(artifactDataSources)
      .set({ pausedAt: null, pausedReason: null, updatedAt: new Date() })
      .where(and(owned, isNotNull(artifactDataSources.pausedAt), eq(artifactDataSources.pausedReason, MEMBERSHIP_PAUSE_REASON)))
      .returning({ id: artifactDataSources.id })
    : await getDb()
      .update(artifactDataSources)
      .set({ pausedAt: sql`now()`, pausedReason: MEMBERSHIP_PAUSE_REASON, updatedAt: new Date() })
      .where(and(owned, isNull(artifactDataSources.pausedAt)))
      .returning({ id: artifactDataSources.id });
  if (changed.length > 0) {
    coreLogger.info({ workspaceId, userId, count: changed.length, paused: !mayWrite }, 'Space data sources follow a membership change');
  }
  return changed.length;
}

/**
 * A member was removed from `workspaceId`, downgraded, or had their guest
 * scope changed. Throws (after running every step) when a step failed.
 */
export async function onMembershipChanged(workspaceId: string, userId: string): Promise<void> {
  bumpVersion(workspaceId, userId);
  const { getAgentManager } = await import('@/core/agent-manager');
  const { getPermissionManager } = await import('@/security/permissions');
  const { getAgentService } = await import('@/core/agent');
  await runSteps('Membership change', { workspaceId, userId }, [
    ['stop agents', () => getAgentManager().stopWorkspace(workspaceId, userId)],
    ['cancel queued jobs', () => cancelQueuedJobs(workspaceId, userId)],
    ['expire permission requests', () => getPermissionManager().expireForUserInWorkspace(userId, workspaceId)],
    ['expire approvals', async () => getAgentService().expireApprovalsForUser(userId, REMOVED_MESSAGE, await sessionIdsIn(workspaceId, userId))],
    ['pause data sources', () => syncDataSources(workspaceId, userId)],
    ['rooms', async () => {
      const { onRoomsMembershipChanged } = await import('@/core/rooms/membership');
      await onRoomsMembershipChanged(workspaceId, userId);
    }],
    ['live documents', async () => {
      const { getDocHub } = await import('@/core/docs');
      await getDocHub().membershipChanged(workspaceId, userId);
    }],
    ['group channels', async () => {
      const { endBindingsOfFormerOwner } = await import('@/channels/group-bridge');
      await endBindingsOfFormerOwner(workspaceId, userId);
    }],
    ['file leases', async () => {
      const membership = await getMembership(userId, workspaceId);
      if (can(membership?.role, 'write')) return;
      const { dropMemberLeases } = await import('@/core/docs/file-leases');
      await dropMemberLeases(workspaceId, userId);
    }],
  ]);
}

/** The shared workspaces `userId` holds a membership row in, whatever their account's state. */
async function spacesOf(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, 'shared')));
  return rows.map((r) => r.id);
}

/**
 * `userId`'s account was deactivated (§4.1): they pass no space door any
 * more (`getMembership`), and what they left running or waiting stops now —
 * their queued and running room turns everywhere, their queued background
 * jobs and their data sources in every space; and in every space they
 * sponsor, the sponsored work (an inactive sponsor is no sponsor:
 * `spaceFunding`), with an audit row. Their rows stay: a reactivation
 * resumes (`onAccountReactivated`). Throws (after every step) when a step
 * failed.
 */
export async function onAccountDeactivated(userId: string, by: { actorId: string; source: string }): Promise<void> {
  const spaces = await spacesOf(userId);
  for (const workspaceId of spaces) bumpVersion(workspaceId, userId);
  const sponsored = await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.sponsorUserId, userId), eq(workspaces.kind, 'shared')));
  await runSteps('Account deactivation', { userId }, [
    ['room turns', async () => {
      const { dropAllRoomTurnsOf } = await import('@/core/rooms/queue');
      await dropAllRoomTurnsOf(userId);
    }],
    ['cancel queued jobs', async () => {
      for (const workspaceId of spaces) await cancelQueuedJobs(workspaceId, userId);
    }],
    ['pause data sources', async () => {
      for (const workspaceId of spaces) await syncDataSources(workspaceId, userId);
    }],
    ['pause sponsored work', async () => {
      const { pauseSponsoredWork } = await import('./funding');
      for (const { id: workspaceId } of sponsored) {
        await pauseSponsoredWork(workspaceId);
        await writeSpaceAudit(getDb(), {
          actorId: by.actorId,
          action: 'space_updated',
          workspaceId,
          details: { field: 'funding', reason: 'sponsor_deactivated', sponsor: userId, source: by.source },
        });
      }
    }],
  ]);
}

/** `userId`'s account was re-activated: the data sources a deactivation paused resume. */
export async function onAccountReactivated(userId: string): Promise<void> {
  for (const workspaceId of await spacesOf(userId)) {
    bumpVersion(workspaceId, userId);
    await syncDataSources(workspaceId, userId);
  }
}

/** A member joined `workspaceId` or was upgraded. */
export async function onMembershipGranted(workspaceId: string, userId: string): Promise<void> {
  bumpVersion(workspaceId, userId);
  await syncDataSources(workspaceId, userId);
  const { getDocHub } = await import('@/core/docs');
  await getDocHub().membershipChanged(workspaceId, userId);
}

/** Stop every agent running in the space. Returns how many were stopped. */
export async function stopSpaceAgents(workspaceId: string): Promise<number> {
  const { getAgentManager } = await import('@/core/agent-manager');
  const stopped = getAgentManager().stopWorkspace(workspaceId);
  if (stopped > 0) coreLogger.info({ workspaceId, stopped }, 'Space agents stopped');
  return stopped;
}

const ARCHIVED_MESSAGE = 'This space was archived.';

/**
 * The space was archived (§5.3): stop its agents, cancel its queued jobs,
 * and expire every pending permission and approval request raised in it —
 * by any member, or anyone who had a chat there. Throws (after running every
 * step) when a step failed.
 */
export async function freezeSpace(workspaceId: string): Promise<void> {
  const { getPermissionManager } = await import('@/security/permissions');
  const { getAgentService } = await import('@/core/agent');
  const people = async (): Promise<string[]> => {
    const db = getDb();
    const members = await db.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    const chatters = await db.selectDistinct({ id: sessions.userId }).from(sessions).where(eq(sessions.workspaceId, workspaceId));
    return [...new Set([...members, ...chatters].map((r) => r.id))];
  };
  await runSteps('Space archive', { workspaceId }, [
    ['clear room queues', async () => {
      const { activeRoomsIn, clearRoomQueue } = await import('@/core/rooms/queue');
      for (const roomId of activeRoomsIn(workspaceId)) clearRoomQueue(roomId);
    }],
    ['stop agents', () => stopSpaceAgents(workspaceId)],
    ['cancel queued jobs', () => cancelQueuedJobs(workspaceId)],
    ['live documents read only', async () => {
      const { getDocHub } = await import('@/core/docs');
      await getDocHub().setSpaceArchived(workspaceId, true);
    }],
    ['expire requests', async () => {
      for (const userId of await people()) {
        await getPermissionManager().expireForUserInWorkspace(userId, workspaceId);
        await getAgentService().expireApprovalsForUser(userId, ARCHIVED_MESSAGE, await sessionIdsIn(workspaceId, userId));
      }
    }],
  ]);
}

/**
 * Run the follow-up of a committed membership or archive change. The change
 * itself stands whatever happens here, so a failure is logged and returned
 * (the route reports it in a 200) instead of turning the committed change
 * into a 500 the client would retry against a member who is already gone.
 */
export async function settleFollowUp(what: string, context: Record<string, unknown>, run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    coreLogger.error({ err, ...context }, `${what}: follow-up failed; the change itself is committed`);
    return err instanceof Error ? err.message : String(err);
  }
}

/** Test hook. */
export function _resetMembershipVersionsForTests(): void {
  versions.clear();
}
