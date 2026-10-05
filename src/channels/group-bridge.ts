/**
 * The group-channel bridge (docs/plans/coworking-spec.md §9.4).
 *
 * A group channel bound to a space is that space's conversation on the
 * platform: each thread of the channel is a room of the space
 * (`group_channel_rooms`), and the room mirrors the thread.
 *
 * - **Binding** needs a space owner who is also the channel's owner, and an
 *   explicit acknowledgement that everyone in the channel can read what the
 *   room shows. It closes the members' per-thread sessions of the channel and
 *   is audited with the space (I10). So is every unbinding: by the channel's
 *   owner or a space owner, by a take-over of the channel (the new owner is
 *   not the one who bound it), by its removal.
 * - **Turns** in a bound channel are room turns (`AgentService.handleRoomMessage`,
 *   D8): the member's message is posted in the thread's room and the turn
 *   runs as them. A linked member who is not a member of the space (or whose
 *   role cannot ask the agent) gets a private hint and no turn. Unlinked
 *   people's posts are never stored in the room: they stay platform context,
 *   which reaches the turn as the thread's fenced transcript.
 * - **Relay**: every post and reply stored in a bridged room that did not
 *   come from the platform is posted in its thread, so the channel reads what
 *   the room shows — that is what the owner acknowledged.
 * - **Taken tasks** go on the space's board through the space access layer,
 *   one task per message whoever takes it (`takeChannelTask` with `space`).
 * - **Budget**: the space's budget replaces the channel's (`groupBudgetPause`);
 *   unprompted posts are funded by the space's sponsor and are off without
 *   one (`bridgeListenFunding`).
 */
import { and, eq } from 'drizzle-orm';
import { MAIN_THREAD } from '@/channels/group-handler';
import type { ChannelType, UnifiedMessage } from '@/core/types';
import { getDb } from '@/db/postgres';
import { messageEvents } from '@/db/repositories/message-events';
import { isUuid } from '@/db/repositories/scoped';
import { sessionKindOf } from '@/db/repositories/session-kind';
import { type GroupChannel, groupChannelRooms, groupChannels } from '@/db/schema/group-channels';
import type { Message } from '@/db/schema/messages';
import { workspaces } from '@/db/schema/organizations';
import { sessions } from '@/db/schema/sessions';
import { can, requireCan, SpaceError } from '@/security/space-access';
import { channelLogger } from '@/utils/logger';
import { getUMI } from './interface';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Who binds or unbinds; rights are read from the database. */
export interface BridgeActor {
  readonly userId: string;
  readonly impersonatedBy?: string | null;
}

/** The acknowledgement the owner gives when binding (shown in the web flow). */
export const BIND_ACKNOWLEDGEMENT = 'Everyone in this channel can read what the room shows: '
  + 'every post and every answer of the space\'s agent in the room is posted in the channel\'s thread.';

async function spaceService() {
  return import('@/core/spaces/service');
}

async function forgetChannel(group: Pick<GroupChannel, 'id' | 'channelType' | 'channelId'>): Promise<void> {
  const { invalidateGroupChannel } = await import('./group-channels');
  invalidateGroupChannel(group);
}

/**
 * Bind the channel to a space (§9.4 point 2). `roomId`, optional, is a room
 * of the space that becomes the channel's main thread (the whole chat on a
 * platform without threads); every other thread gets its own room on first
 * use. Closes the members' active per-thread sessions of the channel.
 */
