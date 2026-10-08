/**
 * Rooms — the shared chats of a space (docs/plans/coworking-spec.md §6).
 *
 * A room is a `sessions` row with `kind = 'room'` in a shared workspace
 * (D7), pinned (exempt from every sweep), created by a member with `write`.
 * `room_visibility` is `space` (every member of the space) or `private`
 * (the `room_members` rows). Who may do what is `roomAccess` +
 * `canActInSession`, read from the database on every call (D5); a caller
 * without access gets `not_found` for any room id (I3).
 *
 * A post is stored once (`role='user'`, `author_user_id`) and reaches the
 * room's subscribers through the message fan-out (`fanout.ts`); an
 * addressed post then queues a turn through `AgentService.handleRoomMessage`
 * — the only entry of room turns.
 *
 * Changes of who may enter a room (private-room members, visibility) write
 * an audit row with the space's `workspace_id` (I10) and call
 * `onRoomAccessChanged`.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { noteSessionKind } from '@/db/repositories/session-kind';
import { groupChannelRooms } from '@/db/schema/group-channels';
import { type Message, messages } from '@/db/schema/messages';
import { workspaceMembers } from '@/db/schema/organizations';
import { roomMembers, roomReads } from '@/db/schema/rooms';
import { type RoomVisibility, sessions } from '@/db/schema/sessions';
import { type UserKind, users } from '@/db/schema/users';
import { can, requireCan, SpaceError } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { accessToRoom, loadRoom, mayManage, type Room, type RoomAccess, roomAccess, roomOf } from './access';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Whoever acts; rights are read from the database. */
export interface RoomActor {
  readonly userId: string;
  readonly impersonatedBy?: string | null;
}

/** The title of the room every new space starts with (§5.3). */
export const DEFAULT_ROOM_TITLE = 'General';

function assertTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 120) throw new SpaceError('invalid_name', 'A room title must be 1–120 characters');
  return trimmed;
}

function assertVisibility(value: string): RoomVisibility {
  if (value !== 'space' && value !== 'private') throw new SpaceError('invalid_input', `Unknown room visibility: ${value}`);
  return value;
}

/**
 * The room access of `actor` in `roomId`, which must belong to `workspaceId`
 * (the route's space). `not_found` otherwise — for a stranger, a missing
 * room, and a room of another space alike.
 */
export async function requireRoom(actor: RoomActor, workspaceId: string, roomId: string): Promise<RoomAccess> {
  const access = await roomAccess(actor.userId, roomId);
  if (!access || access.room.workspaceId !== workspaceId) throw new SpaceError('not_found', 'Room not found');
  return access;
}

async function assertSpaceOpen(workspaceId: string): Promise<void> {
  const { isSpaceArchived } = await import('@/core/spaces/service');
  if (await isSpaceArchived(workspaceId)) throw new SpaceError('archived', 'This space is archived');
}

/** Members of `workspaceId` among `userIds`; throws `invalid_input` naming a non-member. */
async function assertSpaceMembers(tx: Db | Tx, workspaceId: string, userIds: readonly string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  if (!ids.every(isUuid)) throw new SpaceError('invalid_input', 'Room members must be members of the space');
  const rows = await tx
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, ids)));
  if (rows.length !== ids.length) throw new SpaceError('invalid_input', 'Room members must be members of the space');
  // A guest's rooms are their scope (S6), set by an owner on the membership.
  if (rows.some((r) => r.role === 'guest')) {
    throw new SpaceError('invalid_input', "A guest enters the rooms of their scope; change it in the space's member settings");
  }
}

/**
 * Insert a room in the caller's transaction (the space's creation, or
 * `createRoom`). A private room's creator and `memberIds` get their
 * `room_members` rows. Returns the room id.
 */
