/**
 * Outbound notification targets: who may make the bot message which chat.
 *
 * Every send to a channel id chosen by a user's configuration or by an agent
 * (a notify hook's `notifyChannels` / `channelType` + `channelId`, a
 * notification's `deliverTo`, a monitor's session, `messaging.send_message`)
 * goes through `resolveTarget` / `deliver`. Without it one user could make
 * the bot message another user's Telegram / Slack / Teams / WhatsApp chat,
 * or any chat the bot is in.
 *
 * A (channelType, channelId) target is allowed for a user when:
 *  - it is linked to the user: a VERIFIED channel identity that the canonical
 *    precedence gives to this user (a channel_identities row decides; the
 *    legacy `users.channelBindings` JSON counts only for a chat with no row,
 *    and only when exactly one user holds a verified entry for it), or the
 *    user's 1:1 conversation with the bot on that identity (a Teams personal
 *    conversation, a Slack DM); or
 *  - an admin approved it as a shared destination (`notification_destinations`)
 *    instance-wide or for one of the user's orgs.
 *
 * 'webchat' and 'api' address the in-app surfaces: the only valid target is
 * the user's own id (`webchat:<userId>`), delivered to all of the user's live
 * web chat connections. Raw connection ids are never accepted. Any other
 * channel type has no outbound address and is never a target.
 *
 * Callers load a `NotifyScope` once (a few queries, no writes) and resolve
 * every target against it; each target is checked exactly once.
 */
import { eq, inArray, isNull, or } from 'drizzle-orm';
import { getUMI } from '@/channels/interface';
import type { ChannelResponse, ChannelType } from '@/core/types';
import { getDb } from '@/db/postgres';
import { channelIdentities } from '@/db/schema/channel-identities';
import { notificationDestinations } from '@/db/schema/notification-destinations';
import { orgMembers } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';

/** The external messaging channels: the only ones with outbound chat ids. */
export const EXTERNAL_CHANNEL_TYPES = ['telegram', 'slack', 'teams', 'whatsapp'] as const;
export const EXTERNAL_CHANNELS: ReadonlySet<string> = new Set(EXTERNAL_CHANNEL_TYPES);

/** Channel types that address the user's own in-app surfaces. */
export const IN_APP_CHANNELS: ReadonlySet<string> = new Set(['webchat', 'api']);

export const NOT_ALLOWED_MESSAGE =
  'not linked to you and not an approved shared destination; ask an admin to add it under Admin → Notification destinations';

export const TEAMS_UNRESOLVED_MESSAGE =
  'the Teams conversation cannot be resolved yet; the user must message the bot in Teams once (after a restart or before the first send)';

export type BlockReason = 'not_allowed' | 'unresolved';