export async function bindGroupChannel(
  actor: BridgeActor,
  groupChannelId: string,
  input: { workspaceId: string; acknowledged: boolean; roomId?: string },
): Promise<GroupChannel> {
  if (input.acknowledged !== true) {
    throw new SpaceError('invalid_input', 'Confirm that everyone in the channel can read what the room shows');
  }
  if (!isUuid(groupChannelId)) throw new SpaceError('not_found', 'Group channel not found');
  const { getMembership, writeSpaceAudit, auditActor } = await spaceService();
  const bound = await getDb().transaction(async (tx) => {
    const [group] = await tx.select().from(groupChannels)
      .where(and(eq(groupChannels.id, groupChannelId), eq(groupChannels.ownerUserId, actor.userId)))
      .for('update')
      .limit(1);
    // Someone else's enrolment answers like a missing one.
    if (!group) throw new SpaceError('not_found', 'Group channel not found');
    // A space owner who is also the channel's owner (§9.4).
    requireCan(await getMembership(actor.userId, input.workspaceId, tx, { lock: 'share' }), 'manage_space');
    // Read in the transaction (one connection in embedded mode).
    const [space] = await tx.select({ archivedAt: workspaces.archivedAt }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
    if (space?.archivedAt) throw new SpaceError('archived', 'This space is archived');
    if (group.workspaceId) throw new SpaceError('invalid_input', 'This channel is already bound to a space; unbind it first');

    if (input.roomId) {
      const [room] = await tx.select({ id: sessions.id, workspaceId: sessions.workspaceId, visibility: sessions.roomVisibility })
        .from(sessions).where(and(eq(sessions.id, input.roomId), eq(sessions.kind, 'room'))).limit(1);
      if (!room || room.workspaceId !== input.workspaceId) throw new SpaceError('invalid_input', 'That room is not in this space');
      if (room.visibility !== 'space') throw new SpaceError('invalid_input', 'Only an open room can be bound: the channel reads it');
      await tx.insert(groupChannelRooms).values({ groupChannelId, threadId: MAIN_THREAD, sessionId: room.id });
    }
    const [updated] = await tx.update(groupChannels)
      .set({ workspaceId: input.workspaceId, updatedAt: new Date() })
      .where(eq(groupChannels.id, groupChannelId))
      .returning();
    // The members' own thread sessions end here: from now on the channel's
    // threads are rooms of the space.
    const closed = await tx.update(sessions)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(sessions.groupChannelId, groupChannelId), eq(sessions.status, 'active')))
      .returning({ id: sessions.id });
    await writeSpaceAudit(tx, {
      ...auditActor(actor),
      action: 'space_updated',
      workspaceId: input.workspaceId,
      resourceType: 'group_channel',
      resourceId: groupChannelId,
      details: {
        bound: true,
        acknowledged: BIND_ACKNOWLEDGEMENT,
        channelType: group.channelType,
        channelId: group.channelId,
        label: group.label,
        ...(input.roomId ? { roomId: input.roomId } : {}),
        closedSessions: closed.length,
      },
    });
    return updated;
  });
  await forgetChannel(bound);
  return bound;
}

/**
 * Unbind in the caller's transaction: the thread → room rows go (the rooms
 * stay in the space, as its content), the channel goes back to per-member
 * sessions, and the space's audit trail says who and why.
 */
async function unbindInTx(
  tx: Tx,
  group: GroupChannel,
  actor: BridgeActor,
  reason: 'unbound' | 'owner_changed' | 'channel_removed',
): Promise<void> {
  if (!group.workspaceId) return;
  const { writeSpaceAudit, auditActor } = await spaceService();
  await tx.delete(groupChannelRooms).where(eq(groupChannelRooms.groupChannelId, group.id));
  await tx.update(groupChannels).set({ workspaceId: null, updatedAt: new Date() }).where(eq(groupChannels.id, group.id));
  await writeSpaceAudit(tx, {
    ...auditActor(actor),
    action: 'space_updated',
    workspaceId: group.workspaceId,
    resourceType: 'group_channel',
    resourceId: group.id,
    details: { bound: false, reason, channelType: group.channelType, channelId: group.channelId, label: group.label },
  });
}

/** Unbind (the channel's owner, or an owner of the bound space). */
export async function unbindGroupChannel(actor: BridgeActor, groupChannelId: string): Promise<GroupChannel> {
  if (!isUuid(groupChannelId)) throw new SpaceError('not_found', 'Group channel not found');
  const { getMembership } = await spaceService();
  const updated = await getDb().transaction(async (tx) => {
    const [group] = await tx.select().from(groupChannels).where(eq(groupChannels.id, groupChannelId)).for('update').limit(1);
    if (!group?.workspaceId) throw new SpaceError('not_found', 'Group channel not found');
    const spaceOwner = can((await getMembership(actor.userId, group.workspaceId, tx))?.role, 'manage_space');
    if (group.ownerUserId !== actor.userId && !spaceOwner) throw new SpaceError('not_found', 'Group channel not found');
    await unbindInTx(tx, group, actor, 'unbound');
    return { ...group, workspaceId: null };
  });
  await forgetChannel(updated);
  return updated;
}

/**
 * The enrolment changes hands or goes away while bound: the binding ends
 * with it (the new owner never bound it). Called inside the caller's
 * transaction, before the change.
 */
