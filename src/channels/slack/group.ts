/**
 * Slack group-channel handling: what the bot does with a message posted in a
 * channel (not a DM).
 *
 * The rules are the same on every platform (`src/channels/group-handler.ts`);
 * this maps Slack's events onto them: `<@BOT>` mentions, `thread_ts` threads
 * (a top-level mention starts a thread on its own `ts`), ephemeral hints and
 * the 🐙 reaction.
 *
 * Platform calls are injected so the rules can be tested without Slack.
 */
import type { GroupChannel } from '@/db/schema/group-channels';
import type { JoinResult, LeaveResult } from '@/channels/group-channels';
import {
  type GroupDeps, type GroupMember, type GroupOutcome, groupHints, handleGroupFeedback, handleGroupMessage, handleGroupReaction,
} from '@/channels/group-handler';
import type { TakeRequest } from '@/core/channels/taken-tasks';

export { parseTake, TAKE_REACTION_TEXT, type GroupMember, type GroupOutcome } from '@/channels/group-handler';

export interface SlackGroupMessage {
  user?: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: unknown[];
}

/** A `reaction_added` event, as much of it as the handler reads. */
export interface SlackReaction {
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
}

/** One message read back from Slack. */
export interface SlackPost {
  text: string;
  /** The author's Slack user id; null for a post by an app. */
  user: string | null;
  /** Set when the post is by an app or bot. */
  botId: string | null;
  /** The parent's ts when the post is a reply in a thread. */
  threadTs?: string;
}

export interface SlackGroupDeps {
  /** The bot's own user id (`auth.test`). Null until known: then nothing counts as a mention. */
  botUserId: string | null;
  findGroup(channelId: string): Promise<GroupChannel | null>;
  isGroupActive(group: GroupChannel): Promise<boolean>;
  isThreadActive(groupId: string, threadTs: string): Promise<boolean>;
  findMember(slackUserId: string): Promise<GroupMember | null>;
  join(input: { channelId: string; label: string | null; userId: string }): Promise<JoinResult>;
  leave(input: { channelId: string; userId: string; isAdmin: boolean }): Promise<LeaveResult>;
  channelLabel(channelId: string): Promise<string | null>;
  displayName(slackUserId: string): Promise<string>;
  postEphemeral(channelId: string, slackUserId: string, text: string, threadTs?: string): Promise<void>;
  postInThread(channelId: string, threadTs: string, text: string): Promise<void>;
  readContext(input: { channelId: string; ts: string; threadTs?: string; label: string | null }): Promise<string>;
  /** One message by its ts (top-level or a reply); null when it cannot be read. */
  readMessage(channelId: string, ts: string): Promise<SlackPost | null>;
  /** A link to a message, for the task notes; undefined when Slack gives none. */
  permalink(channelId: string, ts: string): Promise<string | undefined>;
  /** When the channel's spend budget is used up: when it resets. Null while it may run. */
  budgetPause(group: GroupChannel): Promise<{ resetsAt: string } | null>;
  shouldSendHint(key: string): boolean;
  /** Store or withdraw a member's ✅ / ❌ on a bot reply. */
  feedback?: GroupDeps['feedback'];
  /** Every message in an enrolled channel that reaches the bot (recorded for listen mode). */
  seen?(msg: SlackGroupMessage, group: GroupChannel): void;
  dispatch(input: {
    channelId: string;
    member: GroupMember;
    userName: string;
    text: string;
    threadTs: string;
    group: GroupChannel;
    context: string;
    message: SlackGroupMessage;
    /** Set when the member asked the bot to take the work on (`take this`, 🐙). */
    take?: TakeRequest;
  }): void;
}

/** The reaction that takes a message on as a task: 🐙 (`:octopus:`). */
export const TAKE_REACTION = 'octopus';

/** Reactions on the bot's replies recorded as feedback (`handleGroupFeedback`). */
export const FEEDBACK_REACTIONS: Readonly<Record<string, 1 | -1>> = {
  white_check_mark: 1, heavy_check_mark: 1, '+1': 1, thumbsup: 1,
  x: -1, '-1': -1, thumbsdown: -1,
};

/** Message subtypes that carry something a member said. Edits, joins, topic changes etc. do not. */
const SPOKEN_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

export const HINTS = groupHints({
  platform: 'Slack',
  linkHow: 'send me `link` in a direct message',
  takeAlso: 'or add :octopus: to a message',
  followHow: 'I reply in a thread and keep following it',
});

