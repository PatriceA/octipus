import { sessionRepository } from '@/db/repositories/session-repository';
import { coreLogger } from '@/utils/logger';

/**
 * Look up the user's default workspace id so freshly-created sessions
 * get tagged with it. Without this, sessions land with workspace_id=NULL
 * and the legacy "NULL → visible to every workspace" rule in
 * `scopedRepos.workspaceFilter` made TUI/webchat sessions show up in
 * the picker regardless of which workspace was active.
 */
async function defaultWorkspaceId(userId: string): Promise<string | null> {
  try {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const def = await getOrgWorkspaceManager().ensureDefaultWorkspace(userId);
    return def?.id ?? null;
  } catch (err) {
    coreLogger.debug({ err, userId }, 'No default workspace available for session tagging');
    return null;
  }
}

/**
 * Resolve a session ID to an existing session or create a new one.
 * Handles both UUID-based and channel-based session identifiers.
 */
export async function resolveSession(sessionId: string, userId: string, channel: string): Promise<string> {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(sessionId)) {
    const existing = await sessionRepository.findById(sessionId);
    if (existing) return sessionId;

    const workspaceId = await defaultWorkspaceId(userId);
    const session = await sessionRepository.create({
      id: sessionId,
      userId,
      workspaceId: workspaceId ?? undefined,
      channelType: channel,
      channelId: sessionId,
      title: `${channel} conversation`,
      status: 'active',
    });
    coreLogger.info({ sessionId: session.id, channel, workspaceId }, 'Created session for UUID');
    return session.id;
  }

  const parts = sessionId.split('-');
  const channelType = parts[0] || channel;
  const channelId = parts.slice(1).join('-') || sessionId;

  const existing = await sessionRepository.findByUserAndChannel(userId, channelType, channelId);
  if (existing) return existing.id;

  const workspaceId = await defaultWorkspaceId(userId);
  const session = await sessionRepository.create({
    userId,
    workspaceId: workspaceId ?? undefined,
    channelType,
    channelId,
    title: `${channelType} conversation`,
    status: 'active',
  });

  coreLogger.info({ sessionId: session.id, channelType, channelId, workspaceId }, 'Created new session for channel');
  return session.id;
}
