import type { TurnResult } from '@/core/agent/service';
import type { Monitor } from '@/db/schema/monitors';
import { sessionRepository } from '@/db/repositories/session-repository';
import { sessionGeneration } from '@/db/schema/sessions';
import { EXTERNAL_CHANNELS, loadNotifyScope, resolveTarget, sendResolved } from '@/channels/ownership';
import { coreLogger } from '@/utils/logger';

export async function deliverMonitorResponse(row: Monitor, result: TurnResult): Promise<void> {
  const session = await sessionRepository.findById(row.sessionId);
  if (!session || session.userId !== row.userId || sessionGeneration(session.context) !== row.generation) return;
  const { getAgentService } = await import('@/core/agent/service');
  getAgentService().publishResponse(row.sessionId, row.userId, result);
  if (EXTERNAL_CHANNELS.has(session.channelType) && result.response) {
    // The session's chat is only as trustworthy as whoever created the
    // session and the reply goes out unattended: it must be the owner's own
    // chat or an approved shared destination (src/channels/ownership.ts).
    const resolved = await resolveTarget(await loadNotifyScope(row.userId), session.channelType, session.channelId);
    if (!resolved.allowed) {
      coreLogger.warn(
        { monitorId: row.id, userId: row.userId, channelType: session.channelType, channelId: session.channelId, reason: resolved.reason },
        resolved.reason === 'unresolved'
          ? 'Monitor reply target cannot be resolved yet (Teams: the user must message the bot once); not sending'
          : 'Monitor reply target is not linked to the owner nor an approved shared destination; not sending',
      );
      throw new Error(resolved.error);
    }
    const sent = await sendResolved(resolved, {
      content: result.response, threadId: session.threadId ?? undefined,
      metadata: { monitorId: row.id, sessionId: row.sessionId },
    });
    if (!sent.ok) throw new Error(sent.error);
  }
}