export async function endBindingInTx(tx: Tx, group: GroupChannel, actor: BridgeActor, reason: 'owner_changed' | 'channel_removed'): Promise<void> {
  await unbindInTx(tx, group, actor, reason);
}

// ── Threads and rooms ───────────────────────────────────────────────────────

/** The room of a bound channel's thread, or null when the thread has none yet. */
export async function bridgedRoomOf(groupChannelId: string, threadId: string): Promise<string | null> {
  if (!isUuid(groupChannelId)) return null;
  const [row] = await getDb().select({ sessionId: groupChannelRooms.sessionId }).from(groupChannelRooms)
    .where(and(eq(groupChannelRooms.groupChannelId, groupChannelId), eq(groupChannelRooms.threadId, threadId)))
    .limit(1);
  return row?.sessionId ?? null;
}

/**
 * The room of a bound channel's thread, created on first use: an open room
 * of the space, created by the channel's owner (who bound it), titled after
 * the channel and the thread's first message.
 */
export async function resolveBridgedRoom(group: GroupChannel, threadId: string, title?: string): Promise<string> {
  if (!group.workspaceId) throw new Error('resolveBridgedRoom: the channel is not bound to a space');
  const existing = await bridgedRoomOf(group.id, threadId);
  if (existing) return existing;
  const workspaceId = group.workspaceId;
  const [{ createRoomInTx }, { writeSpaceAudit }] = await Promise.all([import('@/core/rooms/service'), spaceService()]);
  const where = group.label ?? group.channelId;
  const roomTitle = (threadId === MAIN_THREAD || !title ? where : `${where} · ${title}`).slice(0, 120);
  const created = await getDb().transaction(async (tx) => {
    const roomId = await createRoomInTx(tx, { workspaceId, createdBy: group.ownerUserId, title: roomTitle, visibility: 'space' });
    const [mapped] = await tx.insert(groupChannelRooms).values({ groupChannelId: group.id, threadId, sessionId: roomId })
      .onConflictDoNothing().returning({ sessionId: groupChannelRooms.sessionId });
    // Another message of the thread created its room first: drop ours.
    if (!mapped) {
      await tx.delete(sessions).where(eq(sessions.id, roomId));
      return null;
    }
    await writeSpaceAudit(tx, {
      actorId: group.ownerUserId,
      action: 'space_content_changed',
      workspaceId,
      resourceType: 'room',
      resourceId: roomId,
      details: { created: true, title: roomTitle, visibility: 'space', groupChannelId: group.id, threadId },
    });
    return roomId;
  });
  if (created) return created;
  const raced = await bridgedRoomOf(group.id, threadId);
  if (!raced) throw new Error('resolveBridgedRoom: the thread\'s room vanished');
  return raced;
}

/** Where a bridged room's posts go on the platform, or null for a room no channel is bound to. */
export async function bridgeTargetOf(roomId: string): Promise<{ group: GroupChannel; threadId: string } | null> {
  if (!isUuid(roomId)) return null;
  const [row] = await getDb()
    .select({ group: groupChannels, threadId: groupChannelRooms.threadId })
    .from(groupChannelRooms)
    .innerJoin(groupChannels, eq(groupChannels.id, groupChannelRooms.groupChannelId))
    .where(eq(groupChannelRooms.sessionId, roomId))
    .limit(1);
  // The mapping outlives nothing: an unbinding deletes it with the binding.
  if (!row || !row.group.workspaceId) return null;
  return row;
}

// ── Who may ask ─────────────────────────────────────────────────────────────

export type BridgeAccess = 'ok' | 'not_member' | 'cannot_ask' | 'archived';

/** Whether a linked member may start a turn in the bound channel (membership read now, D5). */
export async function bridgeAccess(group: GroupChannel, userId: string): Promise<BridgeAccess> {
  if (!group.workspaceId) return 'ok';
  const { getMembership, isSpaceArchived } = await spaceService();
  const membership = await getMembership(userId, group.workspaceId);
  if (!membership) return 'not_member';
  if (!can(membership.role, 'run_agent')) return 'cannot_ask';
  if (await isSpaceArchived(group.workspaceId)) return 'archived';
  return 'ok';
}

