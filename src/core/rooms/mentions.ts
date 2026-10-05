/**
 * `@username` mentions in a room (docs/plans/coworking-spec.md §6.7).
 *
 * A mention notifies the named member — `room_mention`, filed under the
 * space (`notify(..., { workspaceId })`) — when they may enter the room
 * (their membership and, for a private room, their `room_members` row,
 * read now: the notification service checks nothing) and have not muted it.
 * The poster is never notified of their own post; `@octipus` addresses the
 * agent and is not a member.
 */
import { coreLogger } from '@/utils/logger';
import type { Room } from './access';

const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9][\w.-]{0,63})/g;

/** The usernames `content` mentions (without `@`), lower-cased, without `octipus`. */
export function mentionedUsernames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const name = match[2].replace(/[.-]+$/, '').toLowerCase();
    if (name && name !== 'octipus') names.add(name);
  }
  return [...names];
}

/** Notify the members `content` mentions. Returns who was notified. */
export async function notifyRoomMentions(room: Room, posterId: string, messageId: string, content: string): Promise<string[]> {
  const names = mentionedUsernames(content);
  if (names.length === 0) return [];
  const { spaceMemberByUsername, hasRoomAccess, isRoomMuted } = await import('./service');
  const candidates = await spaceMemberByUsername(room.workspaceId, names);
  const { getNotificationService } = await import('@/core/notification-service');
  const { displayNames } = await import('@/core/session-history');
  const poster = (await displayNames([posterId])).get(posterId) ?? 'A member';
  const notified: string[] = [];
  for (const { userId } of candidates) {
    if (userId === posterId) continue;
    if (!(await hasRoomAccess(userId, room))) continue;
    if (await isRoomMuted(room.id, userId)) continue;
    await getNotificationService().notify(
      userId,
      'room_mention',
      `${poster} mentioned you in ${room.title}`,
      content.length > 280 ? `${content.slice(0, 277)}…` : content,
      { roomId: room.id, messageId, spaceId: room.workspaceId },
      { workspaceId: room.workspaceId },
    );
    notified.push(userId);
  }
  if (notified.length > 0) coreLogger.debug({ roomId: room.id, messageId, count: notified.length }, 'Room mentions notified');
  return notified;
}