/** The platform-neutral calls, from Slack's. */
function toGroupDeps(deps: SlackGroupDeps): GroupDeps<SlackGroupMessage> {
  return {
    botUserId: deps.botUserId,
    bot: deps.botUserId ? `<@${deps.botUserId}>` : '@Octipus',
    hints: HINTS,
    findGroup: deps.findGroup,
    isGroupActive: deps.isGroupActive,
    isThreadActive: deps.isThreadActive,
    findMember: deps.findMember,
    join: deps.join,
    leave: deps.leave,
    channelLabel: deps.channelLabel,
    displayName: deps.displayName,
    postPrivate: (user, text, where) => deps.postEphemeral(where.channelId, user, text, where.threadId),
    postInThread: deps.postInThread,
    readContext: ({ channelId, messageId, threadId, label }) => deps.readContext({ channelId, ts: messageId, threadTs: threadId, label }),
    readMessage: async (channelId, ts) => {
      const post = await deps.readMessage(channelId, ts);
      return post ? { text: post.text, user: post.user, threadId: post.threadTs } : null;
    },
    permalink: deps.permalink,
    budgetPause: deps.budgetPause,
    shouldSendHint: deps.shouldSendHint,
    seen: (msg, group) => { if (msg.raw) deps.seen?.(msg.raw, group); },
    feedback: deps.feedback,
    dispatch: ({ threadId, message, ...rest }) => deps.dispatch({
      ...rest,
      threadTs: threadId,
      message: message.raw ?? {
        user: message.user, channel: message.channelId, ts: message.messageId, thread_ts: message.threadId, text: message.text,
      },
    }),
  };
}

export async function handleSlackGroupMessage(msg: SlackGroupMessage, deps: SlackGroupDeps): Promise<GroupOutcome> {
  if (msg.bot_id || msg.subtype === 'bot_message' || !msg.user) return 'ignored';
  if (msg.subtype && !SPOKEN_SUBTYPES.has(msg.subtype)) return 'ignored';

  const raw = msg.text ?? '';
  const mention = deps.botUserId ? `<@${deps.botUserId}>` : null;
  return handleGroupMessage({
    user: msg.user,
    channelId: msg.channel,
    messageId: msg.ts,
    threadId: msg.thread_ts,
    replyThread: msg.thread_ts ?? msg.ts,
    text: (mention ? raw.split(mention).join('') : raw).trim(),
    mentioned: mention !== null && raw.includes(mention),
    hasFiles: (msg.files?.length ?? 0) > 0,
    raw: msg,
  }, toGroupDeps(deps));
}

/**
 * 🐙 on a message in an enrolled channel: the member who reacted takes that
 * message on as a task, worked in its thread (see `handleGroupReaction`).
 */
export async function handleSlackGroupReaction(ev: SlackReaction, deps: SlackGroupDeps): Promise<GroupOutcome | 'feedback'> {
  const channel = ev.item?.channel;
  const ts = ev.item?.ts;
  if (ev.item?.type !== 'message' || !channel || !ts || !ev.user || !ev.reaction) return 'ignored';
  const value = FEEDBACK_REACTIONS[ev.reaction.replace(/::skin-tone-\d$/, '')];
  if (value !== undefined) {
    return handleGroupFeedback({ user: ev.user, channelId: channel, messageId: ts, value, removed: false }, toGroupDeps(deps));
  }
  if (ev.reaction !== TAKE_REACTION) return 'ignored';
  return handleGroupReaction({ user: ev.user, channelId: channel, messageId: ts }, toGroupDeps(deps));
}

/** A ✅ / ❌ taken back (`reaction_removed`): its feedback is withdrawn. */
export async function handleSlackGroupReactionRemoved(ev: SlackReaction, deps: SlackGroupDeps): Promise<'feedback' | 'ignored'> {
  const channel = ev.item?.channel;
  const ts = ev.item?.ts;
  const value = ev.reaction ? FEEDBACK_REACTIONS[ev.reaction.replace(/::skin-tone-\d$/, '')] : undefined;
  if (ev.item?.type !== 'message' || !channel || !ts || !ev.user || value === undefined) return 'ignored';
  return handleGroupFeedback({ user: ev.user, channelId: channel, messageId: ts, value, removed: true }, toGroupDeps(deps));
}
