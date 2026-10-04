import { sessionRepository } from '@/db/repositories/session-repository';
import { resolveTurnWorkspace } from './context';
import { coreLogger } from '@/utils/logger';

/**
 * The workspace a turn (or a new session) works in: `workspaceId` when given,
 * else the user's default workspace. A given workspace must be the user's
 * own, or a space where they may run the agent (not archived); anything else
 * throws, and resolution errors propagate: a turn never runs without a
 * workspace, which would drop every workspace filter and file its rows and
 * files in the wrong place. See `resolveTurnWorkspace` (context.ts).
 */
export async function turnWorkspaceId(userId: string, workspaceId: string | null | undefined): Promise<string> {
  return (await resolveTurnWorkspace(userId, workspaceId)).workspaceId;
}

/**
 * Resolve a session ID to an existing session or create a new one.
 * Handles both UUID-based and channel-based session identifiers.
 *
 * A new session is created in `workspaceId` (checked by `turnWorkspaceId`),
 * or in the user's default workspace when none is given. An existing
 * session keeps the workspace it was created in.
 *
 * An existing UUID session owned by a different user is refused ("Session
 * not found", the same answer as a missing row, so ownership is not
 * disclosed): every caller passes the acting user, and sessions.user_id is
 * NOT NULL, so there is no legitimate cross-user resolution.
 */
export async function resolveSession(
  sessionId: string,
  userId: string,
  channel: string,
  workspaceId?: string | null,
): Promise<string> {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(sessionId)) {
    const existing = await sessionRepository.findById(sessionId);
    if (existing) {
      if (existing.userId !== userId) throw new Error('Session not found');
      return sessionId;
    }

    const wsId = await turnWorkspaceId(userId, workspaceId);
    const session = await sessionRepository.create({
      id: sessionId,
      userId,
      workspaceId: wsId,
      channelType: channel,
      channelId: sessionId,
      title: `${channel} conversation`,
      status: 'active',
    });
    coreLogger.info({ sessionId: session.id, channel, workspaceId: wsId }, 'Created session for UUID');
    return session.id;
  }

  const parts = sessionId.split('-');
  const channelType = parts[0] || channel;
  const channelId = parts.slice(1).join('-') || sessionId;

  const existing = await sessionRepository.findByUserAndChannel(userId, channelType, channelId);
  if (existing) return existing.id;

  const wsId = await turnWorkspaceId(userId, workspaceId);
  const session = await sessionRepository.create({
    userId,
    workspaceId: wsId,
    channelType,
    channelId,
    title: `${channelType} conversation`,
    status: 'active',
  });

  coreLogger.info({ sessionId: session.id, channelType, channelId, workspaceId: wsId }, 'Created new session for channel');
  return session.id;
}