export async function createRoomInTx(
  tx: Tx,
  input: { workspaceId: string; createdBy: string; title: string; visibility: RoomVisibility; memberIds?: readonly string[] },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(sessions).values({
    id,
    userId: input.createdBy,
    workspaceId: input.workspaceId,
    kind: 'room',
    roomVisibility: input.visibility,
    channelType: 'room',
    channelId: id,
    title: input.title,
    status: 'active',
    // Kept until someone deletes it: exempt from the retention sweeps.
    pinned: true,
  });
  if (input.visibility === 'private') {
    const ids = [...new Set([input.createdBy, ...(input.memberIds ?? [])])];
    await tx.insert(roomMembers).values(ids.map((userId) => ({ sessionId: id, userId, addedBy: input.createdBy }))).onConflictDoNothing();
  }
  noteSessionKind(id, 'room');
  return id;
}

export interface RoomView {
  id: string;
  workspaceId: string;
  title: string;
  visibility: RoomVisibility;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** Posts and replies after the caller's read position, not counting their own posts. */
  unreadCount: number;
  muted: boolean;
}

/** Create a room in the space (editor+). */
export async function createRoom(
  actor: RoomActor,
  workspaceId: string,
  input: { title: string; visibility: string; memberIds?: string[] },
): Promise<RoomView> {
  const title = assertTitle(input.title);
  const visibility = assertVisibility(input.visibility);
  if (visibility === 'space' && (input.memberIds?.length ?? 0) > 0) {
    throw new SpaceError('invalid_input', 'Members are listed for private rooms only');
  }
  const { getMembership, writeSpaceAudit, auditActor } = await import('@/core/spaces/service');
  await assertSpaceOpen(workspaceId);
  const id = await getDb().transaction(async (tx) => {
    requireCan(await getMembership(actor.userId, workspaceId, tx, { lock: 'share' }), 'write');
    await assertSpaceMembers(tx, workspaceId, input.memberIds ?? []);
    const roomId = await createRoomInTx(tx, { workspaceId, createdBy: actor.userId, title, visibility, memberIds: input.memberIds });
    await writeSpaceAudit(tx, {
      ...auditActor({ userId: actor.userId, impersonatedBy: actor.impersonatedBy }),
      action: 'space_content_changed',
      workspaceId,
      resourceType: 'room',
      resourceId: roomId,
      details: { created: true, title, visibility, ...(visibility === 'private' ? { members: [...new Set([actor.userId, ...(input.memberIds ?? [])])] } : {}) },
    });
    return roomId;
  });
  const room = await loadRoom(id);
  if (!room) throw new Error(`Room ${id} vanished after creation`);
  return { ...room, unreadCount: 0, muted: false };
}

/** The rooms of the space the actor may enter, with unread counts, oldest first ("General" first). */
export async function listRooms(actor: RoomActor, workspaceId: string): Promise<RoomView[]> {
  const { getMembership } = await import('@/core/spaces/service');
  const membership = requireCan(await getMembership(actor.userId, workspaceId), 'read');
  const db = getDb();
  const mine = sql`EXISTS (SELECT 1 FROM room_members rm WHERE rm.session_id = ${sessions.id} AND rm.user_id = ${actor.userId})`;
  const rows = await db
    .select({
      room: sessions,
      muted: roomReads.muted,
      unread: sql<number>`(SELECT count(*)::int FROM messages m
        WHERE m.session_id = ${sessions.id} AND m.role IN ('user','assistant')
          AND m.author_user_id IS DISTINCT FROM ${actor.userId}
          AND (m.metadata->>'kind') IS DISTINCT FROM 'progress'
          AND (${roomReads.lastReadMessageId} IS NULL OR (m.created_at, m.id) >
            (SELECT r.created_at, r.id FROM messages r WHERE r.id = ${roomReads.lastReadMessageId})))`,
    })
    .from(sessions)
    .leftJoin(roomReads, and(eq(roomReads.sessionId, sessions.id), eq(roomReads.userId, actor.userId)))
    .where(and(
      eq(sessions.workspaceId, workspaceId),
      eq(sessions.kind, 'room'),
      // Guests (S6) see only the rooms of their scope; others every open room and their private ones.
      membership.scope
        ? (membership.scope.rooms.length > 0 ? inArray(sessions.id, membership.scope.rooms) : sql`FALSE`)
        : or(eq(sessions.roomVisibility, 'space'), mine),
    ))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  return rows.map((r) => {
    noteSessionKind(r.room.id, 'room');
    return { ...roomOf(r.room), unreadCount: Number(r.unread ?? 0), muted: r.muted ?? false };
  });
}

