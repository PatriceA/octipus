/**
 * Agent approvals (`ApprovalManager`: pipeline gates, `request_approval`) in
 * chat: posted in the chat of the session that raised them, and answered by a
 * typed reply there.
 *
 * Keyed by the session, like permission prompts
 * (`forwardPermissionRequestToChannel` in ./index.ts), not by the inbound
 * message: an approval raised by a background run (a monitor's wake-up, a
 * resumed pipeline) reaches the chat too, and so does one on Teams, whose
 * messages carry no platform message id. One listener posts each approval
 * once.
 *
 * Where an approval is posted:
 *  - a group-channel thread: while the enrolment is active, the details go to
 *    the requester privately and the thread gets a prompt without them. In a
 *    removed or paused channel nothing is posted and the step is declined
 *    (it would otherwise hold the conversation until the approval times out);
 *  - any other messaging chat: while the user is talking to the bot there
 *    (`attendChat`), or when the chat is theirs or an approved shared
 *    destination (`resolveTarget`, the rule for every unattended send);
 *  - nowhere else. The web app, notifications and push show every approval.
 *
 * A typed reply answers only an approval posted in that chat (and thread) for
 * that user, the newest one, never one waiting somewhere else.
 */
import type { TurnEvent } from '@/core/agent/service';
import type { ChannelType, UnifiedMessage } from '@/core/types';
import { isUuid } from '@/db/repositories/scoped';
import { sessionRepository } from '@/db/repositories/session-repository';
import { channelLogger } from '@/utils/logger';
import { getUMI } from './interface';
import { EXTERNAL_CHANNELS, loadNotifyScope, resolveTarget, sendResolved } from './ownership';

interface ApprovalEventData {
  requestId?: string;
  summary?: string;
  question?: string;
  options?: string[];
}

interface PostedApproval {
  requestId: string;
  channelType: ChannelType;
  channelId: string;
  /** Group channels only: the thread it was posted in. */
  threadId?: string;
  options?: string[];
}

/** Approvals posted in a chat, oldest first, per user + chat (+ thread). */
const posted = new Map<string, PostedApproval[]>();

/** Sessions the dispatcher is handling an inbound message for (a count each). */
const attended = new Map<string, number>();

let stopListening: (() => void) | null = null;

function chatKey(userId: string, channelType: string, channelId: string, threadId?: string): string {
  return [userId, channelType, channelId, threadId ?? ''].join('\u0000');
}

async function agentService() {
  const { getAgentService } = await import('@/core/agent/service');
  return getAgentService();
}

/** Test seam. */
export function _resetApprovalPromptsForTests(): void {
  posted.clear();
  attended.clear();
}

/**
 * Held by the dispatcher while it handles a message for `sessionId`: the user
 * is in that chat now, so an approval raised meanwhile is posted there even
 * when the chat is a group the bot may not message unattended. Returns the
 * release function.
 */
