import type { Message } from '@/db/schema/messages';
import { getNotificationService } from '@/core/notification-service';
import { loadRoom } from './access';
import { mentionedUsernames } from './mentions';
import { roomNotificationRecipients } from './service';

/** Durable room posts notify accessible, unmuted members, including offline phones. */
export async function notifyRoomMessage(row: Message, authorName: string | null): Promise<void> {
  if (row.role !== 'user' && row.role !== 'assistant') return;
  if (row.metadata?.kind === 'progress') return;
  const room = await loadRoom(row.sessionId);
  if (!room) return;
  const candidates = await roomNotificationRecipients(room);
  // User mentions already have their more specific notification, emitted by postRoomMessage.
  const mentioned = row.role === 'user' && row.authorUserId ? new Set(mentionedUsernames(row.content)) : new Set<string>();
  for (const member of candidates) {
    if (member.userId === row.authorUserId || mentioned.has(member.username.toLowerCase())) continue;
    await getNotificationService().notify(member.userId, 'room_message',
      `${row.role === 'assistant' ? 'Octipus' : authorName ?? 'A member'} in ${room.title}`,
      row.content.length > 280 ? `${row.content.slice(0, 277)}…` : row.content,
      { spaceId: room.workspaceId, roomId: room.id, messageId: row.id },
      { workspaceId: room.workspaceId });
  }
}
