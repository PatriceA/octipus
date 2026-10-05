/**
 * One line in the thread when a task taken up there leaves the board's active
 * set — done, archived or deleted — by whatever route: the agent's
 * `complete_taken_task`, the board, the tasks tool
 * (docs/plans/group-chat-bot.md §5). Nothing is posted once the channel's
 * enrolment is removed or paused, as for every other message there. A task
 * taken in a channel bound to a space is on the space's board and linked to
 * the thread's room; its close is posted in that thread (coworking §9.4).
 */
import { quietText } from '@/core/channels/group-context';
import { onTaskClosed, type TaskClosedEvent } from '@/core/tasks/wakeups';
import type { ChannelType } from '@/core/types';
import { isUuid } from '@/db/repositories/scoped';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { GroupChannel } from '@/db/schema/group-channels';
import { channelLogger } from '@/utils/logger';
import { getUMI } from './interface';

let stopListening: (() => void) | null = null;

/** Start posting close notices. A second call replaces the first listener. */
export function startTakenTaskNotices(): void {
  stopListening?.();
  stopListening = onTaskClosed((event) => announceTakenTaskClosed(event));
}

/** Exported for tests; `startTakenTaskNotices` calls it for every close. */
export async function announceTakenTaskClosed(event: TaskClosedEvent): Promise<void> {
  const { task, cause } = event;
  if (task.source !== 'channel') return;
  const sessionId = task.sourceRef?.sessionId;
  if (!sessionId || !isUuid(sessionId)) return;
  const target = await noticeTarget(sessionId, task.userId, task.workspaceId);
  if (!target) return;

  const { isGroupChannelActive } = await import('./group-channels');
  if (!(await isGroupChannelActive(target.group))) return;

  const title = quietText(task.title);
  const content = cause === 'deleted' ? `Removed from the board: *${title}*.`
    : task.status === 'done' ? `✅ Done: *${title}*`
      : `Archived: *${title}*. Nobody is working on it now.`;
  try {
    await getUMI().send(target.group.channelType as ChannelType, target.group.channelId, { content, threadId: target.threadId });
  } catch (err) {
    channelLogger.warn({ err, taskId: task.id }, 'Could not post a taken task\'s close in its thread');
  }
}

/**
 * Where a taken task's close is posted: the member's thread session of a
 * group channel, or — for a task on a space's board (§9.4) — the thread of
 * the bound channel whose room it was taken into. Null when neither holds.
 */
async function noticeTarget(sessionId: string, taskUserId: string, taskWorkspaceId: string | null): Promise<{ group: GroupChannel; threadId: string } | null> {
  const session = await sessionRepository.findById(sessionId);
  if (session?.kind === 'room') {
    const { bridgeTargetOf } = await import('./group-bridge');
    const target = await bridgeTargetOf(sessionId);
    // A space task, of the space the room's channel is bound to.
    return target && target.group.workspaceId === taskWorkspaceId ? target : null;
  }
  if (!session?.groupChannelId || session.userId !== taskUserId || !session.threadId || !session.channelId) return null;
  const { findGroupChannel } = await import('./group-channels');
  const group = await findGroupChannel(session.channelType, session.channelId);
  if (group?.id !== session.groupChannelId) return null;
  return { group, threadId: session.threadId };
}
