/**
 * Outbound channel ownership.
 *
 * Anything a user configures that makes the bot send to a channel id of the
 * user's choosing (a notify hook's `notifyChannels`, its `channelType` /
 * `channelId` pair, a notification's `deliverTo`) must only reach chats that
 * user owns. Otherwise one user could make the bot message another user's
 * Telegram / Slack / Teams / WhatsApp chat, or any third-party chat the bot
 * is in.
 *
 * A (channelType, channelId) pair is the user's when:
 *  - a `channel_identities` row links it to the user (the same mapping inbound
 *    messages are routed by), or
 *  - it is a verified binding in the legacy `users.channelBindings` column
 *    (what "Notify me" / notifyOwner sends to), or
 *  - for 'webchat' / 'api': the id is the user's own id, or a live web chat
 *    connection that belongs to the user.
 *
 * Sessions are deliberately not used as proof: POST /api/sessions lets a user
 * create a session with any channelType / channelId, so a session row says
 * nothing about who owns the chat.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { channelIdentities } from '@/db/schema/channel-identities';
import { type ChannelBinding, users } from '@/db/schema/users';

/** Channel types that address the user's own in-app surfaces. */
const IN_APP_CHANNELS = new Set(['webchat', 'api']);

/** Split a `type:id` target on its FIRST colon (Teams ids contain colons). */
export function parseChannelTarget(spec: string): { channelType: string; channelId: string } | null {
  const idx = spec.indexOf(':');
  if (idx <= 0) return null;
  const channelType = spec.slice(0, idx).trim();
  const channelId = spec.slice(idx + 1).trim();
  if (!channelType || !channelId) return null;
  return { channelType, channelId };
}

function legacyBindings(raw: unknown): ChannelBinding[] {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? (v as ChannelBinding[]) : [];
}

/** True when `channelId` on `channelType` is a chat linked to `userId`. */
export async function userOwnsChannel(userId: string, channelType: string, channelId: string): Promise<boolean> {
  if (!userId || !channelType || !channelId) return false;

  if (IN_APP_CHANNELS.has(channelType)) {
    if (channelId === userId) return true;
    if (channelType === 'webchat') {
      const { webChatChannel } = await import('@/channels/webchat');
      if (webChatChannel.connectionOwner(channelId) === userId) return true;
    }
  }

  const db = getDb();
  const [identity] = await db
    .select({ id: channelIdentities.id })
    .from(channelIdentities)
    .where(and(
      eq(channelIdentities.userId, userId),
      eq(channelIdentities.channelType, channelType),
      eq(channelIdentities.externalId, channelId),
    ))
    .limit(1);
  if (identity) return true;

  const [user] = await db
    .select({ channelBindings: users.channelBindings })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return legacyBindings(user?.channelBindings).some(
    (b) => b.isVerified && b.channelType === channelType && b.channelUserId === channelId,
  );
}
