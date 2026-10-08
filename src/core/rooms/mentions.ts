/**
 * `@username` mentions in a room (docs/plans/coworking-spec.md §6.7).
 *
 * A mention notifies the named member — `room_mention`, filed under the
 * space (`notify(..., { workspaceId })`) — when they may enter the room
 * (their membership and, for a private room, their `room_members` row,
 * read now: the notification service checks nothing) and have not muted it.
 * The poster is never notified of their own post; `@octipus` addresses the
 * agent and is not a member.
 *
 * Members of other installs (docs/plans/federation-spec.md §7.4) are named
 * only as `@~name@fp8` — their full handle; `@name@fp8` keeps its local
 * meaning. Such a mention is not a local notification: it goes as
 * `room.mention` to that member's own connections (their virtual
 * connections on the peer link) and is dropped when none is open — their
 * install shows the unread from `room.page` when it next opens the room.
 */
import { coreLogger } from '@/utils/logger';
import type { Room } from './access';

const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9][\w.-]{0,63})/g;
/** `@~name@fp8`: a member of another install, by handle (`~<slug>@<8 chars of its install id>`). */
const REMOTE_MENTION_RE = /(^|[^\w@])@(~[A-Za-z0-9][\w.-]{0,63}@[a-z2-7]{8})(?![\w@])/gi;

/** The usernames `content` mentions (without `@`), lower-cased, without `octipus`. */
export function mentionedUsernames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(MENTION_RE)) {
    const name = match[2].replace(/[.-]+$/, '').toLowerCase();
    if (name && name !== 'octipus') names.add(name);
  }
  return [...names];
}

/** The remote handles `content` mentions (`~name@fp8`), lower-cased. */
export function mentionedRemoteHandles(content: string): string[] {
  const handles = new Set<string>();
  for (const match of content.matchAll(REMOTE_MENTION_RE)) handles.add(match[2].toLowerCase());
  return [...handles];
}

/**
 * Notify the members `content` mentions. Returns who was notified (locally or
 * over their link). `createdAt` is the post's: a remote member's install
 * answers a mention only while it is recent (federation §9).
 */
export async function notifyRoomMentions(room: Room, posterId: string, messageId: string, content: string, createdAt: Date = new Date()): Promise<string[]> {
  const names = mentionedUsernames(content);
  const handles = mentionedRemoteHandles(content);
  if (names.length === 0 && handles.length === 0) return [];
  const { spaceMemberByUsername, hasRoomAccess, isRoomMuted } = await import('./service');
  // Plain names resolve to local members only; a remote member answers to its full handle.
  const locals = (await spaceMemberByUsername(room.workspaceId, names)).filter((m) => m.kind === 'local');
  const remotes = (await spaceMemberByUsername(room.workspaceId, handles)).filter((m) => m.kind === 'remote');
  const { displayNames } = await import('@/core/session-history');
  const poster = (await displayNames([posterId])).get(posterId) ?? 'A member';
  const excerpt = content.length > 280 ? `${content.slice(0, 277)}…` : content;
  const notified: string[] = [];
  for (const { userId } of locals) {
    if (userId === posterId) continue;
    if (!(await hasRoomAccess(userId, room))) continue;
    if (await isRoomMuted(room.id, userId)) continue;
    const { getNotificationService } = await import('@/core/notification-service');
    await getNotificationService().notify(
      userId,
      'room_mention',
      `${poster} mentioned you in ${room.title}`,
      excerpt,
      { roomId: room.id, messageId, spaceId: room.workspaceId },
      { workspaceId: room.workspaceId },
    );
    notified.push(userId);
  }
  for (const { userId } of remotes) {
    if (userId === posterId) continue;
    if (!(await hasRoomAccess(userId, room))) continue;
    if (await isRoomMuted(room.id, userId)) continue;
    // Their own connections only: the virtual connections on their link.
    const { getGatewayHub } = await import('@/core/gateway/hub');
    getGatewayHub().publishEvent({
      type: 'room.mention', source: 'rooms', userId, sessionId: room.id,
      payload: { roomId: room.id, spaceId: room.workspaceId, messageId, roomTitle: room.title, poster, excerpt, createdAt: createdAt.toISOString() },
    });
    notified.push(userId);
  }
  if (notified.length > 0) coreLogger.debug({ roomId: room.id, messageId, count: notified.length }, 'Room mentions notified');
  return notified;
}
