/**
 * What a change of who may enter a room does at once (docs/plans/coworking-spec.md
 * §6.6, I5).
 *
 * `onRoomAccessChanged(roomId)` runs after a private room's member is
 * removed or its visibility changed — the room's counterpart of
 * `onMembershipChanged`. For every person who had a hold on the room
 * (a subscribed connection, a queued or running turn, a pending request) and
 * has no access now, it:
 *
 *   - prunes their subscriptions to the room and sends each pruned
 *     connection `room.removed`;
 *   - drops their queued turns there and stops their running one;
 *   - expires their pending permission and approval requests raised there.
 *
 * `onRoomsMembershipChanged(workspaceId, userId)` does the same for every
 * room of a space when the user's membership of the space changed, and
 * prunes their space subscription when they left the space; the space's
 * `onMembershipChanged` calls it.
 *
 * Each step runs even when another fails; failures are logged and thrown
 * together at the end.
 */
import { getGatewayHub } from '@/core/gateway/hub';
import type { ConnectionContext } from '@/core/gateway/protocol';
import { coreLogger } from '@/utils/logger';
import { roomAccess } from './access';
import { eventMessage, roomResource, spaceResource } from './events';
import { publishRoomPresence, publishSpacePresence, setPresenceWhere } from './presence';
import { activeRoomsIn, dropRoomTurnsOf, roomQueueSnapshot } from './queue';

const REMOVED = 'You no longer have access to this room.';

function connectionsWith(resource: string): ConnectionContext[] {
  return getGatewayHub().connectionManager.getActiveConnections().filter((ctx) => ctx.resources.has(resource));
}

/**
 * Remove `ctx` from the room's resource and tell it so. A connection shown
 * "in" the room in `space.presence` is no longer (I3: the room's members
 * must not keep seeing someone who cannot enter it there).
 */
export function pruneRoomSubscription(ctx: ConnectionContext, roomId: string, reason = REMOVED): void {
  const resource = roomResource(roomId);
  if (!ctx.resources.delete(resource)) return;
  const where = ctx.metadata.presenceWhere as { kind?: string; id?: string; spaceId?: string | null } | undefined;
  if (where?.kind === 'room' && where.id === roomId) setPresenceWhere(ctx, where.spaceId ?? null, null);
  getGatewayHub().connectionManager.sendToConnection(ctx.connectionId, eventMessage('room.removed', { roomId, reason }, roomId));
}

/** The people with a hold on the room: subscribers, queued and running requesters, pending requests. */
async function peopleIn(roomId: string): Promise<Set<string>> {
  const people = new Set(connectionsWith(roomResource(roomId)).map((ctx) => ctx.userId));
  const queue = roomQueueSnapshot(roomId);
  if (queue.running) people.add(queue.running.requesterId);
  for (const q of queue.queued) people.add(q.requesterId);
  const [{ getAgentService }, { getDb }, { permissionRequests }, { and, eq }] = await Promise.all([
    import('@/core/agent'), import('@/db/postgres'), import('@/db/schema/permissions'), import('drizzle-orm'),
  ]);
  for (const approval of getAgentService().getPendingApprovals()) if (approval.sessionId === roomId) people.add(approval.userId);
  const pending = await getDb().select({ userId: permissionRequests.userId }).from(permissionRequests)
    .where(and(eq(permissionRequests.sessionId, roomId), eq(permissionRequests.status, 'pending')));
  for (const row of pending) people.add(row.userId);
  return people;
}

/** End `userId`'s hold on the room: subscriptions, turns, pending requests. */
async function evict(roomId: string, userId: string, failed: string[]): Promise<void> {
  const steps: Array<[string, () => Promise<unknown> | unknown]> = [
    ['prune subscriptions', () => {
      for (const ctx of connectionsWith(roomResource(roomId))) if (ctx.userId === userId) pruneRoomSubscription(ctx, roomId);
    }],
    ['stop turns', () => dropRoomTurnsOf(roomId, userId)],
    ['expire permission requests', async () => {
      const { getPermissionManager } = await import('@/security/permissions');
      return getPermissionManager().expireForUserInSession(userId, roomId);
    }],
    ['expire approvals', async () => {
      const { getAgentService } = await import('@/core/agent');
      return getAgentService().expireApprovalsForUser(userId, REMOVED, new Set([roomId]));
    }],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      coreLogger.error({ err, roomId, userId, step: name }, 'Room access change step failed');
      failed.push(`${name} (${userId})`);
    }
  }
}

/** A private room's member was removed, or the room's visibility changed. Throws (after every step) when a step failed. */
export async function onRoomAccessChanged(roomId: string): Promise<void> {
  const failed: string[] = [];
  for (const userId of await peopleIn(roomId)) {
    if (await roomAccess(userId, roomId)) continue;
    await evict(roomId, userId, failed);
  }
  await publishRoomPresence(roomId).catch((err: unknown) => coreLogger.error({ err, roomId }, 'Room presence publish failed'));
  if (failed.length > 0) throw new Error(`Room access change: ${failed.join(', ')} failed`);
}

/**
 * `userId`'s membership of `workspaceId` changed (removed, downgraded,
 * scope changed): every room of the space they may no longer enter loses
 * their hold, and a removed member's space subscription ends. Throws (after
 * every step) when a step failed.
 */
export async function onRoomsMembershipChanged(workspaceId: string, userId: string): Promise<void> {
  const failed: string[] = [];
  const { roomIdsOf } = await import('./service');
  const rooms = new Set([...activeRoomsIn(workspaceId), ...(await roomIdsOf(workspaceId))]);
  const subscribed = new Set<string>();
  for (const ctx of getGatewayHub().connectionManager.getActiveConnections()) {
    if (ctx.userId !== userId) continue;
    for (const resource of ctx.resources) if (resource.startsWith('room:')) subscribed.add(resource.slice('room:'.length));
  }
  for (const roomId of rooms) {
    if (await roomAccess(userId, roomId)) continue;
    await evict(roomId, userId, failed);
    if (subscribed.has(roomId)) await publishRoomPresence(roomId).catch((err: unknown) => coreLogger.error({ err, roomId }, 'Room presence publish failed'));
  }
  try {
    const { getMembership } = await import('@/core/spaces/service');
    if (!(await getMembership(userId, workspaceId))) {
      for (const ctx of connectionsWith(spaceResource(workspaceId))) if (ctx.userId === userId) ctx.resources.delete(spaceResource(workspaceId));
    }
    await publishSpacePresence(workspaceId);
  } catch (err) {
    coreLogger.error({ err, workspaceId, userId }, 'Space subscription prune failed');
    failed.push('prune space subscription');
  }
  if (failed.length > 0) throw new Error(`Rooms after a membership change: ${failed.join(', ')} failed`);
}
