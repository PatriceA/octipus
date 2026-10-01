/**
 * Slack group-channel handling: what the bot does with a message posted in a
 * channel (not a DM).
 *
 * Rules (docs/plans/group-chat-bot.md, phase 1):
 *  - not enrolled → silent; only `@Octipus join` does anything, and a mention
 *    gets a private (ephemeral) hint at most once a day;
 *  - enrolled → act only when addressed: an @mention, or a reply in a thread
 *    the bot is already part of;
 *  - `link` is never answered in a channel — a link code posted where others
 *    can read it could be redeemed by someone else;
 *  - unlinked members get one private hint a day, never a public prompt;
 *  - the turn runs as the member who asked, never as the channel's owner;
 *  - `take this …` or a 🐙 reaction takes work on as a task on the member's
 *    board, worked in their thread (phase 2, src/core/channels/taken-tasks.ts);
 *  - while the channel's spend budget is used up, one notice a day and no turns.
 *
 * Platform calls are injected so the rules can be tested without Slack.
 */
import type { GroupChannel } from '@/db/schema/group-channels';
import type { JoinResult, LeaveResult } from '@/channels/group-channels';
import type { TakeRequest } from '@/core/channels/taken-tasks';

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

export interface GroupMember {
  id: string;
  username: string;
  isActive: boolean;
  isAdmin: boolean;
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

export type GroupOutcome =
  | 'ignored'
  | 'not_addressed'
  | 'hint'
  | 'joined'
  | 'left'
  | 'paused'
  | 'dispatched'
  | 'taken';

/** The reaction that takes a message on as a task: 🐙 (`:octopus:`). */
export const TAKE_REACTION = 'octopus';

/** What the member "says" when they take a message on with the reaction. */
export const TAKE_REACTION_TEXT = 'Take this on.';

/**
 * `take this — <what>`, `take it: <what>`, `take this on`, after the bot
 * mention is removed: what follows (possibly empty), or null when the message
 * is not a take command. "take a look at …" is an ordinary request.
 */
export function parseTake(text: string): string | null {
  const m = /^take\s+(?:this|it)(?:\s+on)?(?=$|[\s:,.;!—–-])([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  return (m[1] ?? '').replace(/^[\s:,.;!—–-]+/, '').trim();
}

/** Message subtypes that carry something a member said. Edits, joins, topic changes etc. do not. */
const SPOKEN_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

export const HINTS = {
  linkInChannel: 'For your security I never post link codes in a channel. Send me `link` in a direct message instead.',
  notEnrolled: (bot: string) => `I'm not active in this channel. Any linked member can enrol it by typing \`${bot} join\` here.`,
  linkFirst: 'Link your Slack account to Octipus first: send me `link` in a direct message and enter the code under Settings → Channels.',
  emptyMention: 'Ask me something after the mention, e.g. `@Octipus what did we decide about the release?`',
  alreadyYours: 'You already enrolled this channel.',
  taken: (owner: string) => `This channel is already enrolled by *${owner}*. Ask them, or an admin, if it should change.`,
  notOwner: 'Only the member who enrolled me here, or an Octipus admin, can remove me.',
  notEnrolledLeave: "I'm not enrolled in this channel, so there is nothing to leave.",
  takeWhat: 'Say what to take on: `@Octipus take this — <what>`, or add :octopus: to a message.',
  takeUnreadable: "I couldn't read that message, so I can't take it on.",
};

/** Posted once a day while the channel's spend budget is used up. */
const budgetPausedText = (resetsAt: string) => `I'm paused in this channel: its spend budget is used up until `
  + `${resetsAt.slice(0, 10)} ${resetsAt.slice(11, 16)} UTC. An Octipus admin can raise it.`;

function joinedText(bot: string, member: string, previousOwner?: string): string {
  const head = previousOwner
    ? `*${member}* took over this channel from *${previousOwner}* (deactivated).`
    : `Octipus joined this channel; *${member}* enrolled it.`;
  return `${head}\nMention me (\`${bot}\`) to ask something; I reply in a thread and keep following it. `
    + `I act with the permissions of whoever asks, and members need a linked Octipus account. `
    + `*${member}* can remove me with \`${bot} leave\`.`;
}

const leftText = (bot: string) => `Octipus left this channel. I'll stay quiet here until someone types \`${bot} join\`.`;
const pausedText = (bot: string) => 'I\'m paused here because the account that enrolled this channel is deactivated. '
  + `Any linked member can type \`${bot} join\` to take it over.`;

export async function handleSlackGroupMessage(msg: SlackGroupMessage, deps: SlackGroupDeps): Promise<GroupOutcome> {
  if (msg.bot_id || msg.subtype === 'bot_message' || !msg.user) return 'ignored';
  if (msg.subtype && !SPOKEN_SUBTYPES.has(msg.subtype)) return 'ignored';

  const slackUser = msg.user;
  const raw = msg.text ?? '';
  const mention = deps.botUserId ? `<@${deps.botUserId}>` : null;
  const mentioned = mention !== null && raw.includes(mention);
  const text = (mention ? raw.split(mention).join('') : raw).trim();
  const command = mentioned ? /^(join|leave|link)$/i.exec(text)?.[1]?.toLowerCase() : undefined;
  const bot = mention ?? '@Octipus';
  const threadTs = msg.thread_ts ?? msg.ts;

  if (command === 'link') {
    await deps.postEphemeral(msg.channel, slackUser, HINTS.linkInChannel, msg.thread_ts);
    return 'hint';
  }

  const group = await deps.findGroup(msg.channel);
  if (!group) {
    if (!mentioned) return 'ignored';
    if (command === 'join') return join(msg, slackUser, threadTs, bot, deps);
    if (deps.shouldSendHint(`unenrolled:${msg.channel}:${slackUser}`)) {
      await deps.postEphemeral(msg.channel, slackUser, HINTS.notEnrolled(bot), msg.thread_ts);
    }
    return 'hint';
  }

  const addressed = mentioned || (msg.thread_ts !== undefined && await deps.isThreadActive(group.id, msg.thread_ts));
  if (!addressed) return 'not_addressed';
  if (command === 'join') return join(msg, slackUser, threadTs, bot, deps);
  if (command === 'leave') return leave(msg, slackUser, threadTs, bot, deps);

  if (!(await deps.isGroupActive(group))) {
    if (deps.shouldSendHint(`paused:${group.id}`)) await deps.postInThread(msg.channel, threadTs, pausedText(bot));
    return 'paused';
  }

  const member = await deps.findMember(slackUser);
  if (!member || !member.isActive) {
    if (deps.shouldSendHint(`unlinked:${slackUser}`)) {
      await deps.postEphemeral(msg.channel, slackUser, HINTS.linkFirst, msg.thread_ts);
    }
    return 'hint';
  }

  if (await budgetPaused(group, msg.channel, threadTs, deps)) return 'paused';

  if (!text && !msg.files?.length) {
    await deps.postEphemeral(msg.channel, slackUser, HINTS.emptyMention, msg.thread_ts);
    return 'hint';
  }

  // `take this — <what>`: the member's own words are the request. Alone in a
  // thread, the thread's first message is.
  const takeText = mentioned ? parseTake(text) : null;
  let take: TakeRequest | undefined;
  if (takeText !== null) {
    if (takeText) {
      take = { text: takeText, messageKey: `${msg.channel}:${msg.ts}`, url: await deps.permalink(msg.channel, msg.ts) };
    } else if (msg.thread_ts) {
      const root = await deps.readMessage(msg.channel, msg.thread_ts);
      if (!root?.text.trim()) {
        await deps.postEphemeral(msg.channel, slackUser, HINTS.takeUnreadable, msg.thread_ts);
        return 'hint';
      }
      take = {
        text: root.text,
        author: root.user === slackUser ? undefined : await authorOf(root, deps),
        messageKey: `${msg.channel}:${msg.thread_ts}`,
        url: await deps.permalink(msg.channel, msg.thread_ts),
      };
    } else {
      await deps.postEphemeral(msg.channel, slackUser, HINTS.takeWhat, msg.thread_ts);
      return 'hint';
    }
  }

  // Read even for a short "yes": whether it answers a prompt is decided later,
  // and if it does not, the model needs the thread to know what it refers to.
  const context = await deps.readContext({ channelId: msg.channel, ts: msg.ts, threadTs: msg.thread_ts, label: group.label });
  deps.dispatch({
    channelId: msg.channel,
    member,
    userName: await deps.displayName(slackUser),
    text,
    threadTs,
    group,
    context,
    message: msg,
    take,
  });
  return take ? 'taken' : 'dispatched';
}

/**
 * 🐙 on a message in an enrolled channel: the member who reacted takes that
 * message on as a task, worked in its thread. The same rules as a mention:
 * silent in a channel nobody enrolled, a private hint for an unlinked member,
 * nothing while the channel is paused or out of budget.
 */
export async function handleSlackGroupReaction(ev: SlackReaction, deps: SlackGroupDeps): Promise<GroupOutcome> {
  const channel = ev.item?.channel;
  const ts = ev.item?.ts;
  const slackUser = ev.user;
  if (ev.reaction !== TAKE_REACTION || ev.item?.type !== 'message' || !channel || !ts || !slackUser) return 'ignored';
  if (slackUser === deps.botUserId) return 'ignored';

  const group = await deps.findGroup(channel);
  if (!group) return 'ignored';
  const taken = await deps.readMessage(channel, ts);
  const threadTs = taken?.threadTs ?? ts;

  if (!(await deps.isGroupActive(group))) {
    if (deps.shouldSendHint(`paused:${group.id}`)) await deps.postInThread(channel, threadTs, pausedText(deps.botUserId ? `<@${deps.botUserId}>` : '@Octipus'));
    return 'paused';
  }
  const member = await deps.findMember(slackUser);
  if (!member || !member.isActive) {
    if (deps.shouldSendHint(`unlinked:${slackUser}`)) await deps.postEphemeral(channel, slackUser, HINTS.linkFirst, taken?.threadTs);
    return 'hint';
  }
  if (await budgetPaused(group, channel, threadTs, deps)) return 'paused';
  if (!taken?.text.trim()) {
    await deps.postEphemeral(channel, slackUser, HINTS.takeUnreadable, taken?.threadTs);
    return 'hint';
  }

  const take: TakeRequest = {
    text: taken.text,
    author: taken.user === slackUser ? undefined : await authorOf(taken, deps),
    messageKey: `${channel}:${ts}`,
    url: await deps.permalink(channel, ts),
  };
  // The taken message is left out of the transcript: it reaches the turn as
  // the request itself (see `takeContext`).
  const context = await deps.readContext({ channelId: channel, ts, threadTs: taken.threadTs, label: group.label });
  deps.dispatch({
    channelId: channel,
    member,
    userName: await deps.displayName(slackUser),
    text: TAKE_REACTION_TEXT,
    threadTs,
    group,
    context,
    // The reacted-to message stands in for the member's: the dispatcher puts
    // its progress reactions (👀, ✅) on it.
    message: { user: slackUser, channel, ts, thread_ts: taken.threadTs, text: TAKE_REACTION_TEXT },
    take,
  });
  return 'taken';
}

/** The name a taken message is attributed to: its author, the bot, or an app. */
async function authorOf(post: SlackPost, deps: SlackGroupDeps): Promise<string> {
  if (post.user && post.user === deps.botUserId) return 'Octipus';
  if (post.user) return deps.displayName(post.user);
  return 'an app';
}

/** True (after one notice a day) while the channel's spend budget is used up. */
async function budgetPaused(group: GroupChannel, channel: string, threadTs: string, deps: SlackGroupDeps): Promise<boolean> {
  const pause = await deps.budgetPause(group);
  if (!pause) return false;
  if (deps.shouldSendHint(`budget:${group.id}`)) await deps.postInThread(channel, threadTs, budgetPausedText(pause.resetsAt));
  return true;
}

async function join(msg: SlackGroupMessage, slackUser: string, threadTs: string, bot: string, deps: SlackGroupDeps): Promise<GroupOutcome> {
  const member = await deps.findMember(slackUser);
  if (!member || !member.isActive) {
    await deps.postEphemeral(msg.channel, slackUser, HINTS.linkFirst, msg.thread_ts);
    return 'hint';
  }
  const result = await deps.join({ channelId: msg.channel, label: await deps.channelLabel(msg.channel), userId: member.id });
  switch (result.status) {
    case 'enrolled':
      await deps.postInThread(msg.channel, threadTs, joinedText(bot, member.username));
      return 'joined';
    case 'took_over':
      await deps.postInThread(msg.channel, threadTs, joinedText(bot, member.username, result.previousOwner));
      return 'joined';
    case 'already_yours':
      await deps.postEphemeral(msg.channel, slackUser, HINTS.alreadyYours, msg.thread_ts);
      return 'hint';
    case 'taken':
      await deps.postEphemeral(msg.channel, slackUser, HINTS.taken(result.ownerName), msg.thread_ts);
      return 'hint';
  }
}

async function leave(msg: SlackGroupMessage, slackUser: string, threadTs: string, bot: string, deps: SlackGroupDeps): Promise<GroupOutcome> {
  const member = await deps.findMember(slackUser);
  if (!member || !member.isActive) {
    await deps.postEphemeral(msg.channel, slackUser, HINTS.notOwner, msg.thread_ts);
    return 'hint';
  }
  const result = await deps.leave({ channelId: msg.channel, userId: member.id, isAdmin: member.isAdmin });
  if (result === 'left') {
    await deps.postInThread(msg.channel, threadTs, leftText(bot));
    return 'left';
  }
  await deps.postEphemeral(msg.channel, slackUser, result === 'not_owner' ? HINTS.notOwner : HINTS.notEnrolledLeave, msg.thread_ts);
  return 'hint';
}