/** A room message as clients see it. */
export interface RoomMessageView {
  id: string;
  roomId: string;
  role: 'user' | 'assistant';
  content: string;
  authorUserId: string | null;
  authorName: string | null;
  agentId: string | null;
  createdAt: string;
  metadata: {
    kind?: 'progress';
    clientId?: string;
    addressed?: boolean;
    /** The post an answer replies to. */
    replyTo?: string;
    /** The member the answer was for. */
    requesterId?: string;
    /** Posted by the agent unprompted, in a listen room (§9.3); members rate it. */
    unprompted?: boolean;
    /** Posted by a remote member's own agent (federation §7.4): `authorName` reads "anna's agent [B:…]". */
    agent?: boolean;
  };
}

export function messageView(row: Message, authorName: string | null): RoomMessageView {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    roomId: row.sessionId,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    authorUserId: row.authorUserId ?? null,
    authorName,
    agentId: row.agentId ?? null,
    createdAt: row.createdAt.toISOString(),
    metadata: {
      ...(meta.kind === 'progress' ? { kind: 'progress' as const } : {}),
      ...(typeof meta.clientId === 'string' ? { clientId: meta.clientId } : {}),
      ...(typeof meta.addressed === 'boolean' ? { addressed: meta.addressed } : {}),
      ...(typeof meta.replyTo === 'string' ? { replyTo: meta.replyTo } : {}),
      ...(typeof meta.requesterId === 'string' ? { requesterId: meta.requesterId } : {}),
      ...(meta.unprompted === true ? { unprompted: true } : {}),
      ...(meta.agent === true ? { agent: true } : {}),
    },
  };
}

async function views(rows: Message[]): Promise<RoomMessageView[]> {
  const { authorNamesOf } = await import('@/core/session-history');
  const names = await authorNamesOf(rows);
  return rows.map((row, i) => messageView(row, names[i]));
}

/**
 * Page through a room's posts and replies, with authors. Without a cursor:
 * the newest `limit`, oldest first. `before`: the page before that message;
 * `after`: the messages after it (catch-up), oldest first.
 */
export async function listRoomMessages(
  actor: RoomActor,
  workspaceId: string,
  roomId: string,
  opts: { before?: string; after?: string; limit?: number } = {},
): Promise<{ messages: RoomMessageView[]; hasMore: boolean }> {
  await requireRoom(actor, workspaceId, roomId);
  return readRoomMessages(roomId, opts);
}

/** `listRoomMessages` without the access check — the caller has done it. */
export async function readRoomMessages(
  roomId: string,
  opts: { before?: string; after?: string; limit?: number } = {},
): Promise<{ messages: RoomMessageView[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cursorId = opts.after ?? opts.before;
  if (cursorId !== undefined && !isUuid(cursorId)) throw new SpaceError('invalid_input', 'Unknown message cursor');
  const base = [eq(messages.sessionId, roomId), inArray(messages.role, ['user', 'assistant'] as const)];
  const cursor = cursorId
    ? sql`(SELECT c.created_at, c.id FROM messages c WHERE c.id = ${cursorId} AND c.session_id = ${roomId})`
    : null;
  if (cursor && opts.after) {
    // i2: a room's rows, after `requireRoom`
    const rows = await getDb().select().from(messages)
      .where(and(...base, sql`(${messages.createdAt}, ${messages.id}) > ${cursor}`))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit + 1);
    return { messages: await views(rows.slice(0, limit)), hasMore: rows.length > limit };
  }
  // i2: a room's rows, after `requireRoom`
  const rows = await getDb().select().from(messages)
    .where(and(...base, cursor ? sql`(${messages.createdAt}, ${messages.id}) < ${cursor}` : undefined))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  return { messages: await views(page), hasMore: rows.length > limit };
}

