/**
 * Group channels — Octipus as a member of a shared chat.
 *
 * A linked member enrols a channel by typing `@octipus join` in it, which
 * proves they are a member without any extra platform scopes. Until then the
 * bot stays silent in that channel. Once enrolled, the bot answers when it is
 * addressed (mentioned, or replied to in a thread it is already in).
 *
 * Every turn runs as the member who addressed the bot, in that member's own
 * session for the thread — never as the owner. Sessions, permissions,
 * memories and spend are per user throughout Octipus; running as the owner
 * would hand the owner's tools and data to everyone in the channel. Shared
 * context comes from the thread itself, which the adapter reads back.
 *
 * Design: `docs/plans/group-chat-bot.md`.
 */
import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { auditRepository } from '@/db/repositories/audit-repository';
import { isUuid } from '@/db/repositories/scoped';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getDb } from '@/db/postgres';
import {
  type GroupChannel, GROUP_CHANNEL_MODES, type GroupChannelMode, groupChannelFeedback, groupChannels,
} from '@/db/schema/group-channels';
import { sessions } from '@/db/schema/sessions';
import { users } from '@/db/schema/users';
import { channelLogger } from '@/utils/logger';

/** Chat platforms with group mode. */
export const GROUP_CHANNEL_TYPES = ['slack', 'teams', 'telegram'] as const;
export type GroupChannelType = (typeof GROUP_CHANNEL_TYPES)[number];

/** A group channel with the owner's name, for the settings and admin pages. */
export interface GroupChannelView extends GroupChannel {
  ownerName: string;
  ownerActive: boolean;
  /** The space the channel is bound to (§9.4), or null. */
  spaceName: string | null;
  /** ✅ / ❌ reactions members put on the bot's messages here. */
  feedback: { up: number; down: number };
}

// ── Lookup (hot path: every message in every channel the bot is in) ─────────

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { row: GroupChannel | null; at: number }>();
const cacheKey = (channelType: string, channelId: string) => `${channelType}:${channelId}`;

/** The enrolment for a chat, or null. Cached briefly; writes here invalidate it. */
export async function findGroupChannel(channelType: string, channelId: string): Promise<GroupChannel | null> {
  const key = cacheKey(channelType, channelId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;
  const [row] = await getDb()
    .select()
    .from(groupChannels)
    .where(and(eq(groupChannels.channelType, channelType), eq(groupChannels.channelId, channelId)))
    .limit(1);
  cache.set(key, { row: row ?? null, at: Date.now() });
  return row ?? null;
}

/** An enrolment by its id (admin pages), or null. Not cached. */
export async function findGroupChannelById(id: string): Promise<GroupChannel | null> {
  if (!isUuid(id)) return null;
  const [row] = await getDb().select().from(groupChannels).where(eq(groupChannels.id, id)).limit(1);
  return row ?? null;
}

/** Test seam: forget every cached enrolment and thread state. */
export function clearGroupChannelCache(): void {
  cache.clear();
  threadActive.clear();
}

/** After a write: forget this chat's enrolment lookup only. */
function invalidateChannel(channelType: string, channelId: string): void {
  cache.delete(cacheKey(channelType, channelId));
}

/** After a bridge change (bind, unbind): forget the chat's enrolment and its threads. */
export function invalidateGroupChannel(group: Pick<GroupChannel, 'id' | 'channelType' | 'channelId'>): void {
  invalidateChannel(group.channelType, group.channelId);
  forgetThreads(group.id);
}

/** After a removal: the group's threads are gone with it. */
function forgetThreads(groupChannelId: string): void {
  const prefix = `${groupChannelId}:`;
  for (const key of [...threadActive.keys()]) if (key.startsWith(prefix)) threadActive.delete(key);
}

/**
 * An enrolment is paused while its owner's account is deactivated. Not
 * cached: it is read only for messages addressed to the bot (one primary-key
 * lookup next to an agent turn), and a deactivation must take effect at once.
 */
export async function isGroupChannelActive(group: GroupChannel): Promise<boolean> {
  const [owner] = await getDb()
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, group.ownerUserId))
    .limit(1);
  return owner?.isActive === true;
}

