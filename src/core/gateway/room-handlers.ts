/**
 * Space and room frames of the gateway (docs/plans/coworking-spec.md §6.6).
 *
 * Every frame is access-checked when it arrives (D5):
 *
 *   space.subscribe, room.subscribe, room.post, room.read,
 *   room.cancel_queued                — membership read from the database
 *                                       (`getMembership` / `roomAccess`);
 *   room.typing                       — the in-process membership version:
 *                                       unchanged since the subscribe, else
 *                                       the database is read again.
 *
 * The resources `space:<id>` and `room:<id>` are filled here only, after
 * those checks (the generic `subscribe` refuses both kinds), and pruned by
 * `onMembershipChanged` / `onRoomAccessChanged`. Room frames of one
 * connection are handled one at a time, in arrival order; the order of
 * posts is the server's `created_at`, and `clientId` is echoed for the
 * client to reconcile its copy.
 */
import { coreLogger } from '@/utils/logger';
import type { GatewayHub } from './hub';
import type { ClientMessage, ConnectionContext } from './protocol';

export type RoomFrame = Extract<ClientMessage, {
  type: 'space.subscribe' | 'room.subscribe' | 'room.unsubscribe' | 'room.post' | 'room.read' | 'room.typing' | 'room.cancel_queued';
}>;

const ROOM_FRAME_TYPES: ReadonlySet<string> = new Set([
  'space.subscribe', 'room.subscribe', 'room.unsubscribe', 'room.post', 'room.read', 'room.typing', 'room.cancel_queued',
]);

export function isRoomFrame(message: ClientMessage): message is RoomFrame {
  return ROOM_FRAME_TYPES.has(message.type);
}

/** Per-connection chain: room frames of one connection run in arrival order. */
const chains = new Map<string, Promise<void>>();

/** Handle a space or room frame, after the connection's earlier ones. */
export function handleRoomFrame(hub: GatewayHub, connectionId: string, context: ConnectionContext, message: RoomFrame): Promise<void> {
  const previous = chains.get(connectionId) ?? Promise.resolve();
  const next = previous.then(() => runFrame(hub, connectionId, context, message));
  chains.set(connectionId, next);
  void next.finally(() => { if (chains.get(connectionId) === next) chains.delete(connectionId); });
  return next;
}

function sendError(hub: GatewayHub, connectionId: string, code: string, message: string): void {
  hub.connectionManager.sendToConnection(connectionId, { type: 'error', code, message });
}

/** The membership versions seen at each room subscribe (for `room.typing`). */
const VERSIONS_KEY = 'roomMembershipVersions';

function versionsOf(context: ConnectionContext): Record<string, number> {
  const existing = context.metadata[VERSIONS_KEY] as Record<string, number> | undefined;
  if (existing) return existing;
  const fresh: Record<string, number> = {};
  context.metadata[VERSIONS_KEY] = fresh;
  return fresh;
}

async function runFrame(hub: GatewayHub, connectionId: string, context: ConnectionContext, message: RoomFrame): Promise<void> {
  try {
    switch (message.type) {
      case 'space.subscribe':
        return await spaceSubscribe(hub, connectionId, context, message.spaceId);
      case 'room.subscribe':
        return await roomSubscribe(hub, connectionId, context, message.roomId, message.afterMessageId);
      case 'room.unsubscribe':
        return await roomUnsubscribe(context, message.roomId);
      case 'room.post':
        return await roomPost(hub, connectionId, context, message);
      case 'room.read':
        return await roomRead(context, message.roomId, message.messageId);
      case 'room.typing':
        return await roomTyping(hub, connectionId, context, message.roomId);
      case 'room.cancel_queued':
        return await roomCancelQueued(hub, connectionId, context, message.roomId, message.messageId);
    }
  } catch (err) {
    const { SpaceError } = await import('@/security/space-access');
    if (err instanceof SpaceError) {
      sendError(hub, connectionId, err.code === 'not_found' ? 'NOT_FOUND' : err.code.toUpperCase(), err.message);
      return;
    }
    coreLogger.error({ err, connectionId, type: message.type }, 'Room frame failed');
    sendError(hub, connectionId, 'ROOM_ERROR', (err as Error).message);
  }
}

async function spaceSubscribe(hub: GatewayHub, connectionId: string, context: ConnectionContext, spaceId: string): Promise<void> {
  const { getMembership } = await import('@/core/spaces/service');
  if (!(await getMembership(context.userId, spaceId))) {
    sendError(hub, connectionId, 'FORBIDDEN', `Not allowed to subscribe to space:${spaceId}`);
    return;
  }
  const { spaceResource } = await import('@/core/rooms/events');
  context.resources.add(spaceResource(spaceId));
  hub.connectionManager.sendToConnection(connectionId, { type: 'subscribed', resources: [spaceResource(spaceId)] });
  const { publishSpacePresence } = await import('@/core/rooms/presence');
  await publishSpacePresence(spaceId);
}