export function attendChat(sessionId: string): () => void {
  attended.set(sessionId, (attended.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (attended.get(sessionId) ?? 1) - 1;
    if (left > 0) attended.set(sessionId, left);
    else attended.delete(sessionId);
  };
}

/** Post approvals in chat from now on. A second call replaces the first listener. */
export async function startApprovalPrompts(): Promise<void> {
  const agent = await agentService();
  stopListening?.();
  stopListening = agent.onEvent((event) => {
    if (event.type !== 'approval_required') return;
    void announceApproval(event)
      .catch((err: unknown) => channelLogger.error({ err, sessionId: event.sessionId }, 'Could not post an approval in chat'));
  });
}

/** Drop approvals that are no longer pending (answered in the web app, timed out). */
function prune(live: ReadonlySet<string>): void {
  for (const [key, list] of posted) {
    const kept = list.filter((p) => live.has(p.requestId));
    if (kept.length > 0) posted.set(key, kept);
    else posted.delete(key);
  }
}

function details(d: ApprovalEventData): string {
  const lines = ['⏳ **Approval Required**'];
  if (d.summary) lines.push(d.summary);
  lines.push('', d.question || 'Proceed?');
  if (d.options?.length) lines.push(`Options: ${d.options.join(' / ')}`);
  return lines.join('\n');
}

/**
 * Post one approval in the chat of the session that raised it (see the
 * module comment for where). Exported for tests; `startApprovalPrompts`
 * calls it for every `approval_required` event.
 */
export async function announceApproval(event: TurnEvent): Promise<void> {
  const data = (event.data ?? {}) as ApprovalEventData;
  const requestId = data.requestId;
  const userId = event.userId;
  if (event.type !== 'approval_required' || !requestId || !userId || !isUuid(event.sessionId)) return;

  const session = await sessionRepository.findById(event.sessionId);
  if (!session || session.userId !== userId || !EXTERNAL_CHANNELS.has(session.channelType) || !session.channelId) return;
  const channelType = session.channelType as ChannelType;
  const channelId = session.channelId;
  const agent = await agentService();
  const live = () => new Set(agent.getPendingApprovals().map((a) => a.id));

  if (session.groupChannelId) {
    const { findGroupChannel, isGroupChannelActive } = await import('./group-channels');
    const group = await findGroupChannel(channelType, channelId);
    if (group?.id !== session.groupChannelId || !(await isGroupChannelActive(group))) {
      channelLogger.info({ sessionId: session.id, channelId }, 'Approval from a group thread whose channel is removed or paused — declining it');
      await agent.resolveApprovalDetailed(requestId, false, 'the group channel this conversation belongs to was removed or is paused', { forUserId: userId });
      return;
    }
    // The summary can quote the requester's files, mail or results: only
    // they see it. The thread gets a prompt without it.
    const threadId = session.threadId ?? undefined;
    const { userRepository } = await import('@/db/repositories/user-repository');
    const name = (await userRepository.findById(userId))?.username ?? 'The requester';
    const umi = getUMI();
    const shown = await umi.sendPrivate(channelType, channelId, userId, {
      content: `${details(data)}\n\nReply \`yes\` or \`no\` in the thread.${data.options?.length ? ' The other options are in the Octipus web app.' : ''}`,
      threadId,
    }).catch((err: unknown) => {
      channelLogger.warn({ err, channelType }, 'Private approval details could not be delivered');
      return false;
    });
    if (!live().has(requestId)) return; // answered in the web app meanwhile
    await umi.send(channelType, channelId, {
      content: `⏳ ${name}: a step needs your approval. ${shown
        ? 'I sent you the details privately; only you can see them.'
        : 'I could not show you the details privately here; check them in the Octipus web app.'}\n\nOnly ${name} can reply \`yes\` or \`no\`.`,
      threadId,
    });
    record(userId, { requestId, channelType, channelId, threadId }, live());
    return;
  }

  const content = `${details(data)}\n\n${data.options?.length
    ? 'Reply with one of the options, **yes** to continue, or **no** to cancel.'
    : 'Reply **yes** to continue, or **no** to cancel.'}`;
  if (attended.has(session.id)) {
    if (!live().has(requestId)) return;
    await getUMI().send(channelType, channelId, { content });
  } else {
    // Nobody vouched for this chat just now: post only where the bot may
    // message the user unattended.
    const target = await resolveTarget(await loadNotifyScope(userId), channelType, channelId);
    if (!target.allowed) {
      channelLogger.info({ sessionId: session.id, channelType, reason: target.reason },
        'Approval not posted in chat: the chat is not the user\'s own nor an approved destination; it can be answered in the web app');
      return;
    }
    if (!live().has(requestId)) return;
    const sent = await sendResolved(target, { content });
    if (!sent.ok) {
      channelLogger.warn({ sessionId: session.id, channelType, reason: sent.reason, error: sent.error }, 'Approval could not be posted in chat');
      return;
    }
  }
  record(userId, { requestId, channelType, channelId, options: data.options }, live());
}

function record(userId: string, entry: PostedApproval, live: ReadonlySet<string>): void {
  const key = chatKey(userId, entry.channelType, entry.channelId, entry.threadId);
  posted.set(key, [...(posted.get(key) ?? []).filter((p) => p.requestId !== entry.requestId), entry]);
  prune(live);
}

/**
 * The answer a typed reply gives, or null when it is not one. In a group
 * thread only a bare yes/no counts (members also talk to each other there);
 * in a 1:1 chat an approve / deny phrase, or an option's exact label, which
 * approves with that option as the web app's buttons do.
 */
async function answerFor(text: string, entry: PostedApproval): Promise<{ approved: boolean; response: string } | null> {
  if (entry.threadId) {
    const { bareReply } = await import('@/core/channels/group-context');
    const bare = bareReply(text);
    return bare ? { approved: bare === 'yes', response: bare } : null;
  }
  const typed = text.trim().replace(/[.!]+$/, '').toLowerCase();
  const option = entry.options?.find((o) => o.trim().toLowerCase() === typed);
  if (option) return { approved: true, response: option };
  const { approvalAnswer } = await import('@/core/agent/approval-manager');
  const answer = approvalAnswer(text);
  return answer ? { approved: answer === 'approve', response: text.trim() } : null;
}

/**
 * Answer the approval posted in this chat (and thread) for this user, if the
 * message is an answer. Returns true when the message was consumed.
 */
export async function tryResolveApprovalFromChannel(message: UnifiedMessage): Promise<boolean> {
  const groupThread = typeof message.metadata?.groupChannelId === 'string' ? message.threadId : undefined;
  const key = chatKey(message.userId, message.channelType, message.channelId, groupThread);
  if (!posted.has(key)) return false;
  const agent = await agentService();
  prune(new Set(agent.getPendingApprovals().map((a) => a.id)));
  const entry = posted.get(key)?.at(-1);
  if (!entry) return false;
  const answer = await answerFor(message.content, entry);
  if (!answer) return false;

  const outcome = await agent.resolveApprovalDetailed(entry.requestId, answer.approved, answer.response,
    { forUserId: message.userId, resolvedBy: message.userId });
  const rest = (posted.get(key) ?? []).filter((p) => p.requestId !== entry.requestId);
  if (rest.length > 0) posted.set(key, rest);
  else posted.delete(key);

  const more = rest.length > 0 ? ` (${rest.length} more approval${rest.length === 1 ? '' : 's'} waiting here.)` : '';
  const content = outcome.status === 'resolved'
    ? (answer.approved
      ? (entry.options?.includes(answer.response) ? `Chose "${answer.response}". Continuing...` : 'Approved. Continuing...')
      : 'Declined.')
    : 'message' in outcome
      ? outcome.message
      : 'That approval was already answered elsewhere or has expired; nothing was changed.';
  try {
    await getUMI().send(entry.channelType, entry.channelId, { content: content + more, threadId: entry.threadId });
  } catch (err) {
    channelLogger.warn({ err, channelType: entry.channelType }, 'Could not confirm an approval reply in the chat');
  }
  return true;
}
