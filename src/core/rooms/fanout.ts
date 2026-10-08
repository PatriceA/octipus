/**
 * Room fan-out (docs/plans/coworking-spec.md §6.4, §6.6).
 *
 * Every message row of a room reaches the room's members through ONE
 * mechanism: the message repositories announce each committed row on
 * `messageEvents` (after commit — a rolled-back "conversation cleared"
 * insert never broadcasts); this module resolves the row's session kind
 * from the bounded cache and publishes posts and replies of rooms to the
 * resource `room:<id>` as `room.message`. Whatever writes the row — the
 * room post, the turn's final answer, a progress update, a command's
 * answer, a refusal — members see it, and only rows that were stored.
 *
 * It also keeps space presence current as members open and leave notes
 * (the document hub's peers listener), and follows the running room turn for the turn strip: its model once
 * the root agent spawned, and "waiting for X to approve" while the requester
 * has an open approval or permission request in the room.
 *
 * Deltas are not published here: they are the requester's own events (the
 * turn runs as the requester) and reach only the requester's connections.
 */
import { messageEvents } from '@/db/repositories/message-events';
import { sessionKindOf } from '@/db/repositories/session-kind';
import type { Message } from '@/db/schema/messages';
import { coreLogger } from '@/utils/logger';
import { publishRoomEvent } from './events';
import { notifyRoomMessage } from './notifications';
import { markRoomTurnWaiting, setRoomTurnModel } from './queue';

/** Per-room delivery chain: `room.message` events leave in commit order. */
const chains = new Map<string, Promise<void>>();

async function deliver(row: Message): Promise<void> {
  if ((await sessionKindOf(row.sessionId)) !== 'room') return;
  const [{ messageView }, { authorNamesOf }] = await Promise.all([import('./service'), import('@/core/session-history')]);
  const [name] = await authorNamesOf([row]);
  const message = messageView(row, name);
  publishRoomEvent(row.sessionId, 'room.message', {
    roomId: row.sessionId,
    message,
    ...(message.metadata.clientId ? { clientId: message.metadata.clientId } : {}),
  });
  await notifyRoomMessage(row, name);
}

/** Queue `row` for delivery behind the room's earlier rows. */
export function fanOutMessage(row: Message): Promise<void> {
  if (row.role !== 'user' && row.role !== 'assistant') return Promise.resolve();
  const previous = chains.get(row.sessionId) ?? Promise.resolve();
  const next = previous
    .then(() => deliver(row))
    .catch((err: unknown) => coreLogger.error({ err, sessionId: row.sessionId, messageId: row.id }, 'Room message fan-out failed'));
  chains.set(row.sessionId, next);
  void next.finally(() => { if (chains.get(row.sessionId) === next) chains.delete(row.sessionId); });
  return next;
}

/** Wait until every queued delivery of `roomId` went out (tests). */
export async function roomDeliveries(roomId: string): Promise<void> {
  await chains.get(roomId);
}

let started: (() => void) | null = null;

/**
 * Subscribe the fan-out to committed messages, and the turn strip to the
 * agent service and the permission manager. Idempotent; returns the stop
 * function.
 */
export async function startRoomFanout(): Promise<() => void> {
  if (started) return started;
  const onCreated = (row: Message) => { void fanOutMessage(row); };
  messageEvents.on('created', onCreated);
  const cleanups: Array<() => void> = [() => messageEvents.off('created', onCreated)];

  const [{ getAgentService }, { getPermissionManager }] = await Promise.all([
    import('@/core/agent'), import('@/security/permissions'),
  ]);
  cleanups.push(getAgentService().onEvent((event) => {
    if (event.type === 'worker_spawned') {
      const data = event.data as { root?: boolean; model?: string } | undefined;
      if (data?.root && data.model) setRoomTurnModel(event.sessionId, event.userId, data.model);
    } else if (event.type === 'approval_required') {
      markRoomTurnWaiting(event.sessionId, event.userId, true);
    } else if (event.type === 'approval_resolved') {
      markRoomTurnWaiting(event.sessionId, event.userId, false);
    }
  }));
  const permissions = getPermissionManager();
  cleanups.push(permissions.onRequest((request) => {
    if (request.sessionId) markRoomTurnWaiting(request.sessionId, request.userId, true);
  }));
  cleanups.push(permissions.onResolved((event) => {
    if (event.sessionId) markRoomTurnWaiting(event.sessionId, event.userId, false);
  }));

  // Space presence follows the notes members open (S3 document hub).
  const [{ setDocPeersListener }, { publishSpacePresence }] = await Promise.all([import('@/core/docs'), import('./presence')]);
  setDocPeersListener((workspaceId) => { void publishSpacePresence(workspaceId); });
  cleanups.push(() => setDocPeersListener(() => undefined));

  started = () => {
    for (const cleanup of cleanups) cleanup();
    started = null;
  };
  return started;
}
