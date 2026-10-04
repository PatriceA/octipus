/**
 * Agent approvals (`ApprovalManager`: pipeline gates, `request_user_approval`)
 * in chat: posted in the chat of the session that raised them, and answered
 * by a typed reply there.
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
 *    removed or paused channel nothing is posted; the approval waits in the
 *    web app (it expires after an hour);
 *  - a chat that is the user's own or an approved shared destination
 *    (`resolveTarget`, the rule for every unattended send): the approval
 *    with its details;
 *  - any other chat the user is talking to the bot in right now
 *    (`attendChat`: a Telegram group, a Teams group chat or channel): a
 *    prompt without the details, which can quote the user's files or mail —
 *    those go privately where the platform can, else they are in the web app;
 *  - nowhere else. The web app, notifications and push show every approval.
 *
 * A typed reply answers only an approval posted in that chat (and thread) for
 * that user, the newest one, never one waiting somewhere else. Where others
 * read along (a group thread, a shared chat) only a bare yes/no counts; in
 * the user's own chat an approve/deny phrase or an option's exact label does.
 */
import type { ApprovalKind } from '@/core/agent/approval-manager';
import type { TurnEvent } from '@/core/agent/service';
import type { ChannelType, UnifiedMessage } from '@/core/types';
import { isUuid } from '@/db/repositories/scoped';
import { sessionRepository } from '@/db/repositories/session-repository';
import { channelLogger } from '@/utils/logger';
import { answerHow } from './group-handler';
import { getUMI } from './interface';
import { EXTERNAL_CHANNELS, loadNotifyScope, resolveTarget, sendResolved } from './ownership';

interface ApprovalEventData {
  requestId?: string;
  summary?: string;
  question?: string;
  options?: string[];
  kind?: ApprovalKind;
}

interface PostedApproval {
  requestId: string;
  channelType: ChannelType;
  channelId: string;
  /** Group channels only: the thread it was posted in. */
  threadId?: string;
  /** Others read the chat: only a bare yes/no answers, and options are not offered. */
  shared: boolean;
  options?: string[];
  kind: ApprovalKind;
  postedAt: number;
  /**
   * Set when the approval stopped waiting without an answer from this chat
   * (answered in the web app, timed out). Kept a while so a late reply is
   * told so instead of starting a turn; dropped after that one reply.
   */
  closedAt?: number;
}

/** How long a closed approval still catches a late reply in its chat. */
const LATE_REPLY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Approvals posted in a chat, oldest first, per user + chat (+ thread). */
const posted = new Map<string, PostedApproval[]>();

/** Sessions the dispatcher is handling an inbound message for (a count each). */
const attended = new Map<string, number>();

let stopListening: (() => void) | null = null;

function chatKey(userId: string, channelType: string, channelId: string, threadId?: string): string {
  return [userId, channelType, channelId, threadId ?? ''].join('\u0000');
}