/**
 * Addressed in the text: `@octipus` anywhere — but not `@octipus@…`, which
 * names someone on another install (federation §7.4) and never starts the
 * agent here.
 */
export function mentionsOctipus(content: string): boolean {
  return /(^|[^\w@])@octipus\b(?!@)/i.test(content);
}

/**
 * Store an agent-labelled post of a member of install `instanceId`
 * (federation §7.4): refused `rate_limited` when that install's agents
 * already made `federation.agentPostsPerHour` posts in the room in the last
 * hour. The count and the insert run in one transaction under an advisory
 * lock of (room, install), so concurrent posts cannot both take the last
 * one. The hard bound on a visitor is its `room.post` bucket; this bounds
 * the agents of one install together, per room.
 */
async function createAgentPost(roomId: string, instanceId: string, row: typeof messages.$inferInsert): Promise<Message> {
  const { getConfig } = await import('@/config');
  const max = getConfig().federation.agentPostsPerHour;
  const created = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`federation:agent-posts:${roomId}:${instanceId}`}))`);
    // i2: a count in a room the poster may enter
    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.authorUserId))
      .where(and(
        eq(messages.sessionId, roomId),
        eq(messages.role, 'user'),
        sql`(${messages.metadata}->>'agent') = 'true'`,
        sql`${messages.createdAt} > now() - interval '1 hour'`,
        eq(users.remoteInstanceId, instanceId),
      ));
    if (Number(counted?.n ?? 0) >= max) {
      throw new SpaceError('rate_limited', `Members' own agents from your install already made ${max} posts in this room in the last hour`);
    }
    const [inserted] = await tx.insert(messages).values(row).returning();
    return inserted;
  });
  const { messageEvents } = await import('@/db/repositories/message-events');
  messageEvents.announce([created]);
  return created;
}

/**
 * Store a member's post (`can(role,'comment')`, space not archived): one
 * `user` row with its author (§6.3), then mentions are notified. Returns the
 * stored message. Turns are queued by the caller (`handleRoomMessage`).
 */
export async function postRoomMessage(
  actor: RoomActor,
  roomId: string,
  input: {
    content: string;
    addressed?: boolean;
    clientId?: string;
    /** Posted in the bound group channel (§9.4): the bridge does not post it back there. */
    bridged?: { channelType: string; messageId: string };
    /**
     * Posted by a remote member's own agent (federation §7.4, F-D10): labelled
     * as theirs and counted against `federation.agentPostsPerHour`. A member
     * of this install has no such label.
     */
    agent?: boolean;
    /**
     * What the input guard flagged in a post of a member of another install
     * that it let through (`warn`, federation §7.4): kept with the post, and
     * named beside it in every room turn's transcript.
     */
    guardFlags?: string[];
  },
  opts: { workspaceId?: string } = {},
): Promise<{ message: RoomMessageView; access: RoomAccess; addressed: boolean }> {
  const access = opts.workspaceId ? await requireRoom(actor, opts.workspaceId, roomId) : await roomAccess(actor.userId, roomId);
  if (!access) throw new SpaceError('not_found', 'Room not found');
  if (!can(access.role, 'comment')) throw new SpaceError('forbidden_role', `Your role (${access.role}) cannot post in this room`);
  await assertSpaceOpen(access.room.workspaceId);
  const content = input.content.trim();
  if (!content) throw new SpaceError('invalid_input', 'A post needs text');
  if ((input.agent || input.guardFlags) && !access.remote) {
    throw new SpaceError('invalid_input', 'Only a post from another install carries an agent label or input guard flags');
  }
  const addressed = input.addressed === true || mentionsOctipus(content);
  const { messageRepository } = await import('@/db/repositories/message-repository');
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const values = {
    sessionId: roomId,
    role: 'user' as const,
    content,
    authorUserId: actor.userId,
    metadata: {
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.bridged ? { bridged: input.bridged } : {}),
      ...(input.agent ? { agent: true } : {}),
      ...(input.guardFlags && input.guardFlags.length > 0 ? { guardFlags: input.guardFlags } : {}),
      addressed,
    },
  };
  const row = input.agent && access.remote
    ? await createAgentPost(roomId, access.remote.instanceId, { ...values, createdAt: new Date() })
    : await messageRepository.create(values);
  await sessionRepository.incrementMessageCount(roomId);
  // The poster has read everything up to their own post.
  await setReadPosition(roomId, actor.userId, row.id);
  const [view] = await views([row]);
  const { notifyRoomMentions } = await import('./mentions');
  await notifyRoomMentions(access.room, actor.userId, row.id, content).catch((err: unknown) =>
    coreLogger.error({ err, roomId, messageId: row.id }, 'Room mention notifications failed'));
  return { message: view, access, addressed };
}