// ── Enrolment from inside the channel ───────────────────────────────────────

export type JoinResult =
  | { status: 'enrolled'; group: GroupChannel }
  | { status: 'took_over'; group: GroupChannel; previousOwner: string }
  | { status: 'already_yours'; group: GroupChannel }
  | { status: 'taken'; ownerName: string };

async function ownerSummary(userId: string): Promise<{ name: string; active: boolean }> {
  const [row] = await getDb()
    .select({ username: users.username, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return { name: row?.username ?? 'a deleted user', active: row?.isActive === true };
}

/**
 * `@octipus join` from a linked member. Enrols the channel, or takes it over
 * when the current owner is deactivated. The caller has already established
 * that `userId` posted in the channel.
 */
export async function joinGroupChannel(input: {
  channelType: GroupChannelType;
  channelId: string;
  label?: string | null;
  userId: string;
}): Promise<JoinResult> {
  const db = getDb();
  invalidateChannel(input.channelType, input.channelId);
  const existing = await findGroupChannel(input.channelType, input.channelId);

  if (existing) {
    if (existing.ownerUserId === input.userId) return { status: 'already_yours', group: existing };
    const owner = await ownerSummary(existing.ownerUserId);
    if (owner.active) return { status: 'taken', ownerName: owner.name };
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(groupChannels)
        // The new owner pays for unprompted posts, so they opt in again: back to mention mode.
        .set({ ownerUserId: input.userId, mode: 'mention', updatedAt: new Date() })
        // Guard on the previous owner so two members taking over at once cannot both win.
        .where(and(eq(groupChannels.id, existing.id), eq(groupChannels.ownerUserId, existing.ownerUserId)))
        .returning();
      // A binding to a space was the previous owner's (§9.4): it ends here.
      if (row?.workspaceId) {
        const { endBindingInTx } = await import('./group-bridge');
        await endBindingInTx(tx, row, { userId: input.userId }, 'owner_changed');
        return { ...row, workspaceId: null };
      }
      return row;
    });
    invalidateChannel(input.channelType, input.channelId);
    if (updated) forgetThreads(updated.id);
    if (!updated) return joinGroupChannel(input);
    await audit(input.userId, updated, { takenOverFrom: existing.ownerUserId });
    // The channel's spend budget is filed under its owner, who is notified.
    await import('@/security/spend-budgets')
      .then(({ moveGroupChannelBudgets }) => moveGroupChannelBudgets(updated.id, input.userId))
      .catch((err: unknown) => channelLogger.error({ err, groupChannelId: updated.id }, 'Could not move the channel\'s spend budget to its new owner'));
    return { status: 'took_over', group: updated, previousOwner: owner.name };
  }

  const [created] = await db
    .insert(groupChannels)
    .values({
      channelType: input.channelType,
      channelId: input.channelId,
      label: input.label ?? null,
      ownerUserId: input.userId,
    })
    .onConflictDoNothing()
    .returning();
  invalidateChannel(input.channelType, input.channelId);
  // Lost a race with another member's join: report whoever won.
  if (!created) return joinGroupChannel(input);
  await audit(input.userId, created, { enrolled: true });
  return { status: 'enrolled', group: created };
}

export type LeaveResult = 'left' | 'not_enrolled' | 'not_owner';

/** `@octipus leave` — the owner (or an admin) removes the enrolment. */
export async function leaveGroupChannel(input: {
  channelType: GroupChannelType;
  channelId: string;
  userId: string;
  isAdmin: boolean;
}): Promise<LeaveResult> {
  invalidateChannel(input.channelType, input.channelId);
  const existing = await findGroupChannel(input.channelType, input.channelId);
  if (!existing) return 'not_enrolled';
  if (existing.ownerUserId !== input.userId && !input.isAdmin) return 'not_owner';
  await removeGroupChannel(existing.id, { userId: input.userId, isAdmin: input.isAdmin });
  return 'left';
}