/** The private hint for a linked member the bridge turns away. */
export function bridgeHint(access: Exclude<BridgeAccess, 'ok'>): string {
  switch (access) {
    case 'not_member':
      return 'This channel is bound to an Octipus space you are not a member of, so I can\'t answer you here. '
        + 'Ask one of its owners for an invite.';
    case 'cannot_ask':
      return 'This channel is bound to an Octipus space where your role can\'t ask me. Ask a space owner for a role that can.';
    case 'archived':
      return 'The Octipus space this channel is bound to is archived, so I don\'t answer here any more.';
  }
}

// ── Budget and funding ──────────────────────────────────────────────────────

/**
 * Seam to the space budget (§9.2, built in S5a): when the bound space's
 * sponsored budget is used up, when it resets. Until that lands, sponsored
 * spend has no space budget to exhaust and `checkSpend` still refuses each
 * run on the requester's own budgets.
 */
export type SpaceBudgetPause = (workspaceId: string) => Promise<{ resetsAt: string } | null>;
export const spaceBudgetPause: SpaceBudgetPause = async () => null;

/**
 * The budget pause of a channel: for a bound channel the space's budget
 * replaces the channel's (§9.4 point 5) — its room turns run in room
 * sessions, which no channel budget covers — else the channel's own.
 */
export async function groupBudgetPause(group: GroupChannel): Promise<{ resetsAt: string } | null> {
  if (group.workspaceId) return spaceBudgetPause(group.workspaceId);
  const { groupChannelPause } = await import('@/security/spend-budgets');
  return groupChannelPause(group.id);
}

/**
 * Who pays for a bound channel's unprompted posts: the space's sponsor, or
 * nobody — then they are off (§9.4 point 5). `fundingFor('listen', space)`
 * decides; the sponsor is read from the space (S5a's `sponsor_user_id`).
 */
export async function bridgeListenFunding(group: GroupChannel): Promise<{ sponsorUserId: string } | null> {
  if (!group.workspaceId) throw new Error('bridgeListenFunding: the channel is not bound to a space');
  const { fundingFor } = await import('@/core/agent/context');
  const funding = fundingFor('listen', { workspaceId: group.workspaceId, role: 'owner', scope: null });
  if (funding !== 'sponsor') return null;
  const sponsorUserId = await spaceSponsorOf(group.workspaceId);
  return sponsorUserId ? { sponsorUserId } : null;
}

/** Seam to S5a (§9.1): the space's sponsor, or null when it has none. */
export type SpaceSponsorOf = (workspaceId: string) => Promise<string | null>;
export const spaceSponsorOf: SpaceSponsorOf = async () => null;

// ── Turns from the platform ─────────────────────────────────────────────────

/** A message from a bound channel, handed over by the channel dispatcher. */
export interface BridgedTurn {
  message: UnifiedMessage;
  group: GroupChannel;
  /** The platform thread's transcript (`readContext`), unlinked people's posts included. */
  context: string;
  take?: import('@/core/channels/taken-tasks').TakeRequest;
}

/**
 * Post a member's message in the thread's room and queue a room turn as
 * them (§9.4 point 3). Their access is read again here (D5). `take this`
 * puts the task on the space's board first.
 */
