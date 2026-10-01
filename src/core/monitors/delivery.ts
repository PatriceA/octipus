import type { TurnResult } from '@/core/agent/service';
import type { ChannelType } from '@/core/types';
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
    if (session.groupChannelId) {
      // A monitor set up in a group-channel thread answers in that thread:
      // its turns ran under the thread's shared-audience rules, and the
      // enrolment, not a notification destination, is what lets the bot post
      // there. Nothing is posted once the channel is removed or paused.
      const { findGroupChannel, isGroupChannelActive } = await import('@/channels/group-channels');
      const group = await findGroupChannel(session.channelType, session.channelId);
      if (group?.id !== session.groupChannelId || !(await isGroupChannelActive(group))) {
        throw new Error('the group channel this conversation belongs to was removed or is paused');
      }
      // Everyone there reads it: a refusal for the member's own limits goes
      // without its figures, as in the dispatcher.
      let content = result.response;
      const limit = result.metadata?.limit;
      if (limit) {
        // Named neutrally: the Octipus account name is not what the channel knows them by.
        const { sharedRefusalText } = await import('@/core/errors/limit-refusal');
        content = sharedRefusalText(limit, 'the member who set this up') ?? content;
      }
      const { getUMI } = await import('@/channels/interface');
      await getUMI().send(session.channelType as ChannelType, session.channelId, {
        content, threadId: session.threadId ?? undefined,
        metadata: { monitorId: row.id, sessionId: row.sessionId },
      });
      return;
    }
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