// ── Management (settings + admin pages) ─────────────────────────────────────

async function listViews(ownerUserId?: string): Promise<GroupChannelView[]> {
  const rows = await getDb()
    .select({
      group: groupChannels,
      ownerName: users.username,
      ownerActive: users.isActive,
      spaceName: sql<string | null>`(SELECT w.name FROM workspaces w WHERE w.id = ${groupChannels.workspaceId})`,
      up: sql<number>`(SELECT count(*)::int FROM group_channel_feedback f WHERE f.group_channel_id = ${groupChannels.id} AND f.value = 1)`,
      down: sql<number>`(SELECT count(*)::int FROM group_channel_feedback f WHERE f.group_channel_id = ${groupChannels.id} AND f.value = -1)`,
    })
    .from(groupChannels)
    .innerJoin(users, eq(users.id, groupChannels.ownerUserId))
    .where(ownerUserId ? eq(groupChannels.ownerUserId, ownerUserId) : undefined)
    .orderBy(groupChannels.createdAt);
  return rows.map(r => ({
    ...r.group, ownerName: r.ownerName, ownerActive: r.ownerActive, spaceName: r.spaceName ?? null,
    feedback: { up: Number(r.up), down: Number(r.down) },
  }));
}

export function listGroupChannelsForOwner(userId: string): Promise<GroupChannelView[]> {
  return listViews(userId);
}

export function listAllGroupChannels(): Promise<GroupChannelView[]> {
  return listViews();
}

// ── Modes and unprompted posts (phase 4) ────────────────────────────────────

/** What an owner (or an admin) may change about an enrolment. */
export interface GroupChannelSettings {
  mode?: GroupChannelMode;
  /** Both set, or both null (no quiet hours). */
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
  timezone?: string;
  maxUnpromptedPerDay?: number;
  minMinutesBetween?: number;
}

export class GroupChannelSettingsError extends Error {}

const SETTINGS_KEYS = ['mode', 'quietHoursStart', 'quietHoursEnd', 'timezone', 'maxUnpromptedPerDay', 'minMinutesBetween'] as const;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function checkSettings(patch: GroupChannelSettings): void {
  if (patch.mode !== undefined && !GROUP_CHANNEL_MODES.includes(patch.mode)) throw new GroupChannelSettingsError('Unknown mode');
  const hour = (h: number | null | undefined) => h === undefined || h === null || (Number.isInteger(h) && h >= 0 && h <= 23);
  if (!hour(patch.quietHoursStart) || !hour(patch.quietHoursEnd)) throw new GroupChannelSettingsError('Quiet hours are whole hours, 0–23');
  if ((patch.quietHoursStart === null) !== (patch.quietHoursEnd === null)
    || (patch.quietHoursStart === undefined) !== (patch.quietHoursEnd === undefined)) {
    throw new GroupChannelSettingsError('Set both quiet-hour bounds, or clear both');
  }
  if (patch.timezone !== undefined && !isTimeZone(patch.timezone)) throw new GroupChannelSettingsError('Unknown time zone');
  if (patch.maxUnpromptedPerDay !== undefined && !(Number.isInteger(patch.maxUnpromptedPerDay) && patch.maxUnpromptedPerDay >= 1 && patch.maxUnpromptedPerDay <= 48)) {
    throw new GroupChannelSettingsError('Unprompted posts per day: 1–48');
  }
  if (patch.minMinutesBetween !== undefined && !(Number.isInteger(patch.minMinutesBetween) && patch.minMinutesBetween >= 10 && patch.minMinutesBetween <= 1440)) {
    throw new GroupChannelSettingsError('Minutes between unprompted posts: 10–1440');
  }
}