async function setReadPosition(roomId: string, userId: string, messageId: string): Promise<void> {
  await getDb()
    .insert(roomReads)
    .values({ sessionId: roomId, userId, lastReadMessageId: messageId })
    .onConflictDoUpdate({ target: [roomReads.sessionId, roomReads.userId], set: { lastReadMessageId: messageId } });
}

/** Move the actor's read position to `messageId` (a message of the room). */
export async function markRoomRead(actor: RoomActor, roomId: string, messageId: string, opts: { workspaceId?: string } = {}): Promise<void> {
  const access = opts.workspaceId ? await requireRoom(actor, opts.workspaceId, roomId) : await roomAccess(actor.userId, roomId);
  if (!access) throw new SpaceError('not_found', 'Room not found');
  if (!isUuid(messageId)) throw new SpaceError('invalid_input', 'Unknown message');
  // i2: one id check inside a room the actor may enter
  const [row] = await getDb().select({ id: messages.id }).from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.sessionId, roomId))).limit(1);
  if (!row) throw new SpaceError('invalid_input', 'Unknown message');
  await setReadPosition(roomId, actor.userId, messageId);
}

/** Mute or unmute the room for the actor (mentions there stop notifying). */
export async function setRoomMuted(actor: RoomActor, workspaceId: string, roomId: string, muted: boolean): Promise<void> {
  await requireRoom(actor, workspaceId, roomId);
  await getDb()
    .insert(roomReads)
    .values({ sessionId: roomId, userId: actor.userId, muted })
    .onConflictDoUpdate({ target: [roomReads.sessionId, roomReads.userId], set: { muted } });
}

/** Whether `userId` muted the room. */
export async function isRoomMuted(roomId: string, userId: string): Promise<boolean> {
  const [row] = await getDb().select({ muted: roomReads.muted }).from(roomReads)
    .where(and(eq(roomReads.sessionId, roomId), eq(roomReads.userId, userId))).limit(1);
  return row?.muted ?? false;
}

/** Room creator (while editor+) or space owner (`manage`), or `forbidden_role`. */
function requireManage(actor: RoomActor, access: RoomAccess): void {
  if (!mayManage(access, actor.userId)) {
    throw new SpaceError('forbidden_role', 'Only the room\'s creator or a space owner can change this room');
  }
}

/**
 * Rename the room or change its visibility (room creator or space owner).
 * Making a room private keeps its creator and the actor in it; access
 * changes run `onRoomAccessChanged`.
 */
