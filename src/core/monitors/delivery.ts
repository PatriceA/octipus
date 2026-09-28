import type { TurnResult } from '@/core/agent/service';
import type { Monitor } from '@/db/schema/monitors';
import { sessionRepository } from '@/db/repositories/session-repository';
import { sessionGeneration } from '@/db/schema/sessions';
import { getUMI } from '@/channels/interface';
import { canNotify, NotifyTargetNotAllowedError } from '@/channels/ownership';
import type { ChannelType } from '@/core/types';
import { coreLogger } from '@/utils/logger';

const EXTERNAL_CHANNELS = new Set(['telegram', 'slack', 'teams', 'whatsapp']);

export async function deliverMonitorResponse(row: Monitor, result: TurnResult): Promise<void> {
  const session = await sessionRepository.findById(row.sessionId);
  if (!session || session.userId !== row.userId || sessionGeneration(session.context) !== row.generation) return;
  const { getAgentService } = await import('@/core/agent/service');
  getAgentService().publishResponse(row.sessionId, row.userId, result);
  if (EXTERNAL_CHANNELS.has(session.channelType) && result.response) {
    // The session's chat is only as trustworthy as whoever created the
    // session: the reply goes out unattended, so it must be the owner's own
    // chat or an approved shared destination (src/channels/ownership.ts).
    if (!(await canNotify(row.userId, session.channelType, session.channelId))) {
      coreLogger.warn(
        { monitorId: row.id, userId: row.userId, channelType: session.channelType, channelId: session.channelId },
        'Monitor reply target is not linked to the owner nor an approved shared destination; not sending',
      );
      throw new NotifyTargetNotAllowedError(`${session.channelType}:${session.channelId}`);
    }
    await getUMI().send(session.channelType as ChannelType, session.channelId, {
      content: result.response, threadId: session.threadId ?? undefined,
      metadata: { monitorId: row.id, sessionId: row.sessionId },
    });
  }
}
