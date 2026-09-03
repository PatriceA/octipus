/**
 * Channel linking — Phase 2e bridge.
 *
 * Pre-Phase-2d this module owned the link-code lifecycle directly:
 * codes were stored in Redis with a 5-min TTL and the redeem path
 * mutated `users.channelBindings` JSONB. Phase 2d landed a proper
 * `ChannelBindingManager` backed by Postgres tables (`channel_link_codes`
 * + `channel_identities`); this commit rewires the legacy callers
 * (channel adapters, `/api/auth/redeem-link-code`) onto it without
 * changing their public API.
 *
 * Why preserve the API: telegram / slack / whatsapp / teams adapters
 * each call `generateLinkCode(...)` from inside their `/link` command
 * handler, and `auth.ts` calls `redeemLinkCode(code, userId)`. Those
 * call sites stay identical — the only change is where the code +
 * binding land at rest. From Phase 2e on, the new Postgres tables are
 * the single source of truth.
 *
 * The legacy JSONB column is left in place as belt-and-suspenders;
 * `ChannelBindingManager.findUserByExternalId` already reads from it
 * and backfills into `channel_identities` on a miss-then-hit, so any
 * binding created before Phase 2d keeps resolving.
 */
import type { ChannelType } from '@/core/types';
import { getChannelBindingManager } from '@/security/channel-bindings';
import { userRepository } from '@/db/repositories/user-repository';
import { channelLogger } from '@/utils/logger';

export interface LinkCodeData {
  channelType: ChannelType;
  channelUserId: string;
  channelUserName?: string;
}

/**
 * Generate a link code for a channel external_id. The code lives in
 * `channel_link_codes` and is single-use; expiry is governed by the
 * manager (15 minutes today, vs the legacy 5-minute Redis TTL — the
 * longer window matches what users typically need to switch from
 * their phone to a desktop browser).
 */
export async function generateLinkCode(data: LinkCodeData): Promise<string> {
  const link = await getChannelBindingManager().createPendingLink(
    data.channelType,
    data.channelUserId,
    data.channelUserName,
  );
  channelLogger.info(
    { code: link.code, channelType: data.channelType, channelUserId: data.channelUserId },
    'Link code generated',
  );
  return link.code;
}

/**
 * Redeem a link code on behalf of `userId`. Returns the same
 * `{ success, error }` shape callers expect; the new `error` strings
 * are the same human-readable values the manager surfaces (mapped
 * here so the existing UI strings keep working).
 *
 * Also writes a legacy JSONB entry on the user so any code path that
 * still reads `users.channelBindings` directly (older parts of the
 * root agent we haven't migrated yet) sees the new binding.
 */
export async function redeemLinkCode(
  code: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await getChannelBindingManager().redeem(userId, code);
  if (!result.ok) {
    switch (result.reason) {
      case 'unknown_code':
      case 'expired':
        return { success: false, error: 'Invalid or expired link code' };
      case 'already_redeemed':
        return { success: false, error: 'This code has already been used' };
      case 'already_bound_to_another_user':
        return { success: false, error: 'This channel account is already linked to another user' };
      default:
        return { success: false, error: 'Could not link the channel' };
    }
  }

  // Mirror into legacy JSONB so any unmigrated reader sees the new
  // binding. Best-effort — failure here doesn't reverse the canonical
  // write into `channel_identities`.
  try {
    await userRepository.addChannelBinding(userId, {
      channelType: result.binding.channelType as 'telegram' | 'teams' | 'slack' | 'whatsapp' | 'webchat',
      channelUserId: result.binding.externalId,
      channelUserName: result.binding.externalHandle ?? undefined,
      isVerified: true,
      createdAt: result.binding.createdAt.toISOString(),
    });
  } catch (err) {
    channelLogger.warn({ err, userId }, 'Legacy JSONB mirror after redeem failed (canonical row already written)');
  }

  channelLogger.info(
    { userId, channelType: result.binding.channelType, channelUserId: result.binding.externalId },
    'Account linked via code',
  );
  return { success: true };
}