async function roomSubscribe(hub: GatewayHub, connectionId: string, context: ConnectionContext, roomId: string, afterMessageId?: string): Promise<void> {
  const { roomAccess } = await import('@/core/rooms/access');
  const access = await roomAccess(context.userId, roomId);
  if (!access) {
    sendError(hub, connectionId, 'FORBIDDEN', `Not allowed to subscribe to room:${roomId}`);
    return;
  }
  const [{ roomResource, eventMessage }, { membershipVersion }, presence, { roomQueueSnapshot }] = await Promise.all([
    import('@/core/rooms/events'), import('@/core/spaces/membership'), import('@/core/rooms/presence'), import('@/core/rooms/queue'),
  ]);
  context.resources.add(roomResource(roomId));
  // Checked again now that the connection is in the resource: an access
  // change that pruned the room's subscribers between the first check and
  // the add did not see this connection, so this read is the one that counts.
  if (!(await roomAccess(context.userId, roomId))) {
    context.resources.delete(roomResource(roomId));
    sendError(hub, connectionId, 'FORBIDDEN', `Not allowed to subscribe to room:${roomId}`);
    return;
  }
  versionsOf(context)[roomId] = membershipVersion(access.room.workspaceId, context.userId);
  hub.connectionManager.sendToConnection(connectionId, { type: 'subscribed', resources: [roomResource(roomId)] });
  if (afterMessageId) {
    // Catch-up after a reconnect: from the messages table, paged by id —
    // never from the event bus (room events are not kept for replay).
    const { readRoomMessages } = await import('@/core/rooms/service');
    const page = await readRoomMessages(roomId, { after: afterMessageId, limit: 200 });
    hub.connectionManager.sendToConnection(connectionId, { type: 'room.catchup', roomId, messages: page.messages, hasMore: page.hasMore });
  }
  // The turn strip as it is now, for this connection.
  const snapshot = roomQueueSnapshot(roomId);
  if (snapshot.running || snapshot.queued.length > 0) {
    const state = snapshot.running ? (snapshot.running.waiting ? 'waiting' : 'started') : 'queued';
    const head = snapshot.running ?? snapshot.queued[0];
    hub.connectionManager.sendToConnection(connectionId, eventMessage('room.turn', {
      roomId, state, requesterId: head.requesterId, requesterName: head.requesterName, messageId: head.messageId, queue: snapshot,
    }, roomId));
  }
  presence.setPresenceWhere(context, access.room.workspaceId, { kind: 'room', id: roomId });
  await presence.publishRoomPresence(roomId);
}

async function roomUnsubscribe(context: ConnectionContext, roomId: string): Promise<void> {
  const [{ roomResource }, presence, { loadRoom }] = await Promise.all([
    import('@/core/rooms/events'), import('@/core/rooms/presence'), import('@/core/rooms/access'),
  ]);
  if (!context.resources.delete(roomResource(roomId))) return;
  delete versionsOf(context)[roomId];
  const where = context.metadata.presenceWhere as { kind?: string; id?: string; spaceId?: string | null } | undefined;
  if (where?.kind === 'room' && where.id === roomId) {
    const room = await loadRoom(roomId);
    presence.setPresenceWhere(context, room?.workspaceId ?? where.spaceId ?? null, null);
  }
  await presence.publishRoomPresence(roomId);
}

async function roomPost(hub: GatewayHub, connectionId: string, context: ConnectionContext, message: Extract<RoomFrame, { type: 'room.post' }>): Promise<void> {
  const content = message.content.trim();
  if (context.clientType === 'peer') return remoteRoomPost(hub, connectionId, context, message, content);
  if (content.startsWith('/')) {
    // A command: not a post — answered to the poster only (§6.2).
    const { runRoomCommand } = await import('@/core/rooms/commands');
    const answer = await runRoomCommand(message.roomId, context.userId, content);
    if (answer === 'Room not found.') {
      sendError(hub, connectionId, 'NOT_FOUND', 'Room not found');
      return;
    }
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'room.posted', roomId: message.roomId, messageId: '', ...(message.clientId ? { clientId: message.clientId } : {}), commandResult: answer,
    });
    return;
  }
  const { message: _stored, ...outcome } = await postAndQueue(context.userId, message.roomId, { content, addressed: message.addressed, clientId: message.clientId });
  void _stored; // members (the poster included) receive it as `room.message`
  hub.connectionManager.sendToConnection(connectionId, { type: 'room.posted', roomId: message.roomId, ...outcome });
}

/**
 * `room.post` from a member of another install, on their virtual connection
 * (docs/plans/federation-spec.md §7.4). A post, never a moderation
 * command; it passes the input guard before it is stored (a refused post is
 * answered with an error and not stored); one made on their install's agent
 * connection (`conn` = `agent:<session>`) is labelled as their agent's and
 * counted against the room's hourly cap. Then the same path as a local post.
 */
