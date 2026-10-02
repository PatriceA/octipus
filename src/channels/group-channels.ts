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
import { and, eq } from 'drizzle-orm';
import { auditRepository } from '@/db/repositories/audit-repository';
import { isUuid } from '@/db/repositories/scoped';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getDb } from '@/db/postgres';
import { type GroupChannel, groupChannels } from '@/db/schema/group-channels';
import { users } from '@/db/schema/users';
import { channelLogger } from '@/utils/logger';

/** Chat platforms group mode supports so far (phase 1 of the plan: Slack). */
export const GROUP_CHANNEL_TYPES = ['slack'] as const;
export type GroupChannelType = (typeof GROUP_CHANNEL_TYPES)[number];

/** A group channel with the owner's name, for the settings and admin pages. */
export interface GroupChannelView extends GroupChannel {
  ownerName: string;
  ownerActive: boolean;
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
    const [updated] = await db
      .update(groupChannels)
      .set({ ownerUserId: input.userId, updatedAt: new Date() })
      // Guard on the previous owner so two members taking over at once cannot both win.
      .where(and(eq(groupChannels.id, existing.id), eq(groupChannels.ownerUserId, existing.ownerUserId)))
      .returning();
    invalidateChannel(input.channelType, input.channelId);
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
    })
    .from(groupChannels)
    .innerJoin(users, eq(users.id, groupChannels.ownerUserId))
    .where(ownerUserId ? eq(groupChannels.ownerUserId, ownerUserId) : undefined)
    .orderBy(groupChannels.createdAt);
  return rows.map(r => ({ ...r.group, ownerName: r.ownerName, ownerActive: r.ownerActive }));
}

export function listGroupChannelsForOwner(userId: string): Promise<GroupChannelView[]> {
  return listViews(userId);
}

export function listAllGroupChannels(): Promise<GroupChannelView[]> {
  return listViews();
}

/** Remove an enrolment: the owner's own, or any for an admin. Null when not found / not allowed. */
export async function removeGroupChannel(id: string, actor: { userId: string; isAdmin: boolean }): Promise<GroupChannel | null> {
  const where = actor.isAdmin
    ? eq(groupChannels.id, id)
    : and(eq(groupChannels.id, id), eq(groupChannels.ownerUserId, actor.userId));
  const [removed] = await getDb().delete(groupChannels).where(where).returning();
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
  const active = await sessionRepository.hasGroupThread(groupChannelId, threadId);
  rememberThread(key, active);
  return active;
}

/**
 * The acting member's session for a group thread, created on first use in the
 * member's own default workspace — turns run with the member's own data and
 * permissions. Never another user's session.
 */
export async function resolveGroupSession(input: {
  userId: string;
  group: GroupChannel;
  threadId: string;
  title?: string;
}): Promise<string> {
  const threadKey = `${input.group.id}:${input.threadId}`;
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
