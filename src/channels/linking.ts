import { getRedis } from '@/db/redis';
import { userRepository } from '@/db/repositories/user-repository';
import type { ChannelType } from '@/core/types';
import { channelLogger } from '@/utils/logger';
import crypto from 'crypto';

const LINK_CODE_PREFIX = 'link:';
const LINK_CODE_TTL = 300; // 5 minutes

export interface LinkCodeData {
  channelType: ChannelType;
  channelUserId: string;
  channelUserName?: string;
}

/**
 * Generate a 6-character alphanumeric linking code and store in Redis.
 */
export async function generateLinkCode(data: LinkCodeData): Promise<string> {
  const redis = getRedis();
  const code = randomCode(6);
  const key = LINK_CODE_PREFIX + code;

  await redis.setex(key, LINK_CODE_TTL, JSON.stringify(data));

  channelLogger.info(
    { code, channelType: data.channelType, channelUserId: data.channelUserId },
    'Link code generated'
  );

  return code;
}

/**
 * Redeem a linking code: bind the channel identity to the given user.
 */
export async function redeemLinkCode(
  code: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const redis = getRedis();
  const key = LINK_CODE_PREFIX + code.toUpperCase();

  const raw = await redis.get(key);
  if (!raw) {
    return { success: false, error: 'Invalid or expired link code' };
  }

  const data: LinkCodeData = JSON.parse(raw);

  // Verify user exists
  const user = await userRepository.findById(userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }

  // Add channel binding
  await userRepository.addChannelBinding(userId, {
    channelType: data.channelType as 'telegram' | 'teams' | 'slack' | 'whatsapp' | 'webchat',
    channelUserId: data.channelUserId,
    channelUserName: data.channelUserName,
    isVerified: true,
    createdAt: new Date().toISOString(),
  });

  // Delete the used code
  await redis.del(key);

  channelLogger.info(
    { userId, channelType: data.channelType, channelUserId: data.channelUserId },
    'Account linked via code'
  );

  return { success: true };
}

function randomCode(length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}