export async function updateRoom(
  actor: RoomActor,
  workspaceId: string,
  roomId: string,
  input: { title?: string; visibility?: string },
): Promise<RoomView & { warning?: string }> {
  const access = await requireRoom(actor, workspaceId, roomId);
  requireManage(actor, access);
  await assertSpaceOpen(workspaceId);
  const title = input.title === undefined ? undefined : assertTitle(input.title);
  const visibility = input.visibility === undefined ? undefined : assertVisibility(input.visibility);
  const visibilityChanged = visibility !== undefined && visibility !== access.room.visibility;
  const { writeSpaceAudit, auditActor } = await import('@/core/spaces/service');
  await getDb().transaction(async (tx) => {
    if (visibilityChanged && visibility === 'private') {
      // A room a group channel is bound to is read in that channel (§9.4): it
      // stays open while bound. Locked, so a binding in flight decides first.
      await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, roomId)).for('update');
      const [bound] = await tx.select({ groupChannelId: groupChannelRooms.groupChannelId }).from(groupChannelRooms)
        .where(eq(groupChannelRooms.sessionId, roomId)).limit(1);
      if (bound) {
        throw new SpaceError('invalid_input', 'This room is bound to a group channel, whose members read it: unbind the channel before making the room private');
      }
    }
    await tx.update(sessions)
      .set({ ...(title !== undefined ? { title } : {}), ...(visibility !== undefined ? { roomVisibility: visibility } : {}), updatedAt: new Date() })
      .where(and(eq(sessions.id, roomId), eq(sessions.kind, 'room')));
    if (visibilityChanged && visibility === 'private') {
      const keep = [...new Set([access.room.createdBy, actor.userId])];
      await tx.insert(roomMembers).values(keep.map((userId) => ({ sessionId: roomId, userId, addedBy: actor.userId }))).onConflictDoNothing();
    }
    await writeSpaceAudit(tx, {
      ...auditActor({ userId: actor.userId, impersonatedBy: actor.impersonatedBy }),
      action: 'space_content_changed',
      workspaceId,
      resourceType: 'room',
      resourceId: roomId,
      details: {
        ...(title !== undefined ? { title: { previousValue: access.room.title, newValue: title } } : {}),
        ...(visibilityChanged ? { visibility: { previousValue: access.room.visibility, newValue: visibility } } : {}),
      },
    });
  });
  if (visibilityChanged) await roomAudienceChanged(workspaceId);
  const warning = visibilityChanged ? await settleRoomFollowUp(roomId) : null;
  const room = await loadRoom(roomId);
  if (!room) throw new SpaceError('not_found', 'Room not found');
  const view: RoomView = { ...room, unreadCount: 0, muted: await isRoomMuted(roomId, actor.userId) };
  return warning ? { ...view, warning } : view;
}

/** Who may enter a room of the space changed: what keys its audience moves on (federation §7.5). */
async function roomAudienceChanged(workspaceId: string): Promise<void> {
  const { bumpSpaceMembershipVersion } = await import('@/core/spaces/membership');
  bumpSpaceMembershipVersion(workspaceId);
}

async function settleRoomFollowUp(roomId: string): Promise<string | null> {
  const { settleFollowUp } = await import('@/core/spaces/membership');
  const { onRoomAccessChanged } = await import('./membership');
  return settleFollowUp('Room access change', { roomId }, () => onRoomAccessChanged(roomId));
}

export interface RoomMemberView {
  userId: string;
  username: string;
  addedAt: Date | null;
}

/**
 * Who is in the room: the `room_members` of a private room, every member of
 * the space for an open one — guests not by either rule but by their scope
 * (S6): the guests whose scope names the room.
 */
export async function listRoomMembers(actor: RoomActor, workspaceId: string, roomId: string): Promise<RoomMemberView[]> {
  const access = await requireRoom(actor, workspaceId, roomId);
  const { guestsInRooms } = await import('@/core/spaces/service');
  const guests = await guestsInRooms(workspaceId, [roomId]);
  const guestRows = guests.length === 0 ? [] : await getDb()
    .select({ userId: workspaceMembers.userId, username: users.username, addedAt: sql<Date | null>`NULL` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, guests)))
    .orderBy(asc(workspaceMembers.joinedAt));
  if (access.room.visibility === 'private') {
    const members = await getDb()
      .select({ userId: roomMembers.userId, username: users.username, addedAt: roomMembers.addedAt })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, roomMembers.userId), eq(workspaceMembers.workspaceId, workspaceId)))
      .where(and(eq(roomMembers.sessionId, roomId), ne(workspaceMembers.role, 'guest')))
      .orderBy(asc(roomMembers.addedAt));
    return [...members, ...guestRows];
  }
  const members = await getDb()
    .select({ userId: workspaceMembers.userId, username: users.username, addedAt: sql<Date | null>`NULL` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.role, 'guest')))
    .orderBy(asc(workspaceMembers.joinedAt));
  return [...members, ...guestRows];
}