export class NotifyTargetNotAllowedError extends Error {
  constructor(readonly target: string, readonly reason: BlockReason = 'not_allowed') {
    super(reason === 'unresolved' ? `${target}: ${TEAMS_UNRESOLVED_MESSAGE}` : `${target} is ${NOT_ALLOWED_MESSAGE}`);
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

export type TargetResolution =
  | { allowed: true; target: string; send: (response: ChannelResponse) => Promise<void> }
  | { allowed: false; target: string; reason: BlockReason; error: string };

export type DeliveryResult =
  | { ok: true; target: string }
  | { ok: false; target: string; reason: BlockReason | 'send_failed'; error: string };

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
 * The user's verified channel identities under the canonical precedence.
 * Read-only: the inbound path (ChannelBindingManager.findUserByExternalId)
 * is the only place that backfills legacy entries into channel_identities.
 *
 * Queries: the user's rows; the user's legacy column; the rows that decide
 * those legacy chats instead; other users' verified legacy claims on them.
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

  // A chat that has a row is decided by that row (it may belong to someone
  // else now: the chat was relinked, or the row is unverified).
  const withRow = await db
    .select({ channelType: channelIdentities.channelType, externalId: channelIdentities.externalId })
    .from(channelIdentities)
    .where(inArray(channelIdentities.externalId, legacy.map((b) => b.channelUserId)));
  const rowKeys = new Set(withRow.map((r) => key(r.channelType, r.externalId)));
  const candidates = legacy.filter((b) => !rowKeys.has(key(b.channelType, b.channelUserId)));
  if (candidates.length === 0) return out;

  // No row: ours only if no other user holds a verified legacy entry for it.
  const { legacyOwners, legacyKey } = await import('@/security/channel-bindings');
  const others = await legacyOwners(
    candidates.map((b) => ({ channelType: b.channelType, externalId: b.channelUserId })),
    { excludeUserId: userId },
  );
  for (const b of candidates) {
    if ((others.get(legacyKey(b.channelType, b.channelUserId)) ?? []).length > 0) continue;
    out.push({ channelType: b.channelType, externalId: b.channelUserId, handle: b.channelUserName });
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

class UnresolvedTargetError extends Error {}

/**
 * Decide a target once. When allowed, `send` delivers to it, resolving the
 * address to something deliverable: webchat/api go to all of the user's
 * live web chat connections; a Teams identity (aadObjectId) goes to the
 * user's 1:1 conversation(s) with the bot.
 */
export async function resolveTarget(scope: NotifyScope, channelType: string, channelId: string): Promise<TargetResolution> {
  const target = `${channelType}:${channelId}`;
  const blocked = (reason: BlockReason): TargetResolution => ({
    allowed: false, target, reason, error: new NotifyTargetNotAllowedError(target, reason).message,
  });
  if (!channelType || !channelId) return blocked('not_allowed');

  if (IN_APP_CHANNELS.has(channelType)) {
    if (channelId !== scope.userId) return blocked('not_allowed');
    return {
      allowed: true, target,
      send: async (response) => {
        const { webChatChannel } = await import('@/channels/webchat');
        await webChatChannel.sendToUser(scope.userId, response);
      },
    };
  }
  if (!EXTERNAL_CHANNELS.has(channelType)) return blocked('not_allowed');

  const direct: TargetResolution = {
    allowed: true, target,
    send: async (response) => { await getUMI().send(channelType as ChannelType, channelId, response); },
  };
  const k = key(channelType, channelId);

  if (channelType === 'teams') {
    const { teamsChannel } = await import('@/channels/teams');
    await teamsChannel.ensureReferencesLoaded();
    if (scope.owned.has(k)) {
      // The owner's aadObjectId: deliver to their 1:1 conversation(s).
      return {
        allowed: true, target,
        send: async (response) => {
          const conversations = teamsChannel.personalConversationsFor(channelId);
          if (conversations.length === 0) throw new UnresolvedTargetError(target);
          for (const conversationId of conversations) await getUMI().send('teams', conversationId, response);
        },
      };
    }
    if (scope.allowlist.has(k)) return direct;
    const teamsUser = teamsChannel.personalConversationUser(channelId);
    if (teamsUser) return scope.owned.has(key('teams', teamsUser)) ? direct : blocked('not_allowed');
    // Unknown conversation: whose it is cannot be told until Teams sends an
    // activity from it; a known group chat / channel is simply not owned.
    return teamsChannel.hasConversation(channelId) ? blocked('not_allowed') : blocked('unresolved');
  }

  if (scope.owned.has(k) || scope.allowlist.has(k)) return direct;
  if (channelType === 'slack' && channelId.startsWith('D')) {
    const { slackChannel } = await import('@/channels/slack');
    const slackUser = await slackChannel.dmUser(channelId).catch(() => null);
    if (slackUser && scope.owned.has(key('slack', slackUser))) return direct;
  }
  return blocked('not_allowed');
}

/** Resolve and send; never throws. */
export async function deliver(
  scope: NotifyScope,
  channelType: string,
  channelId: string,
  response: ChannelResponse,
): Promise<DeliveryResult> {
  const r = await resolveTarget(scope, channelType, channelId);
  if (!r.allowed) return { ok: false, target: r.target, reason: r.reason, error: r.error };
  return sendResolved(r, response);
}

/** Send through an allowed resolution; never throws. */
export async function sendResolved(
  r: Extract<TargetResolution, { allowed: true }>,
  response: ChannelResponse,
): Promise<DeliveryResult> {
  try {
    await r.send(response);
    return { ok: true, target: r.target };
  } catch (err) {
    if (err instanceof UnresolvedTargetError) {
      return { ok: false, target: r.target, reason: 'unresolved', error: new NotifyTargetNotAllowedError(r.target, 'unresolved').message };
    }
    return { ok: false, target: r.target, reason: 'send_failed', error: (err as Error).message };
  }
}

/** May `userId`'s hooks, notifications, monitors and agents message this chat? */
export async function canNotify(userId: string, channelType: string, channelId: string): Promise<boolean> {
  if (!userId) return false;
  return (await resolveTarget(await loadNotifyScope(userId), channelType, channelId)).allowed;
}

/** The targets "notify me" sends to: the user's own external identities. */
export function ownerTargets(scope: NotifyScope): { channelType: string; channelId: string; label: string }[] {
  return scope.identities
    .filter((i) => EXTERNAL_CHANNELS.has(i.channelType))
    .map((i) => ({
      channelType: i.channelType,
      channelId: i.externalId,
      label: `${i.channelType}:${i.handle || i.externalId}`,
    }));
}
