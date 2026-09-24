import type { TurnResult } from '@/core/agent/service';
import type { Monitor } from '@/db/schema/monitors';
import { sessionRepository } from '@/db/repositories/session-repository';
import { sessionGeneration } from '@/db/schema/sessions';
import { getUMI } from '@/channels/interface';
import type { ChannelType } from '@/core/types';

const EXTERNAL_CHANNELS = new Set(['telegram', 'slack', 'teams', 'whatsapp']);

export async function deliverMonitorResponse(row: Monitor, result: TurnResult): Promise<void> {
  const session = await sessionRepository.findById(row.sessionId);
  if (!session || session.userId !== row.userId || sessionGeneration(session.context) !== row.generation) return;
  const { getAgentService } = await import('@/core/agent/service');
  getAgentService().publishResponse(row.sessionId, row.userId, result);
  if (EXTERNAL_CHANNELS.has(session.channelType) && result.response) {
    await getUMI().send(session.channelType as ChannelType, session.channelId, {
      content: result.response, threadId: session.threadId ?? undefined,
      metadata: { monitorId: row.id, sessionId: row.sessionId },
    });
  }
}
