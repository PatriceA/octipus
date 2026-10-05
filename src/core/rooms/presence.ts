/**
 * Presence in rooms and spaces (docs/plans/coworking-spec.md §6.6) —
 * derived from the gateway connections themselves (D16: one process), never
 * stored.
 *
 * - `room.presence` — the members whose connections are subscribed to the
 *   room, sent to the room's resource.
 * - `space.presence` — the members online in the space (connections in the
 *   resource `space:<id>`, filled by `space.subscribe`), each with `where`
 *   they are: a room, or (S3) a note. A recipient sees a `where` only when
 *   they may access it themselves (I3): a private room they are not in is
 *   left out. Each recipient gets its own view.
 *
 * A connection's `where` is `ctx.metadata.presenceWhere`, set by the frame
 * that put it there (`room.subscribe`; `doc.join` in S3) through
 * `setPresenceWhere`. Kinds other than `room` are shown only through a check
 * registered with `registerPresenceWhereCheck` (S3 registers `note`).
 */
import { getGatewayHub } from '@/core/gateway/hub';
import type { ConnectionContext } from '@/core/gateway/protocol';
import { coreLogger } from '@/utils/logger';
import { accessToRoom, loadRoom } from './access';
import { eventMessage, publishRoomEvent, roomResource, spaceResource } from './events';

export interface PresenceWhere {
  kind: string;
  id: string;
}

type WhereCheck = (recipientUserId: string, spaceId: string, where: PresenceWhere) => Promise<boolean>;

const whereChecks = new Map<string, WhereCheck>([
  ['room', async (userId, spaceId, where) => {
    const room = await loadRoom(where.id);
    return !!room && room.workspaceId === spaceId && (await accessToRoom(userId, room)) !== null;
  }],
]);

/** Let another kind of `where` (S3: `note`) be shown, under its own access check. */
export function registerPresenceWhereCheck(kind: string, check: WhereCheck): void {
  whereChecks.set(kind, check);
}

const WHERE_KEY = 'presenceWhere';

/** Record where the connection is; null clears it. Republishes the space's presence. */
export function setPresenceWhere(ctx: ConnectionContext, spaceId: string | null, where: PresenceWhere | null): void {
  if (where) ctx.metadata[WHERE_KEY] = { ...where, spaceId };
  else delete ctx.metadata[WHERE_KEY];
  if (spaceId) void publishSpacePresence(spaceId);
}

function whereOf(ctx: ConnectionContext): (PresenceWhere & { spaceId: string | null }) | null {
  const w = ctx.metadata[WHERE_KEY] as (PresenceWhere & { spaceId: string | null }) | undefined;
  return w && typeof w.kind === 'string' && typeof w.id === 'string' ? w : null;
}

function connectionsIn(resource: string): ConnectionContext[] {
  return getGatewayHub().connectionManager.getActiveConnections().filter((ctx) => ctx.resources.has(resource));
}

async function names(userIds: string[]): Promise<Map<string, string>> {
  const { displayNames } = await import('@/core/session-history');
  return displayNames(userIds);
}

/** Send the room's current presence to its subscribers. */
export async function publishRoomPresence(roomId: string): Promise<void> {
  const users = [...new Set(connectionsIn(roomResource(roomId)).map((ctx) => ctx.userId))];
  const usernames = await names(users);
  publishRoomEvent(roomId, 'room.presence', {
    roomId,
    members: users.map((userId) => ({ userId, username: usernames.get(userId) ?? null })),
  });
}

/**
 * Send each connection in the space its own view of who is online and where.
 * Failures are logged (presence is advisory; the next change resends it).
 */
export async function publishSpacePresence(spaceId: string): Promise<void> {
  try {
    const conns = connectionsIn(spaceResource(spaceId));
    if (conns.length === 0) return;
    const online = new Map<string, PresenceWhere | null>();
    for (const ctx of conns) {
      const where = whereOf(ctx);
      const mine = where && where.spaceId === spaceId ? { kind: where.kind, id: where.id } : null;
      if (!online.has(ctx.userId) || mine) online.set(ctx.userId, mine ?? online.get(ctx.userId) ?? null);
    }
    const usernames = await names([...online.keys()]);
    const visible = new Map<string, boolean>();
    const hub = getGatewayHub();
    for (const recipient of conns) {
      const members: Array<{ userId: string; username: string | null; where?: PresenceWhere }> = [];
      for (const [userId, where] of online) {
        let shown: PresenceWhere | undefined;
        if (where) {
          const key = `${recipient.userId}:${where.kind}:${where.id}`;
          if (!visible.has(key)) {
            const check = whereChecks.get(where.kind);
            visible.set(key, check ? await check(recipient.userId, spaceId, where) : false);
          }
          if (visible.get(key)) shown = where;
        }
        members.push({ userId, username: usernames.get(userId) ?? null, ...(shown ? { where: shown } : {}) });
      }
      hub.connectionManager.sendToConnection(recipient.connectionId, eventMessage('space.presence', { spaceId, members }));
    }
  } catch (err) {
    coreLogger.error({ err, spaceId }, 'Space presence publish failed');
  }
}

/** A connection closed: refresh the presence of every room and space it was in. */
export function presenceAfterClose(ctx: ConnectionContext): void {
  const resources = [...ctx.resources];
  // After the connection is gone from the manager's list.
  setImmediate(() => {
    for (const resource of resources) {
      if (resource.startsWith('room:')) void publishRoomPresence(resource.slice('room:'.length)).catch((err: unknown) =>
        coreLogger.error({ err, resource }, 'Room presence publish failed'));
      else if (resource.startsWith('space:')) void publishSpacePresence(resource.slice('space:'.length));
    }
  });
}
