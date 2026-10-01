/**
 * One line in the thread when a task taken up there leaves the board's active
 * set — done, archived or deleted — by whatever route: the agent's
 * `complete_taken_task`, the board, the tasks tool
 * (docs/plans/group-chat-bot.md §5). Nothing is posted once the channel's
 * enrolment is removed or paused, as for every other message there.
 */
import { quietText } from '@/core/channels/group-context';
import { onTaskClosed, type TaskClosedEvent } from '@/core/tasks/wakeups';
import type { ChannelType } from '@/core/types';
import { isUuid } from '@/db/repositories/scoped';
import { sessionRepository } from '@/db/repositories/session-repository';
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
  const session = await sessionRepository.findById(sessionId);
  if (!session?.groupChannelId || session.userId !== task.userId || !session.threadId || !session.channelId) return;

  const { findGroupChannel, isGroupChannelActive } = await import('./group-channels');
  const group = await findGroupChannel(session.channelType, session.channelId);
  if (group?.id !== session.groupChannelId || !(await isGroupChannelActive(group))) return;

  const title = quietText(task.title);
  const content = cause === 'deleted' ? `Removed from the board: *${title}*.`
    : task.status === 'done' ? `✅ Done: *${title}*`
      : `Archived: *${title}*. Nobody is working on it now.`;
  try {
    await getUMI().send(session.channelType as ChannelType, session.channelId, { content, threadId: session.threadId });
  } catch (err) {
    channelLogger.warn({ err, taskId: task.id }, 'Could not post a taken task\'s close in its thread');
  }
}