export async function handleBridgedTurn(turn: BridgedTurn): Promise<'queued' | 'approval' | 'refused' | 'already_taken'> {
  const { message, group } = turn;
  const umi = getUMI();
  const channelType = message.channelType as ChannelType;
  const threadId = message.threadId;
  if (!threadId) throw new Error('Bridged group message without a thread');
  const privately = (content: string) => umi.sendPrivate(channelType, message.channelId, message.userId, { content, threadId })
    .catch((err: unknown) => { channelLogger.warn({ err, groupChannelId: group.id }, 'Could not send a private bridge notice'); return false; });

  const access = await bridgeAccess(group, message.userId);
  if (access !== 'ok') {
    await privately(bridgeHint(access));
    return 'refused';
  }
  const roomId = await resolveBridgedRoom(group, threadId, message.content.slice(0, 60).replace(/\n/g, ' ').trim() || undefined);

  let take: import('@/core/channels/group-context').GroupTake | undefined;
  if (turn.take) {
    const { memberPrincipal } = await import('@/db/repositories/space');
    const principal = await memberPrincipal(message.userId, group.workspaceId as string);
    if (!can(principal.spaceRole, 'write')) {
      await privately('Your role in this channel\'s space can\'t add tasks to its board. Ask a space owner for an editor role.');
      return 'refused';
    }
    const { takeChannelTask } = await import('@/core/channels/taken-tasks');
    const { quietText } = await import('@/core/channels/group-context');
    const name = message.userName ?? 'the requester';
    const { task, created } = await takeChannelTask({
      userId: message.userId, workspaceId: group.workspaceId, sessionId: roomId, space: principal,
      requester: name, where: group.label ?? group.channelId, request: turn.take,
    });
    if (!created) {
      const state = task.status === 'done' ? 'done' : task.status === 'archived' ? 'archived' : 'in progress';
      await privately(`That is already on the space's board: *${quietText(task.title)}* (${state}). Mention me in its thread to continue it.`);
      return 'already_taken';
    }
    await umi.send(channelType, message.channelId, { content: `On it — added *${quietText(task.title)}* to the space's board.`, threadId });
    take = {
      taskId: task.id,
      title: task.title,
      ...(turn.take.author ? { author: turn.take.author } : {}),
      ...(turn.take.author || turn.take.quoted ? { text: turn.take.text } : {}),
    };
  }

  const { postRoomMessage } = await import('@/core/rooms/service');
  const platformMessageId = message.metadata?.messageId != null ? String(message.metadata.messageId) : '';
  const { message: post } = await postRoomMessage({ userId: message.userId }, roomId, {
    content: message.content || '(attachment)',
    addressed: true,
    bridged: { channelType, messageId: platformMessageId },
  });
  const { getAgentService } = await import('@/core/agent');
  const { RoomQueueError } = await import('@/core/rooms/queue');
  try {
    const outcome = await getAgentService().handleRoomMessage(roomId, message.userId, post.id, {
      requester: message.userName ?? 'A member', context: turn.context, ...(take ? { take } : {}),
    });
    return outcome.kind;
  } catch (err) {
    if (err instanceof RoomQueueError) {
      await privately(err.message);
      return 'refused';
    }
    throw err;
  }
}

// ── Relay: the room, read in the channel ────────────────────────────────────

/** The text a room row becomes in the thread; null for rows that stay in the room. */
export function relayText(row: Message, authorName: string | null): string | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (meta.bridged) return null;
  if (meta.kind === 'progress') return null;
  if (!row.content.trim()) return null;
  if (row.role === 'assistant') return row.content;
  if (row.role === 'user') return `*${authorName ?? 'A member'}* (in the web room): ${row.content}`;
  return null;
}

async function relay(row: Message): Promise<void> {
  if (row.role !== 'user' && row.role !== 'assistant') return;
  if ((await sessionKindOf(row.sessionId)) !== 'room') return;
  const target = await bridgeTargetOf(row.sessionId);
  if (!target) return;
  const { isGroupChannelActive } = await import('./group-channels');
  // Silent in a paused channel, as for every other message there.
  if (!(await isGroupChannelActive(target.group))) return;
  const { displayNames } = await import('@/core/session-history');
  const name = row.authorUserId ? (await displayNames([row.authorUserId])).get(row.authorUserId) ?? null : null;
  const text = relayText(row, name);
  if (!text) return;
  await getUMI().send(target.group.channelType as ChannelType, target.group.channelId, { content: text, threadId: target.threadId });
}

const chains = new Map<string, Promise<void>>();

/** Queue `row` for the platform behind the room's earlier rows (commit order). */
export function relayRoomMessage(row: Message): Promise<void> {
  const previous = chains.get(row.sessionId) ?? Promise.resolve();
  const next = previous
    .then(() => relay(row))
    .catch((err: unknown) => channelLogger.error({ err, sessionId: row.sessionId, messageId: row.id }, 'Group bridge relay failed'));
  chains.set(row.sessionId, next);
  void next.finally(() => { if (chains.get(row.sessionId) === next) chains.delete(row.sessionId); });
  return next;
}

let stopRelay: (() => void) | null = null;

/** Start relaying bridged rooms to their channels. Idempotent; returns the stop function. */
export function startGroupBridgeRelay(): () => void {
  if (stopRelay) return stopRelay;
  const onCreated = (row: Message) => { void relayRoomMessage(row); };
  messageEvents.on('created', onCreated);
  stopRelay = () => {
    messageEvents.off('created', onCreated);
    stopRelay = null;
  };
  return stopRelay;
}