async function requirePrivateManaged(actor: RoomActor, workspaceId: string, roomId: string): Promise<RoomAccess> {
  const access = await requireRoom(actor, workspaceId, roomId);
  requireManage(actor, access);
  if (access.room.visibility !== 'private') throw new SpaceError('invalid_input', 'Every member of the space is in an open room; make it private first');
  await assertSpaceOpen(workspaceId);
  return access;
}

/** Add a member of the space to a private room (room creator or space owner). */
export async function addRoomMember(actor: RoomActor, workspaceId: string, roomId: string, userId: string): Promise<{ added: boolean }> {
  await requirePrivateManaged(actor, workspaceId, roomId);
  const { writeSpaceAudit, auditActor } = await import('@/core/spaces/service');
  const added = await getDb().transaction(async (tx) => {
    await assertSpaceMembers(tx, workspaceId, [userId]);
    const inserted = await tx.insert(roomMembers).values({ sessionId: roomId, userId, addedBy: actor.userId })
      .onConflictDoNothing().returning({ userId: roomMembers.userId });
    if (inserted.length > 0) {
      await writeSpaceAudit(tx, {
        ...auditActor({ userId: actor.userId, impersonatedBy: actor.impersonatedBy }),
        action: 'space_content_changed',
        workspaceId,
        resourceType: 'room_member',
        resourceId: userId,
        details: { roomId, added: true },
      });
    }
    return inserted.length > 0;
  });
  if (added) await roomAudienceChanged(workspaceId);
  return { added };
}

/**
 * Remove a member from a private room (room creator or space owner). Their
 * subscriptions, queued and running turns and pending requests in the room
 * end at once (`onRoomAccessChanged`). The room's creator stays.
 */
export async function removeRoomMember(actor: RoomActor, workspaceId: string, roomId: string, userId: string): Promise<{ removed: boolean; warning?: string }> {
  const access = await requirePrivateManaged(actor, workspaceId, roomId);
  if (userId === access.room.createdBy) throw new SpaceError('invalid_input', 'The room\'s creator stays in the room');
  if (!isUuid(userId)) throw new SpaceError('not_found', 'Member not found');
  const { writeSpaceAudit, auditActor } = await import('@/core/spaces/service');
  const removed = await getDb().transaction(async (tx) => {
    const deleted = await tx.delete(roomMembers)
      .where(and(eq(roomMembers.sessionId, roomId), eq(roomMembers.userId, userId)))
      .returning({ userId: roomMembers.userId });
    if (deleted.length > 0) {
      await writeSpaceAudit(tx, {
        ...auditActor({ userId: actor.userId, impersonatedBy: actor.impersonatedBy }),
        action: 'space_content_changed',
        workspaceId,
        resourceType: 'room_member',
        resourceId: userId,
        details: { roomId, removed: true },
      });
    }
    return deleted.length > 0;
  });
  if (!removed) return { removed: false };
  await roomAudienceChanged(workspaceId);
  const warning = await settleRoomFollowUp(roomId);
  return warning ? { removed, warning } : { removed };
}

/** The room ids of a space (any visibility) — for membership changes. */
export async function roomIdsOf(workspaceId: string): Promise<string[]> {
  if (!isUuid(workspaceId)) return [];
  const rows = await getDb().select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.kind, 'room')));
  return rows.map((r) => r.id);
}

/** Every `userId` with access to the room, for a fan-out that must address people (mentions). */
export async function hasRoomAccess(userId: string, room: Room): Promise<boolean> {
  return (await accessToRoom(userId, room)) !== null;
}

/** Usernames of the space's members, for `@` completion and mention lookup. */
export async function spaceMemberByUsername(workspaceId: string, usernames: readonly string[]): Promise<Array<{ userId: string; username: string; kind: UserKind }>> {
  const names = [...new Set(usernames.map((n) => n.toLowerCase()))];
  if (names.length === 0) return [];
  return getDb()
    .select({ userId: users.id, username: users.username, kind: users.kind })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(sql`lower(${users.username})`, names), eq(users.isActive, true)));
}
