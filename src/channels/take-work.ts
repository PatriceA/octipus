/**
 * The dispatcher's half of taking work on in a group channel
 * (docs/plans/group-chat-bot.md §5): put the request on the member's board,
 * linked to their session for the thread, and say so in the thread. The turn
 * that then works it is the dispatcher's ordinary one, in that session.
 */
import type { TakeRequest } from '@/core/channels/taken-tasks';
import { quietText } from '@/core/channels/group-context';
import type { UnifiedMessage } from '@/core/types';
import type { GroupChannel } from '@/db/schema/group-channels';
import { sessionRepository } from '@/db/repositories/session-repository';
import { channelLogger } from '@/utils/logger';
import { getUMI } from './interface';

/** The task a turn is working on, for its context. */
export interface TakenWork {
  taskId: string;
  title: string;
  /** Whose message the request is, when it is not the requester's own words. */
  author?: string;
  /** The taken message's text, when it is not what the member typed (see `TakeRequest.quoted`). */
  text?: string;
}

/** The take request a channel adapter put on the message, when it is well-formed. */
export function takeRequestOf(value: unknown): TakeRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== 'string' || !v.text.trim() || typeof v.messageKey !== 'string' || !v.messageKey) return undefined;
  return {
    text: v.text,
    messageKey: v.messageKey,
    author: typeof v.author === 'string' && v.author ? v.author : undefined,
    quoted: v.quoted === true || undefined,
    url: typeof v.url === 'string' && /^https:\/\//.test(v.url) ? v.url : undefined,
  };
}

/**
 * Create the task and announce it. Returns what the turn works on, or null
 * when this member already took that message on: they are told privately and
 * no turn starts (mentioning the bot in the thread continues the work).
 */
export async function startTakenWork(input: {
  message: UnifiedMessage;
  sessionId: string;
  group: GroupChannel;
  request: TakeRequest;
}): Promise<TakenWork | null> {
  const { message, sessionId, group, request } = input;
  const { takeChannelTask } = await import('@/core/channels/taken-tasks');
  const session = await sessionRepository.findById(sessionId);
  const name = message.userName ?? 'the requester';
  const { task, created } = await takeChannelTask({
    userId: message.userId,
    workspaceId: session?.workspaceId ?? null,
    sessionId,
    requester: name,
    where: group.label ?? group.channelId,
    request,
  });
  const umi = getUMI();
  const title = quietText(task.title);
  if (!created) {
    const state = task.status === 'done' ? 'done' : task.status === 'archived' ? 'archived' : 'in progress';
    await umi.sendPrivate(message.channelType, message.channelId, message.userId, {
      content: `That is already on your tasks: *${title}* (${state}). Mention me in its thread to continue it.`,
      threadId: message.threadId,
    }).catch((err: unknown) => channelLogger.warn({ err }, 'Could not say privately that a task was already taken'));
    return null;
  }
  await umi.send(message.channelType, message.channelId, {
    content: `On it — added *${title}* to ${quietText(name)}'s tasks.`,
    threadId: message.threadId,
  });
  return {
    taskId: task.id,
    title: task.title,
    ...(request.author ? { author: request.author } : {}),
    ...(request.author || request.quoted ? { text: request.text } : {}),
  };
}
