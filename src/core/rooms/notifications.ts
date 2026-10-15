import type { Message } from '@/db/schema/messages';
import { getNotificationService } from '@/core/notification-service';
import { serialPerKey } from '@/utils/concurrency';
import { coreLogger } from '@/utils/logger';
import { inlineUiFallbackText } from '@/shared/inline-ui/fence';
import { loadRoom } from './access';
import { mentionedRemoteHandles, mentionedUsernames } from './mentions';
import { roomNotificationRecipients } from './service';

/**
 * Per-room notification chain, apart from the delivery chain in fanout.ts:
 * live `room.message` delivery never waits on the recipient lookup, and a
 * room's notifications still go out in commit order.
 */
const chains = serialPerKey((err, sessionId) => coreLogger.error({ err, sessionId }, 'Room message notifications failed'));

/** Queue the notifications of a durable room post behind the room's earlier ones. */
export function queueRoomNotification(row: Message, authorName: string | null): Promise<void> {
  return chains.run(row.sessionId, () => notifyRoomMessage(row, authorName).catch((err: unknown) => {
    coreLogger.error({ err, sessionId: row.sessionId, messageId: row.id }, 'Room message notifications failed');
  }));
}

/** Wait until every queued notification of `roomId` went out (tests). */
export function roomNotifications(roomId: string): Promise<void> {
  return chains.idle(roomId);
}

/**
 * Durable room posts notify accessible, unmuted members, including offline
 * phones. A member of another install gets a `room.notice` over their link
 * instead: a row in this install's notifications table reaches nobody.
 */
export async function notifyRoomMessage(row: Message, authorName: string | null): Promise<void> {
  if (row.role !== 'user' && row.role !== 'assistant') return;
  if (row.metadata?.kind === 'progress') return;
  const room = await loadRoom(row.sessionId);
  if (!room) return;
  const candidates = await roomNotificationRecipients(room);
  // Mentioned members already get the more specific room_mention (postRoomMessage).
  const mentioned = row.role === 'user' && row.authorUserId
    ? new Set([...mentionedUsernames(row.content), ...mentionedRemoteHandles(row.content)])
    : new Set<string>();
  const title = `${row.role === 'assistant' ? 'Octipus' : authorName ?? 'A member'} in ${room.title}`;
  // A marker line of an interactive answer reads as a plain line in a notification.
  const text = inlineUiFallbackText(row.content);
  const body = text.length > 280 ? `${text.slice(0, 277)}…` : text;
  for (const member of candidates) {
    if (member.userId === row.authorUserId || mentioned.has(member.username.toLowerCase())) continue;
    if (member.kind === 'remote') {
      const { noticeRemoteMember } = await import('@/core/federation/host-ops');
      await noticeRemoteMember(member.userId, {
        type: 'room.notice', kind: 'room_message', spaceId: room.workspaceId, roomId: room.id, messageId: row.id, title, body,
      });
      continue;
    }
    await getNotificationService().notify(member.userId, 'room_message', title, body,
      { spaceId: room.workspaceId, roomId: room.id, messageId: row.id },
      { workspaceId: room.workspaceId });
  }
}
