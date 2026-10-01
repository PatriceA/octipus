/**
 * Group channels — Octipus as a member of a shared chat.
 *
 * A workspace owner enrols a channel by typing `@octipus join` in it, which
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
import { sessionRepository } from '@/db/repositories/session-repository';
import { getDb } from '@/db/postgres';
import { type GroupChannel, groupChannels } from '@/db/schema/group-channels';
import { workspaces } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';
import { channelLogger } from '@/utils/logger';

/** Chat platforms group mode supports so far (phase 1 of the plan: Slack). */
export const GROUP_CHANNEL_TYPES = ['slack'] as const;
export type GroupChannelType = (typeof GROUP_CHANNEL_TYPES)[number];

/** A group channel with the owner's name, for the settings and admin pages. */
export interface GroupChannelView extends GroupChannel {
  ownerName: string;
  ownerActive: boolean;
  workspaceName: string;
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

/** Test seam, and called after every write in this module. */
export function clearGroupChannelCache(): void {
  cache.clear();
}

/** An enrolment is paused while its owner's account is deactivated. */
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
  | { status: 'enrolled'; group: GroupChannel; workspaceName: string }
  | { status: 'took_over'; group: GroupChannel; workspaceName: string; previousOwner: string }
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
 * `@octipus join` from a linked member. Enrols the channel into the member's
 * default workspace, or takes it over when the current owner is deactivated.
 * The caller has already established that `userId` posted in the channel.
 */
export async function joinGroupChannel(input: {
  channelType: GroupChannelType;
  channelId: string;
  label?: string | null;
  userId: string;
}): Promise<JoinResult> {
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const db = getDb();
  clearGroupChannelCache();
  const existing = await findGroupChannel(input.channelType, input.channelId);

  if (existing) {
    if (existing.ownerUserId === input.userId) return { status: 'already_yours', group: existing };
    const owner = await ownerSummary(existing.ownerUserId);
    if (owner.active) return { status: 'taken', ownerName: owner.name };
    const workspace = await getOrgWorkspaceManager().ensureDefaultWorkspace(input.userId);
    const [updated] = await db
      .update(groupChannels)
      .set({ ownerUserId: input.userId, workspaceId: workspace.id, updatedAt: new Date() })
      // Guard on the previous owner so two members taking over at once cannot both win.
      .where(and(eq(groupChannels.id, existing.id), eq(groupChannels.ownerUserId, existing.ownerUserId)))
      .returning();
    clearGroupChannelCache();
    if (!updated) return joinGroupChannel(input);
    await audit(input.userId, updated, { takenOverFrom: existing.ownerUserId });
    return { status: 'took_over', group: updated, workspaceName: workspace.name, previousOwner: owner.name };
  }

  const workspace = await getOrgWorkspaceManager().ensureDefaultWorkspace(input.userId);
  const [created] = await db
    .insert(groupChannels)
    .values({
      channelType: input.channelType,
      channelId: input.channelId,
      label: input.label ?? null,
      ownerUserId: input.userId,
      workspaceId: workspace.id,
    })
    .onConflictDoNothing()
    .returning();
  clearGroupChannelCache();
  // Lost a race with another member's join: report whoever won.
  if (!created) return joinGroupChannel(input);
  await audit(input.userId, created, { enrolled: true });
  return { status: 'enrolled', group: created, workspaceName: workspace.name };
}

export type LeaveResult = 'left' | 'not_enrolled' | 'not_owner';

/** `@octipus leave` — the owner (or an admin) removes the enrolment. */
export async function leaveGroupChannel(input: {
  channelType: GroupChannelType;
  channelId: string;
  userId: string;
  isAdmin: boolean;
}): Promise<LeaveResult> {
  clearGroupChannelCache();
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
      workspaceName: workspaces.name,
    })
    .from(groupChannels)
    .innerJoin(users, eq(users.id, groupChannels.ownerUserId))
    .innerJoin(workspaces, eq(workspaces.id, groupChannels.workspaceId))
    .where(ownerUserId ? eq(groupChannels.ownerUserId, ownerUserId) : undefined)
    .orderBy(groupChannels.createdAt);
  return rows.map(r => ({ ...r.group, ownerName: r.ownerName, ownerActive: r.ownerActive, workspaceName: r.workspaceName }));
}

export function listGroupChannelsForOwner(userId: string): Promise<GroupChannelView[]> {
  return listViews(userId);
}

export function listAllGroupChannels(): Promise<GroupChannelView[]> {
  return listViews();
}

/**
 * Move an enrolment to another of the owner's workspaces. Null when the
 * channel is not the caller's or the workspace is not theirs.
 */
export async function setGroupChannelWorkspace(id: string, userId: string, workspaceId: string): Promise<GroupChannel | null> {
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const workspace = await getOrgWorkspaceManager().findOwnedById(userId, workspaceId);
  if (!workspace) return null;
  const [updated] = await getDb()
    .update(groupChannels)
    .set({ workspaceId: workspace.id, updatedAt: new Date() })
    .where(and(eq(groupChannels.id, id), eq(groupChannels.ownerUserId, userId)))
    .returning();
  clearGroupChannelCache();
  if (updated) await audit(userId, updated, { workspaceId: workspace.id });
  return updated ?? null;
}

/** Remove an enrolment: the owner's own, or any for an admin. Null when not found / not allowed. */
export async function removeGroupChannel(id: string, actor: { userId: string; isAdmin: boolean }): Promise<GroupChannel | null> {
  const where = actor.isAdmin
    ? eq(groupChannels.id, id)
    : and(eq(groupChannels.id, id), eq(groupChannels.ownerUserId, actor.userId));
  const [removed] = await getDb().delete(groupChannels).where(where).returning();
  clearGroupChannelCache();
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

/** Whether the bot is already part of this thread (some member talked to it there). */
export function isGroupThreadActive(groupChannelId: string, threadId: string): Promise<boolean> {
  return sessionRepository.hasGroupThread(groupChannelId, threadId);
}

/**
 * The acting member's session for a group thread, created on first use in the
 * member's own default workspace. Never another user's session.
 */
export async function resolveGroupSession(input: {
  userId: string;
  group: GroupChannel;
  threadId: string;
  title?: string;
}): Promise<string> {
  const existing = await sessionRepository.findGroupThreadSession(input.userId, input.group.id, input.threadId);
  if (existing) return existing.id;
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
    return session.id;
  } catch (err) {
    // Two messages from the same member raced to create the row; the unique
    // index let one through.
    const raced = await sessionRepository.findGroupThreadSession(input.userId, input.group.id, input.threadId);
    if (raced) return raced.id;
    throw err;
  }
}