/**
 * Change an enrolment's mode, quiet hours or rate limit: the owner's own, or
 * any for an admin. Null when not found / not allowed; throws
 * `GroupChannelSettingsError` for an invalid value.
 */
export async function updateGroupChannelSettings(
  id: string,
  actor: { userId: string; isAdmin: boolean },
  patch: GroupChannelSettings,
): Promise<GroupChannel | null> {
  if (!isUuid(id)) return null;
  checkSettings(patch);
  // Only these columns: a request body may carry anything else (owner, chat id, counters).
  const set: GroupChannelSettings = {};
  for (const key of SETTINGS_KEYS) {
    if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key];
  }
  if (Object.keys(set).length === 0) throw new GroupChannelSettingsError('Nothing to change');
  const where = actor.isAdmin
    ? eq(groupChannels.id, id)
    : and(eq(groupChannels.id, id), eq(groupChannels.ownerUserId, actor.userId));
  const [updated] = await getDb().update(groupChannels).set({ ...set, updatedAt: new Date() }).where(where).returning();
  if (!updated) return null;
  invalidateChannel(updated.channelType, updated.channelId);
  await audit(actor.userId, updated, { settings: set, byAdmin: actor.isAdmin && updated.ownerUserId !== actor.userId });
  return updated;
}

/** Enrolments that may post unprompted (`listen`, `proactive`). Not cached: read once per probe tick. */
export async function listUnpromptedGroupChannels(): Promise<GroupChannel[]> {
  return getDb().select().from(groupChannels).where(ne(groupChannels.mode, 'mention'));
}

/**
 * Claim the channel's next unprompted post: true when the minimum gap since
 * the last one has passed and today's count (`day`, local to the channel) is
 * under the cap. One conditional UPDATE, so of two processes only one wins.
 */
export async function claimUnpromptedSlot(group: GroupChannel, now: Date, day: string): Promise<boolean> {
  const since = new Date(now.getTime() - group.minMinutesBetween * 60_000);
  const [row] = await getDb()
    .update(groupChannels)
    .set({
      lastUnpromptedAt: now,
      unpromptedDay: day,
      unpromptedCount: sql`CASE WHEN ${groupChannels.unpromptedDay} = ${day} THEN ${groupChannels.unpromptedCount} + 1 ELSE 1 END`,
    })
    .where(and(
      eq(groupChannels.id, group.id),
      ne(groupChannels.mode, 'mention'),
      or(isNull(groupChannels.lastUnpromptedAt), lte(groupChannels.lastUnpromptedAt, since)),
      or(sql`${groupChannels.unpromptedDay} IS DISTINCT FROM ${day}`, sql`${groupChannels.unpromptedCount} < ${groupChannels.maxUnpromptedPerDay}`),
    ))
    .returning({ id: groupChannels.id });
  return row !== undefined;
}

/** A member's ✅ (1) or ❌ (-1) on one of the bot's messages; a second reaction replaces the first. */
export async function recordGroupFeedback(input: {
  groupChannelId: string;
  messageId: string;
  threadId?: string;
  userId: string;
  value: 1 | -1;
}): Promise<void> {
  await getDb()
    .insert(groupChannelFeedback)
    .values({ ...input, threadId: input.threadId ?? null })
    .onConflictDoUpdate({
      target: [groupChannelFeedback.groupChannelId, groupChannelFeedback.messageId, groupChannelFeedback.userId],
      set: { value: input.value, createdAt: new Date() },
    });
}

/** The ✅ / ❌ on the channel's bot messages since `since`: what slows its listen gate (`feedbackSlowdown`). */
export async function recentGroupFeedback(groupChannelId: string, since: Date): Promise<{ up: number; down: number }> {
  const [row] = await getDb()
    .select({
      up: sql<number>`count(*) FILTER (WHERE ${groupChannelFeedback.value} = 1)::int`,
      down: sql<number>`count(*) FILTER (WHERE ${groupChannelFeedback.value} = -1)::int`,
    })
    .from(groupChannelFeedback)
    .where(and(eq(groupChannelFeedback.groupChannelId, groupChannelId), sql`${groupChannelFeedback.createdAt} >= ${since}`));
  return { up: Number(row?.up ?? 0), down: Number(row?.down ?? 0) };
}

