/**
 * Outbound notification targets: who may make the bot message which chat.
 *
 * Anything that sends to a channel id chosen by a user's configuration or by
 * an unattended agent (a notify hook's `notifyChannels` / `channelType` +
 * `channelId`, a notification's `deliverTo`, a monitor's session, an
 * unattended `messaging.send_message`) goes through `canNotify` / `deliver`.
 * Without it one user could make the bot message another user's Telegram /
 * Slack / Teams / WhatsApp chat, or any third-party chat the bot is in.
 *
 * A (channelType, channelId) target is allowed for a user when:
 *  - it is linked to the user: a VERIFIED channel identity the canonical
 *    lookup (`ChannelBindingManager.findUserByExternalId`: channel_identities
 *    first, the legacy `users.channelBindings` JSON only when no row exists)
 *    resolves to this user; or the user's 1:1 conversation with the bot on
 *    that identity (a Teams personal conversation, a Slack DM); or
 *  - an admin approved it as a shared destination (`notification_destinations`)
 *    instance-wide or for one of the user's orgs.
 *
 * 'webchat' and 'api' address the in-app surfaces: the only valid target is
 * the user's own id (`webchat:<userId>`), delivered to all of the user's live
 * web chat connections. Raw connection ids are never accepted.
 *
 * Callers load a `NotifyScope` once and check every target against it.
 */
import { eq, inArray, isNull, or } from 'drizzle-orm';
import { getUMI } from '@/channels/interface';
import type { ChannelResponse, ChannelType } from '@/core/types';
import { getDb } from '@/db/postgres';
import { channelIdentities } from '@/db/schema/channel-identities';
import { notificationDestinations } from '@/db/schema/notification-destinations';
import { orgMembers } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';

/** Channel types that address the user's own in-app surfaces. */
export const IN_APP_CHANNELS: ReadonlySet<string> = new Set(['webchat', 'api']);

export const NOT_ALLOWED_MESSAGE =
  'not linked to you and not an approved shared destination; ask an admin to add it under Admin → Notification destinations';

export class NotifyTargetNotAllowedError extends Error {
  constructor(readonly target: string) {
    super(`${target} is ${NOT_ALLOWED_MESSAGE}`);
    this.name = 'NotifyTargetNotAllowedError';
  }
}

export interface OwnedIdentity {
  channelType: string;
  externalId: string;
  handle?: string | null;
}

export interface NotifyScope {
  userId: string;
  /** The user's verified channel identities, canonical precedence applied. */
  identities: OwnedIdentity[];
  owned: Set<string>;
  /** Admin-approved shared destinations visible to this user. */
  allowlist: Set<string>;
}

const key = (channelType: string, channelId: string) => `${channelType}\u0000${channelId}`;

/** Split a `type:id` target on its FIRST colon (Teams ids contain colons). */
export function parseChannelTarget(spec: string): { channelType: string; channelId: string } | null {
  const idx = spec.indexOf(':');
  if (idx <= 0) return null;
  const channelType = spec.slice(0, idx).trim();
  const channelId = spec.slice(idx + 1).trim();
  if (!channelType || !channelId) return null;
  return { channelType, channelId };
}

/**
 * The user's verified channel identities, resolved with the same precedence
 * inbound routing uses: a channel_identities row decides (and must be
 * verified); the legacy JSON column counts only for a chat with no row, and
 * only when the canonical lookup resolves it to this user.
 */
async function loadIdentities(userId: string): Promise<OwnedIdentity[]> {
  const db = getDb();
  const rows = await db
    .select({ channelType: channelIdentities.channelType, externalId: channelIdentities.externalId,
      handle: channelIdentities.externalHandle, verifiedAt: channelIdentities.verifiedAt })
    .from(channelIdentities)
    .where(eq(channelIdentities.userId, userId));
  const out: OwnedIdentity[] = rows
    .filter((r) => r.verifiedAt !== null)
    .map((r) => ({ channelType: r.channelType, externalId: r.externalId, handle: r.handle }));

  const [user] = await db.select({ channelBindings: users.channelBindings }).from(users).where(eq(users.id, userId)).limit(1);
  const { userRepository } = await import('@/db/repositories/user-repository');
  const legacy = userRepository.parseBindings(user?.channelBindings)
    .filter((b) => b.isVerified && b.channelType && b.channelUserId);
  if (legacy.length === 0) return out;

  // Legacy entries whose chat already has a row are decided by that row
  // (which may belong to someone else now: the chat was relinked).
  const withRow = await db
    .select({ channelType: channelIdentities.channelType, externalId: channelIdentities.externalId })
    .from(channelIdentities)
    .where(inArray(channelIdentities.externalId, legacy.map((b) => b.channelUserId)));
  const rowKeys = new Set(withRow.map((r) => key(r.channelType, r.externalId)));
  const { getChannelBindingManager } = await import('@/security/channel-bindings');
  for (const b of legacy) {
    if (rowKeys.has(key(b.channelType, b.channelUserId))) continue;
    // No row: the canonical lookup falls back to the JSON column (first match
    // wins across users) and backfills the row.
    if ((await getChannelBindingManager().findUserByExternalId(b.channelType, b.channelUserId)) === userId) {
      out.push({ channelType: b.channelType, externalId: b.channelUserId, handle: b.channelUserName });
    }
  }
  return out;
}