/** The key a reply in this chat looks under. */
function replyKey(message: UnifiedMessage): string {
  const groupThread = typeof message.metadata?.groupChannelId === 'string' ? message.threadId : undefined;
  return chatKey(message.userId, message.channelType, message.channelId, groupThread);
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
 * when the chat is shared (without its details). Returns the release function.
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

/**
 * Mark approvals that stopped waiting (answered in the web app, timed out) as
 * closed, and drop closed ones past the late-reply window.
 */
function prune(live: ReadonlySet<string>, now = Date.now()): void {
  for (const [key, list] of posted) {
    const kept: PostedApproval[] = [];
    for (const p of list) {
      if (!live.has(p.requestId) && p.closedAt === undefined) p.closedAt = now;
      if (p.closedAt === undefined || now - p.closedAt < LATE_REPLY_WINDOW_MS) kept.push(p);
    }
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
  const kind: ApprovalKind = data.kind === 'question' ? 'question' : 'gate';

  if (session.groupChannelId) {
    const { findGroupChannel, isGroupChannelActive } = await import('./group-channels');
    const group = await findGroupChannel(channelType, channelId);
    if (group?.id !== session.groupChannelId || !(await isGroupChannelActive(group))) {
      // The bot is silent in a removed or paused channel. The approval stays
      // answerable in the web app and expires after an hour.
      channelLogger.info({ sessionId: session.id, channelId }, 'Approval from a group thread whose channel is removed or paused — not posted');
      return;
    }
    const threadId = session.threadId ?? undefined;
    if (await postWithoutDetails({ data, userId, channelType, channelId, threadId, isLive: () => live().has(requestId) })) {
      record(userId, { requestId, channelType, channelId, threadId, shared: true, kind, postedAt: Date.now() }, live());
    }
    return;
  }

  const target = await resolveTarget(await loadNotifyScope(userId), channelType, channelId);
  if (target.allowed) {
    if (!live().has(requestId)) return; // answered in the web app meanwhile
    const sent = await sendResolved(target, {
      content: `${details(data)}\n\n${data.options?.length
        ? 'Reply with one of the options, **yes** to continue, or **no** to cancel.'
        : 'Reply **yes** to continue, or **no** to cancel.'}`,
    });
    if (!sent.ok) {
      channelLogger.warn({ sessionId: session.id, channelType, reason: sent.reason, error: sent.error }, 'Approval could not be posted in chat');
      return;
    }
    record(userId, { requestId, channelType, channelId, shared: false, options: data.options, kind, postedAt: Date.now() }, live());
  } else if (attended.has(session.id)) {
    // A shared chat (a Telegram group, a Teams group chat or channel) the
    // user is talking in right now: everyone there reads it.
    if (await postWithoutDetails({ data, userId, channelType, channelId, isLive: () => live().has(requestId) })) {
      record(userId, { requestId, channelType, channelId, shared: true, kind, postedAt: Date.now() }, live());
    }
  } else {
    channelLogger.info({ sessionId: session.id, channelType, reason: target.reason },
      'Approval not posted in chat: the chat is not the user\'s own nor an approved destination; it can be answered in the web app');
  }
}

/**
 * Where others read along: the details privately to the user where the
 * platform can (a Slack ephemeral message), and a prompt without them. True
 * when the prompt was posted.
 */
async function postWithoutDetails(input: {
  data: ApprovalEventData;
  userId: string;
  channelType: ChannelType;
  channelId: string;
  threadId?: string;
  isLive: () => boolean;
}): Promise<boolean> {
  const { data, userId, channelType, channelId, threadId } = input;
  const { userRepository } = await import('@/db/repositories/user-repository');
  const name = (await userRepository.findById(userId))?.username ?? 'The requester';
  const umi = getUMI();
  const shown = await umi.sendPrivate(channelType, channelId, userId, {
    content: `${details(data)}\n\nReply \`yes\` or \`no\` ${answerHow(channelType, threadId)}.${data.options?.length ? ' The other options are in the Octipus web app.' : ''}`,
    threadId,
  }).catch((err: unknown) => {
    channelLogger.warn({ err, channelType }, 'Private approval details could not be delivered');
    return false;
  });
  if (!input.isLive()) return false; // answered in the web app meanwhile
  await umi.send(channelType, channelId, {
    content: `⏳ ${name}: a step needs your approval. ${shown
      ? 'I sent you the details privately; only you can see them.'
      : 'The details are in the Octipus web app, since others can read this chat.'}\n\nOnly ${name} can reply \`yes\` or \`no\`, ${answerHow(channelType, threadId)}.`,
    threadId,
  });
  return true;
}

function record(userId: string, entry: PostedApproval, live: ReadonlySet<string>): void {
  const key = chatKey(userId, entry.channelType, entry.channelId, entry.threadId);
  posted.set(key, [...(posted.get(key) ?? []).filter((p) => p.requestId !== entry.requestId), entry]);
  prune(live);
}

/**
 * When the newest approval still waiting in this chat for this user was
 * posted (ms), or 0. The dispatcher answers whichever prompt is newer: this
 * one or a permission prompt.
 */
export async function newestApprovalPostedAt(message: UnifiedMessage): Promise<number> {
  const key = replyKey(message);
  if (!posted.has(key)) return 0;
  prune(new Set((await agentService()).getPendingApprovals().map((a) => a.id)));
  const open = (posted.get(key) ?? []).filter((p) => p.closedAt === undefined);
  return open.at(-1)?.postedAt ?? 0;
}

/**
 * The answer a typed reply gives, or null when it is not one. Where others
 * read along only a bare yes/no counts. In the user's own chat an option's
 * exact label chooses it, as the web app's buttons do — except that on a
 * go / no-go gate an option worded as a refusal ("No", "Stop Pipeline")
 * declines — and otherwise a yes/no reply (`replyAnswer`: "Cancel my 3pm"
 * is a request, not an answer).
 */
async function answerFor(text: string, entry: PostedApproval): Promise<{ approved: boolean; response: string; option?: string } | null> {
  if (entry.shared) {
    const { bareReply } = await import('@/core/channels/group-context');
    const bare = bareReply(text);
    return bare ? { approved: bare === 'yes', response: bare } : null;
  }
  const { approvalAnswer, replyAnswer } = await import('@/core/agent/approval-manager');
  const typed = text.trim().replace(/[.!]+$/, '').toLowerCase();
  const option = entry.options?.find((o) => o.trim().toLowerCase() === typed);
  if (option) {
    const declines = entry.kind === 'gate' && approvalAnswer(option) === 'deny';
    return { approved: !declines, response: option, option };
  }
  const answer = replyAnswer(text);
  return answer ? { approved: answer === 'approve', response: text.trim() } : null;
}

/**
 * Answer the approval posted in this chat (and thread) for this user, if the
 * message is an answer. Returns true when the message was consumed. A late
 * reply to one that stopped waiting is told so, once.
 */
export async function tryResolveApprovalFromChannel(message: UnifiedMessage): Promise<boolean> {
  const key = replyKey(message);
  if (!posted.has(key) || message.attachments?.length) return false;
  const agent = await agentService();
  prune(new Set(agent.getPendingApprovals().map((a) => a.id)));
  const list = posted.get(key) ?? [];
  const entry = list.filter((p) => p.closedAt === undefined).at(-1) ?? list.at(-1);
  if (!entry) return false;
  const answer = await answerFor(message.content, entry);
  if (!answer) return false;

  // A closed entry gets the manager's own account of why (timed out, answered).
  const outcome = await agent.resolveApprovalDetailed(entry.requestId, answer.approved, answer.response,
    { forUserId: message.userId, resolvedBy: message.userId });
  // One late notice per chat: a reply to a closed approval also clears the others that closed there.
  const rest = (posted.get(key) ?? []).filter((p) => p.requestId !== entry.requestId
    && (entry.closedAt === undefined || p.closedAt === undefined));
  if (rest.length > 0) posted.set(key, rest);
  else posted.delete(key);

  const waiting = rest.filter((p) => p.closedAt === undefined).length;
  const more = waiting > 0 ? ` (${waiting} more approval${waiting === 1 ? '' : 's'} waiting here.)` : '';
  let content: string;
  if (outcome.status === 'resolved') {
    content = answer.approved
      ? (answer.option ? `Chose "${answer.option}". Continuing...` : 'Approved. Continuing...')
      : (answer.option ? `Chose "${answer.option}": the step will not run.` : 'Declined.');
  } else {
    content = 'message' in outcome
      ? outcome.message
      : 'That approval was already answered elsewhere or has expired; nothing was changed.';
  }
  try {
    await getUMI().send(entry.channelType, entry.channelId, { content: content + more, threadId: entry.threadId });
  } catch (err) {
    channelLogger.warn({ err, channelType: entry.channelType }, 'Could not confirm an approval reply in the chat');
  }
  return true;
}
