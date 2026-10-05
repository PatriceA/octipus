/**
 * Who may enter a room, and who may act in a session (docs/plans/coworking-spec.md §6.2).
 *
 * - `roomAccess(userId, roomId)` is the one door to a room: the requester's
 *   space membership, read from the database (D5), plus a `room_members` row
 *   for a private room. Guests (S6) enter only the rooms their scope names
 *   (`GuestScope.rooms`), with or without a `room_members` row.
 *   Null for everything else — a non-member, a missing room, a chat id — so
 *   room ids cannot be probed (I3).
 * - `canActInSession(session, userId, action)` replaces the inline
 *   `session.userId !== userId` checks: a personal chat is its owner's, and a
 *   room follows the table below. A source test fails on a new inline
 *   comparison (`session-access.test.ts`).
 *
 *   | Action             | Personal chat | Room                                   |
 *   |--------------------|---------------|----------------------------------------|
 *   | `post`             | owner         | `can(role,'comment')`                  |
 *   | `turn`             | owner         | `can(role,'run_agent')` (and addressed) |
 *   | `stop`             | owner         | the running turn's requester, or editor+ |
 *   | `control`          | owner         | any member (/status, /help, /cancel)    |
 *   | `manage`           | owner         | room creator or space owner (/clear, title, visibility) |
 *   | `settings`         | owner         | refused (/model, skills: per requester) |
 *   | `requester`        | owner         | the turn's requester, within the role cap (plan tools, scripts, test containers, progress rows) |
 *   | `personal_tool`    | owner         | not offered (monitors, scheduling)      |
 *   | `learning`, `voice`| owner         | refused                                 |
 *   | `chat`             | owner         | refused (personal chat paths: chat.send, /api/chat, replay, swarm) |
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { noteSessionKind } from '@/db/repositories/session-kind';
import { roomMembers } from '@/db/schema/rooms';
import { type RoomVisibility, type Session, sessions } from '@/db/schema/sessions';
import type { AgentSpace } from '@/core/types';
import { can, type SpaceRole } from '@/security/space-access';

/** A room as the rooms code sees it. */
export interface Room {
  id: string;
  workspaceId: string;
  title: string;
  visibility: RoomVisibility;
  /** The member who created it (`sessions.user_id`). */
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoomAccess {
  space: AgentSpace;
  role: SpaceRole;
  room: Room;
}

export function roomOf(row: Session): Room {
  if (row.kind !== 'room' || !row.workspaceId || !row.roomVisibility) throw new Error(`Session ${row.id} is not a room`);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title ?? '',
    visibility: row.roomVisibility,
    createdBy: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The room row, or null when `roomId` names no room. */
export async function loadRoom(roomId: string): Promise<Room | null> {
  if (!isUuid(roomId)) return null;
  // i2: one room by id; every caller checks `roomAccess` before showing anything of it
  const [row] = await getDb().select().from(sessions).where(and(eq(sessions.id, roomId), eq(sessions.kind, 'room'))).limit(1);
  if (!row) return null;
  noteSessionKind(row.id, 'room');
  return roomOf(row);
}

/** Whether `userId` has a `room_members` row in the room. */
export async function isRoomMember(roomId: string, userId: string): Promise<boolean> {
  if (!isUuid(roomId) || !isUuid(userId)) return false;
  const [row] = await getDb()
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.sessionId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return !!row;
}

/**
 * `userId`'s access to the room, read now: their membership of the room's
 * space and, for a private room, their `room_members` row — or, for a
 * guest, the room in their scope. Null when they may not enter it, or it is
 * no room.
 */
export async function roomAccess(userId: string, roomId: string): Promise<RoomAccess | null> {
  if (!isUuid(userId)) return null;
  const room = await loadRoom(roomId);
  if (!room) return null;
  return accessToRoom(userId, room);
}

/** `roomAccess` for a room already loaded. */
export async function accessToRoom(userId: string, room: Room): Promise<RoomAccess | null> {
  const { getMembership } = await import('@/core/spaces/service');
  const membership = await getMembership(userId, room.workspaceId);
  if (!membership) return null;
  if (membership.scope) {
    if (!membership.scope.rooms.includes(room.id)) return null;
  } else if (room.visibility === 'private') {
    if (!(await isRoomMember(room.id, userId))) return null;
  }
  return {
    space: { workspaceId: room.workspaceId, role: membership.role, scope: membership.scope },
    role: membership.role,
    room,
  };
}

export type SessionAction =
  | 'post'
  | 'turn'
  | 'stop'
  | 'control'
  | 'manage'
  | 'settings'
  | 'requester'
  | 'personal_tool'
  | 'learning'
  | 'voice'
  | 'chat';

/** The session columns `canActInSession` reads. */
export type ActSession = Pick<Session, 'id' | 'userId' | 'kind'>;

/**
 * May `userId` do `action` in `session`? A missing session may do nothing.
 * Room rules read the membership now (D5). `turnRequesterId` is the
 * requester of the room's running turn, for `stop`.
 */
export async function canActInSession(
  session: ActSession | null | undefined,
  userId: string,
  action: SessionAction,
  opts: { turnRequesterId?: string | null } = {},
): Promise<boolean> {
  if (!session) return false;
  if (session.kind !== 'room') return session.userId === userId;
  switch (action) {
    case 'settings':
    case 'personal_tool':
    case 'learning':
    case 'voice':
    case 'chat':
      return false;
    default:
      break;
  }
  const access = await roomAccess(userId, session.id);
  if (!access) return false;
  switch (action) {
    case 'post':
      return can(access.role, 'comment');
    case 'turn':
    case 'requester':
      return can(access.role, 'run_agent');
    case 'stop':
      return (!!opts.turnRequesterId && opts.turnRequesterId === userId) || can(access.role, 'write');
    case 'control':
      return true;
    case 'manage':
      return access.room.createdBy === userId || access.role === 'owner';
  }
}
