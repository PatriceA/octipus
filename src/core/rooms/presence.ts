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
 * A member's `where` is the newest of: the room their connection subscribed
 * to (`ctx.metadata.presenceWhere`, set by `room.subscribe` through
 * `setPresenceWhere`), and the note they opened in the document hub (S3,
 * `openDocsFor`). A room is shown to recipients who may enter it, a note to
 * members who may read it (a guest: a note of their folders, S6). Other
 * kinds are shown only through a check registered with
 * `registerPresenceWhereCheck`. Online members are the space's subscribers
 * and the document hub's peers in the space (`peersIn`); a guest recipient
 * sees only the members of their rooms (`membersVisibleToGuest`).
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
  ['note', async (userId, spaceId, where) => {
    const { getMembership } = await import('@/core/spaces/service');
    const membership = await getMembership(userId, spaceId);
    if (!membership) return false;
    if (!membership.scope) return true;
    const { loadSpaceNoteSlug } = await import('@/db/repositories/live-documents');
    const { noteInGuestScope } = await import('@/security/space-access');
    const note = await loadSpaceNoteSlug(where.id);
    return !!note && note.workspaceId === spaceId && noteInGuestScope(note.slug, membership.scope);
  }],
]);

/** Let another kind of `where` (S3: `note`) be shown, under its own access check. */
export function registerPresenceWhereCheck(kind: string, check: WhereCheck): void {
  whereChecks.set(kind, check);
}

const WHERE_KEY = 'presenceWhere';

/** Record where the connection is; null clears it. Republishes the space's presence. */
export function setPresenceWhere(ctx: ConnectionContext, spaceId: string | null, where: PresenceWhere | null): void {
  if (where) ctx.metadata[WHERE_KEY] = { ...where, spaceId, at: Date.now() };
  else delete ctx.metadata[WHERE_KEY];
  if (spaceId) void publishSpacePresence(spaceId);
}

function whereOf(ctx: ConnectionContext): (PresenceWhere & { spaceId: string | null; at: number }) | null {
  const w = ctx.metadata[WHERE_KEY] as (PresenceWhere & { spaceId: string | null; at: number }) | undefined;
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
    // Per member: the newest place among their connections' rooms and open notes.
    const online = new Map<string, (PresenceWhere & { at: number }) | null>();
    const consider = (userId: string, where: (PresenceWhere & { at: number }) | null) => {
      const current = online.get(userId) ?? null;
      if (!online.has(userId) || (where && (!current || where.at > current.at))) online.set(userId, where ?? current);
    };
    for (const ctx of conns) {
      const where = whereOf(ctx);
      consider(ctx.userId, where && where.spaceId === spaceId ? { kind: where.kind, id: where.id, at: where.at } : null);
    }
    const { getDocHub } = await import('@/core/docs');
    const docs = getDocHub();
    for (const peer of docs.peersIn(spaceId)) consider(peer.userId, null);
    for (const userId of [...online.keys()]) {
      const [note] = docs.openDocsFor(userId, spaceId);
      if (note) consider(userId, { kind: 'note', id: note.noteId, at: note.joinedAt });
    }
    const usernames = await names([...online.keys()]);
    const visible = new Map<string, boolean>();
    const hub = getGatewayHub();
    const { getMembership, membersVisibleToGuest } = await import('@/core/spaces/service');
    // Per recipient: everyone online, or for a guest the members of their
    // rooms (S6). A recipient whose membership reads null (removed, blocked
    // install, hosting off) sees nobody: fail closed, never "everyone".
    const audiences = new Map<string, Set<string> | null>();
    for (const recipient of conns) {
      if (!audiences.has(recipient.userId)) {
        const membership = await getMembership(recipient.userId, spaceId);
        audiences.set(recipient.userId, !membership ? new Set<string>()
          : membership.scope ? await membersVisibleToGuest(spaceId, recipient.userId, membership.scope) : null);
      }
      const audience = audiences.get(recipient.userId) ?? null;
      const members: Array<{ userId: string; username: string | null; where?: PresenceWhere }> = [];
      for (const [userId, where] of online) {
        if (audience && !audience.has(userId)) continue;
        let shown: PresenceWhere | undefined;
        if (where) {
          const key = `${recipient.userId}:${where.kind}:${where.id}`;
          if (!visible.has(key)) {
            const check = whereChecks.get(where.kind);
            visible.set(key, check ? await check(recipient.userId, spaceId, where) : false);
          }
          if (visible.get(key)) shown = { kind: where.kind, id: where.id };
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