/** The member took their reaction back. Only the matching value is removed (✅ then ❌, then ✅ removed, keeps ❌). */
export async function removeGroupFeedback(input: { groupChannelId: string; messageId: string; userId: string; value: 1 | -1 }): Promise<void> {
  await getDb().delete(groupChannelFeedback).where(and(
    eq(groupChannelFeedback.groupChannelId, input.groupChannelId),
    eq(groupChannelFeedback.messageId, input.messageId),
    eq(groupChannelFeedback.userId, input.userId),
    eq(groupChannelFeedback.value, input.value),
  ));
}

/** Remove an enrolment: the owner's own, or any for an admin. Null when not found / not allowed. */
export async function removeGroupChannel(id: string, actor: { userId: string; isAdmin: boolean }): Promise<GroupChannel | null> {
  const where = actor.isAdmin
    ? eq(groupChannels.id, id)
    : and(eq(groupChannels.id, id), eq(groupChannels.ownerUserId, actor.userId));
  const removed = await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(groupChannels).where(where).for('update').limit(1);
    if (!row) return null;
    // A bound channel's space records that its binding ended (I10).
    if (row.workspaceId) {
      const { endBindingInTx } = await import('./group-bridge');
      await endBindingInTx(tx, row, { userId: actor.userId }, 'channel_removed');
    }
    await tx.delete(groupChannels).where(eq(groupChannels.id, row.id));
    return row;
  });
  if (removed) {
    invalidateChannel(removed.channelType, removed.channelId);
    forgetThreads(removed.id);
    // Its spend budget goes with it (the budget names the enrolment, not a FK).
    await import('@/security/spend-budgets')
      .then(({ deleteGroupChannelBudgets }) => deleteGroupChannelBudgets(removed.id))
      .catch((err: unknown) => channelLogger.error({ err, groupChannelId: removed.id }, 'Could not delete the removed channel\'s spend budget'));
  }
  if (removed) await audit(actor.userId, removed, { deleted: true, byAdmin: actor.isAdmin && removed.ownerUserId !== actor.userId });
  return removed ?? null;
}

async function audit(userId: string, group: GroupChannel, details: Record<string, unknown>): Promise<void> {
  try {
    await auditRepository.log({
      userId,
      action: 'settings_changed',
      resourceType: 'group_channel',
      resourceId: group.id,
      details: { channelType: group.channelType, channelId: group.channelId, ownerUserId: group.ownerUserId, ...details },
    });
  } catch (err) {
    // The change itself is committed; a missing audit row is logged, not fatal.
    channelLogger.error({ err, groupChannelId: group.id }, 'group channel audit log failed');
  }
}

/**
 * The platform gave the chat a new id (a Telegram group upgraded to a
 * supergroup): move the enrolment and the chat's sessions to it, so the bot
 * keeps answering there and notices for open work still arrive. False when
 * the chat was not enrolled.
 */
export async function moveGroupChannel(channelType: GroupChannelType, fromId: string, toId: string): Promise<boolean> {
  const moved = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(groupChannels)
      .set({ channelId: toId, updatedAt: new Date() })
      .where(and(eq(groupChannels.channelType, channelType), eq(groupChannels.channelId, fromId)))
      .returning();
    if (!row) return null;
    await tx
      .update(sessions)
      .set({ channelId: toId })
      .where(and(eq(sessions.channelType, channelType), eq(sessions.channelId, fromId)));
    return row;
  });
  invalidateChannel(channelType, fromId);
  invalidateChannel(channelType, toId);
  if (moved) channelLogger.info({ channelType, fromId, toId }, 'Group channel moved to a new chat id');
  return moved !== null;
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * `groupId:threadTs` → known state. Asked for every threaded reply in an
 * enrolled channel, including ones between people that never involve the
 * bot, so both answers are cached: "no" for 30 s, "yes" for 10 min (a thread
 * session can be deleted, after which the bot must stop following the
 * thread). This process creates the thread sessions, and
 * `resolveGroupSession` records the "yes" straight away.
 */