async function remoteRoomPost(
  hub: GatewayHub, connectionId: string, context: ConnectionContext, message: Extract<RoomFrame, { type: 'room.post' }>, content: string,
): Promise<void> {
  if (content.startsWith('/')) {
    sendError(hub, connectionId, 'FORBIDDEN', 'Room commands are for members of this install');
    return;
  }
  const { guardInput } = await import('@/core/agent/input-guard');
  const guard = guardInput(content);
  if (guard.action === 'block') {
    coreLogger.warn({ connectionId, userId: context.userId, flags: guard.flags }, 'Input guard refused a post from another install');
    sendError(hub, connectionId, 'POST_REFUSED', guard.blockReason ?? 'This post was refused');
    return;
  }
  const federation = context.metadata.federation as { conn?: unknown } | undefined;
  const agent = typeof federation?.conn === 'string' && federation.conn.startsWith('agent:');
  const { message: _stored, ...outcome } = await postAndQueue(context.userId, message.roomId, {
    content, addressed: message.addressed, clientId: message.clientId, ...(agent ? { agent: true } : {}),
  });
  void _stored;
  hub.connectionManager.sendToConnection(connectionId, { type: 'room.posted', roomId: message.roomId, ...outcome });
}

/**
 * Store a post and, when it asks Octipus, queue the poster's turn — the
 * shared body of `room.post` and its REST fallback. A post that was stored
 * but could not queue a turn says why (`notQueued`): the post stands.
 */
export async function postAndQueue(
  userId: string,
  roomId: string,
  input: { content: string; addressed?: boolean; clientId?: string; agent?: boolean },
  opts: { workspaceId?: string } = {},
): Promise<{ messageId: string; clientId?: string; queuedPosition?: number; notQueued?: string; message: unknown }> {
  const { postRoomMessage } = await import('@/core/rooms/service');
  const posted = await postRoomMessage({ userId }, roomId, input, opts);
  const base = { messageId: posted.message.id, message: posted.message, ...(input.clientId ? { clientId: input.clientId } : {}) };
  if (!posted.addressed) return base;
  try {
    const { getAgentService } = await import('@/core/agent');
    const outcome = await getAgentService().handleRoomMessage(roomId, userId, posted.message.id);
    return outcome.kind === 'queued' ? { ...base, queuedPosition: outcome.position } : { ...base, notQueued: 'Answered your pending approval.' };
  } catch (err) {
    const [{ SpaceError }, { RoomQueueError }] = await Promise.all([import('@/security/space-access'), import('@/core/rooms/queue')]);
    if (err instanceof SpaceError || err instanceof RoomQueueError) return { ...base, notQueued: err.message };
    throw err;
  }
}

async function roomRead(context: ConnectionContext, roomId: string, messageId: string): Promise<void> {
  const { markRoomRead } = await import('@/core/rooms/service');
  await markRoomRead({ userId: context.userId }, roomId, messageId);
  const { publishRoomEvent } = await import('@/core/rooms/events');
  publishRoomEvent(roomId, 'room.read', { roomId, userId: context.userId, messageId });
}

async function roomTyping(hub: GatewayHub, connectionId: string, context: ConnectionContext, roomId: string): Promise<void> {
  const [{ roomResource, publishRoomEvent }, { membershipVersion }, { loadRoom, roomAccess }] = await Promise.all([
    import('@/core/rooms/events'), import('@/core/spaces/membership'), import('@/core/rooms/access'),
  ]);
  // Typing needs the room subscription (granted after a database check and
  // pruned on every access change) and an unchanged membership version;
  // a changed one is read from the database again.
  if (!context.resources.has(roomResource(roomId))) {
    sendError(hub, connectionId, 'FORBIDDEN', 'Subscribe to the room first');
    return;
  }
  const room = await loadRoom(roomId);
  if (!room) return;
  const seen = versionsOf(context)[roomId];
  const now = membershipVersion(room.workspaceId, context.userId);
  if (seen !== now) {
    if (!(await roomAccess(context.userId, roomId))) {
      const { pruneRoomSubscription } = await import('@/core/rooms/membership');
      pruneRoomSubscription(context, roomId);
      return;
    }
    versionsOf(context)[roomId] = now;
  }
  const { displayNames } = await import('@/core/session-history');
  const username = (await displayNames([context.userId])).get(context.userId) ?? null;
  publishRoomEvent(roomId, 'room.typing', { roomId, userId: context.userId, username });
}

async function roomCancelQueued(hub: GatewayHub, connectionId: string, context: ConnectionContext, roomId: string, messageId: string): Promise<void> {
  const [{ roomAccess }, { cancelQueuedTurn }, { can }] = await Promise.all([
    import('@/core/rooms/access'), import('@/core/rooms/queue'), import('@/security/space-access'),
  ]);
  const access = await roomAccess(context.userId, roomId);
  if (!access) {
    sendError(hub, connectionId, 'NOT_FOUND', 'Room not found');
    return;
  }
  // Your own request; an editor+ may cancel anyone's.
  if (!cancelQueuedTurn(roomId, messageId, context.userId, can(access.role, 'write'))) {
    sendError(hub, connectionId, 'NOT_QUEUED', 'That request is not waiting (it already started, finished, or is not yours)');
  }
}