async function loadAllowlist(userId: string): Promise<Set<string>> {
  const db = getDb();
  const memberships = await db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, userId));
  const orgIds = memberships.map((m) => m.orgId);
  const rows = await db
    .select({ channelType: notificationDestinations.channelType, channelId: notificationDestinations.channelId })
    .from(notificationDestinations)
    .where(orgIds.length > 0
      ? or(isNull(notificationDestinations.orgId), inArray(notificationDestinations.orgId, orgIds))
      : isNull(notificationDestinations.orgId));
  return new Set(rows.map((r) => key(r.channelType, r.channelId)));
}

/** Load everything needed to check a user's targets, once per call site. */
export async function loadNotifyScope(userId: string): Promise<NotifyScope> {
  const [identities, allowlist] = await Promise.all([loadIdentities(userId), loadAllowlist(userId)]);
  return {
    userId,
    identities,
    owned: new Set(identities.map((i) => key(i.channelType, i.externalId))),
    allowlist,
  };
}

/** The Teams user of a 1:1 conversation, or undefined (unknown / group / channel). */
async function teamsConversationUser(conversationId: string): Promise<string | undefined> {
  try {
    const { teamsChannel } = await import('@/channels/teams');
    return teamsChannel.personalConversationUser(conversationId);
  } catch {
    return undefined;
  }
}

/** True when the target is one of the user's own chats (not via the allowlist). */
async function isOwnedTarget(scope: NotifyScope, channelType: string, channelId: string): Promise<boolean> {
  if (IN_APP_CHANNELS.has(channelType)) return channelId === scope.userId;
  if (scope.owned.has(key(channelType, channelId))) return true;
  if (channelType === 'teams') {
    const teamsUser = await teamsConversationUser(channelId);
    return !!teamsUser && scope.owned.has(key('teams', teamsUser));
  }
  if (channelType === 'slack' && channelId.startsWith('D')) {
    try {
      const { slackChannel } = await import('@/channels/slack');
      const slackUser = await slackChannel.dmUser(channelId);
      return !!slackUser && scope.owned.has(key('slack', slackUser));
    } catch {
      return false;
    }
  }
  return false;
}

/** Check a target against a loaded scope. */
export async function scopeAllows(scope: NotifyScope, channelType: string, channelId: string): Promise<boolean> {
  if (!channelType || !channelId) return false;
  if (await isOwnedTarget(scope, channelType, channelId)) return true;
  return !IN_APP_CHANNELS.has(channelType) && scope.allowlist.has(key(channelType, channelId));
}

/** May `userId`'s hooks, notifications and unattended agents message this chat? */
export async function canNotify(userId: string, channelType: string, channelId: string): Promise<boolean> {
  if (!userId) return false;
  return scopeAllows(await loadNotifyScope(userId), channelType, channelId);
}

/** The targets "notify me" sends to: the user's own external identities. */
export function ownerTargets(scope: NotifyScope): { channelType: string; channelId: string; label: string }[] {
  return scope.identities
    .filter((i) => !IN_APP_CHANNELS.has(i.channelType))
    .map((i) => ({
      channelType: i.channelType,
      channelId: i.externalId,
      label: `${i.channelType}:${i.handle || i.externalId}`,
    }));
}

/**
 * Send to a target after checking it against the scope. Throws
 * NotifyTargetNotAllowedError for a disallowed target.
 *
 * Addresses are resolved to something deliverable: webchat/api go to all of
 * the user's live web chat connections; a Teams identity (aadObjectId) goes to
 * the user's 1:1 conversation(s) with the bot.
 */
export async function deliver(
  scope: NotifyScope,
  channelType: string,
  channelId: string,
  response: ChannelResponse,
): Promise<void> {
  if (!(await scopeAllows(scope, channelType, channelId))) {
    throw new NotifyTargetNotAllowedError(`${channelType}:${channelId}`);
  }
  if (IN_APP_CHANNELS.has(channelType)) {
    const { webChatChannel } = await import('@/channels/webchat');
    await webChatChannel.sendToUser(scope.userId, response);
    return;
  }
  const umi = getUMI();
  if (channelType === 'teams' && scope.owned.has(key('teams', channelId))) {
    const { teamsChannel } = await import('@/channels/teams');
    const conversations = teamsChannel.personalConversationsFor(channelId);
    if (conversations.length === 0) {
      throw new Error('No Teams conversation with this user yet; message the bot in Teams first');
    }
    for (const conversationId of conversations) await umi.send('teams', conversationId, response);
    return;
  }
  await umi.send(channelType as ChannelType, channelId, response);
}