const threadActive = new Map<string, { active: boolean; at: number }>();
const THREAD_ACTIVE_TTL_MS = 10 * 60_000;
const MAX_THREAD_KEYS = 10_000;

function rememberThread(key: string, active: boolean): void {
  threadActive.delete(key);
  threadActive.set(key, { active, at: Date.now() });
  if (threadActive.size > MAX_THREAD_KEYS) threadActive.delete(threadActive.keys().next().value as string);
}

/**
 * A member deleted their session for this thread: re-check it next time, so
 * the bot stops following a thread nobody has a session in any more.
 */
export function forgetGroupThread(groupChannelId: string, threadId: string): void {
  threadActive.delete(`${groupChannelId}:${threadId}`);
}

/** Whether the bot is already part of this thread (some member talked to it there). */
export async function isGroupThreadActive(groupChannelId: string, threadId: string): Promise<boolean> {
  const key = `${groupChannelId}:${threadId}`;
  const hit = threadActive.get(key);
  if (hit && Date.now() - hit.at < (hit.active ? THREAD_ACTIVE_TTL_MS : CACHE_TTL_MS)) return hit.active;
  // A thread of a bound channel is followed once it has a room (§9.4).
  const active = await sessionRepository.hasGroupThread(groupChannelId, threadId)
    || (await import('./group-bridge').then(({ bridgedRoomOf }) => bridgedRoomOf(groupChannelId, threadId))) !== null;
  rememberThread(key, active);
  return active;
}

/**
 * The acting member's session for a group thread, created on first use in the
 * member's own default workspace — turns run with the member's own data and
 * permissions. Never another user's session.
 *
 * For a channel bound to a space (§9.4) it is the thread's room instead,
 * shared by the members, whose turns run as their requester through
 * `handleRoomMessage`; the caller checks the member's access first.
 */
export async function resolveGroupSession(input: {
  userId: string;
  group: GroupChannel;
  threadId: string;
  title?: string;
  /** Kept from the retention sweep (the unprompted-posts session: its cost rows must keep counting). */
  pinned?: boolean;
}): Promise<string> {
  const threadKey = `${input.group.id}:${input.threadId}`;
  if (input.group.workspaceId) {
    const { resolveBridgedRoom } = await import('./group-bridge');
    const roomId = await resolveBridgedRoom(input.group, input.threadId, input.title);
    rememberThread(threadKey, true);
    return roomId;
  }
  const existing = await sessionRepository.findGroupThreadSession(input.userId, input.group.id, input.threadId);
  if (existing) {
    rememberThread(threadKey, true);
    return existing.id;
  }
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const workspace = await getOrgWorkspaceManager().ensureDefaultWorkspace(input.userId);
  try {
    const session = await sessionRepository.create({
      userId: input.userId,
      workspaceId: workspace.id,
      channelType: input.group.channelType,
      channelId: input.group.channelId,
      threadId: input.threadId,
      groupChannelId: input.group.id,
      title: input.title ?? `${input.group.label ?? input.group.channelId} thread`,
      status: 'active',
      ...(input.pinned ? { pinned: true } : {}),
    });
    rememberThread(threadKey, true);
    return session.id;
  } catch (err) {
    // Two messages from the same member raced to create the row; the unique
    // index let one through.
    const raced = await sessionRepository.findGroupThreadSession(input.userId, input.group.id, input.threadId);
    if (raced) {
      rememberThread(threadKey, true);
      return raced.id;
    }
    throw err;
  }
}
