import { sessionRepository } from '@/db/repositories/session-repository';
import { coreLogger } from '@/utils/logger';

/**
 * Resolve a session ID to an existing session or create a new one.
 * Handles both UUID-based and channel-based session identifiers.
 */
export async function resolveSession(sessionId: string, userId: string, channel: string): Promise<string> {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(sessionId)) {
    const existing = await sessionRepository.findById(sessionId);
    if (existing) return sessionId;

    const session = await sessionRepository.create({
      id: sessionId,
      userId,
      channelType: channel,
      channelId: sessionId,
      title: `${channel} conversation`,
      status: 'active',
    });
    coreLogger.info({ sessionId: session.id, channel }, 'Created session for UUID');
    return session.id;
  }

  const parts = sessionId.split('-');
  const channelType = parts[0] || channel;
  const channelId = parts.slice(1).join('-') || sessionId;

  const existing = await sessionRepository.findByUserAndChannel(userId, channelType, channelId);
  if (existing) return existing.id;

  const session = await sessionRepository.create({
    userId,
    channelType,
    channelId,
    title: `${channelType} conversation`,
    status: 'active',
  });

  coreLogger.info({ sessionId: session.id, channelType, channelId }, 'Created new session for channel');
  return session.id;
}
