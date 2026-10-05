/**
 * Group-channel rules, the same on every platform: what the bot does with a
 * message posted in a shared chat (not a DM). The platform adapters
 * (`slack/group.ts`, `teams/group.ts`, `telegram/group.ts`) turn their own
 * events into a `GroupInbound` and supply the platform calls.
 *
 * Rules (docs/plans/group-chat-bot.md):
 *  - not enrolled → silent; only `join` with a mention does anything, and a
 *    mention gets a private hint at most once a day;
 *  - enrolled → act only when addressed: a mention, a reply to one of the
 *    bot's messages, or a reply in a thread the bot is already part of;
 *  - `link` is never answered in a channel — a link code posted where others
 *    can read it could be redeemed by someone else;
 *  - unlinked members get one private hint a day, never a public prompt;
 *  - the turn runs as the member who asked, never as the channel's owner;
 *  - in a channel bound to a space, only members of the space whose role may
 *    ask get a turn (a room turn); other linked members get a private hint;
 *  - `take this …` (or a reaction, where the platform has one) takes work on
 *    as a task on the member's board, worked in their thread
 *    (src/core/channels/taken-tasks.ts);
 *  - while the channel's spend budget is used up, one notice a day and no turns.
 */
import { bareReply } from '@/core/channels/group-context';
import type { GroupChannel } from '@/db/schema/group-channels';
import type { BridgeAccess } from '@/channels/group-bridge';
import type { JoinResult, LeaveResult } from '@/channels/group-channels';
import type { TakeRequest } from '@/core/channels/taken-tasks';

export interface GroupMember {
  id: string;
  username: string;
  isActive: boolean;
  isAdmin: boolean;
}

/** One message read back from the platform. */
export interface GroupPost {
  text: string;
  /** The author's platform user id; null for a post by an app. */
  user: string | null;
  /** Where the message is a reply in a thread: that thread. */
  threadId?: string;
}

/** A message in a shared chat, as the adapter hands it over. */
export interface GroupInbound<Raw = unknown> {
  /** The sender's platform user id (what their linked identity is keyed by). */
  user: string;
  /** The chat the enrolment is keyed by. */
  channelId: string;
  /** This message's own platform id. */
  messageId: string;
  /** Set when the message is a reply inside a thread: that thread. The bot follows threads it is part of. */
  threadId?: string;
  /** Where the bot answers: the thread, or the one this message starts, or the chat's single thread. */
  replyThread: string;
  /** The text with the bot's mention removed. */
  text: string;
  mentioned: boolean;
  /** A reply to one of the bot's own messages: addressed like a mention. */
  repliedToBot?: boolean;
  /** The message this one replies to, when the platform hands it over — `take this` takes it. */
  replyTo?: GroupPost & { id: string };
  hasFiles: boolean;
  /** The platform's own event, for the adapter's `dispatch`. */
  raw?: Raw;
}

/** Where a private hint is about: the adapter decides how to reach the member privately. */
export interface HintTarget {
  channelId: string;
  /** The thread the triggering message is in, if any. */
  threadId?: string;
  /** The message the hint answers. */
  messageId: string;
}

export interface GroupDeps<Raw = unknown> {
  /** The bot's own platform user id. Used to attribute its own messages. */
  botUserId: string | null;
  /** How members address the bot, for the texts (`<@U123>`, `@octipus_bot`). */
  bot: string;
  /** Hint texts for this platform (`groupHints`). */
  hints: GroupHints;
  findGroup(channelId: string): Promise<GroupChannel | null>;
  isGroupActive(group: GroupChannel): Promise<boolean>;
  isThreadActive(groupId: string, threadId: string): Promise<boolean>;
  findMember(platformUserId: string): Promise<GroupMember | null>;
  join(input: { channelId: string; label: string | null; userId: string }): Promise<JoinResult>;
  leave(input: { channelId: string; userId: string; isAdmin: boolean }): Promise<LeaveResult>;
  channelLabel(channelId: string): Promise<string | null>;
  displayName(platformUserId: string): Promise<string>;
  /** A message only this member sees (ephemeral, or a direct message). */
  postPrivate(platformUserId: string, text: string, where: HintTarget): Promise<void>;
  postInThread(channelId: string, threadId: string, text: string): Promise<void>;
  /** The transcript for the turn. `threadId` is set when the message is inside a thread. */
  readContext(input: { channelId: string; messageId: string; threadId?: string; replyThread: string; label: string | null }): Promise<string>;
  /** One message by its id; null when it cannot be read. */
  readMessage(channelId: string, messageId: string): Promise<GroupPost | null>;
  /** A link to a message, for the task notes; undefined when the platform gives none. */
  permalink(channelId: string, messageId: string): Promise<string | undefined>;
  /** When the channel's spend budget is used up: when it resets. Null while it may run. */
  budgetPause(group: GroupChannel): Promise<{ resetsAt: string } | null>;
  shouldSendHint(key: string): boolean;
  /** Every message in an enrolled chat that reaches the bot, addressed or not (for adapters that keep a transcript). */
  seen?(msg: GroupInbound<Raw>, group: GroupChannel): void;
  /** The chat was enrolled or left: drop what the adapter kept about it. */
  forget?(channelId: string): void;
  /**
   * For a channel bound to a space (§9.4): whether this linked member may
   * ask there. Defaults to the space membership read now (`group-bridge.ts`).
   */
  bridgeAccess?(group: GroupChannel, userId: string): Promise<BridgeAccess>;
  /** Store (or, with `removed`, withdraw) a member's ✅ / ❌ on one of the bot's messages. */
  feedback?(input: { groupChannelId: string; messageId: string; threadId?: string; userId: string; value: 1 | -1; removed: boolean }): Promise<void>;
  dispatch(input: {
    channelId: string;
    member: GroupMember;
    userName: string;
    text: string;
    threadId: string;
    group: GroupChannel;
    context: string;
    /** The message the turn answers; its id carries the progress reactions. */
    message: GroupInbound<Raw>;
    /** Set when the member asked the bot to take the work on (`take this`, 🐙). */
    take?: TakeRequest;
  }): void | Promise<void>;
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

/** The single thread of a chat without threads (a Teams group chat, a Telegram group). */
export const MAIN_THREAD = 'main';

/**
 * How a member answers a prompt in a group chat, for the prompt texts. Teams
 * delivers only messages that mention the bot; Telegram (privacy mode) only
 * those and replies to the bot.
 */
export function answerHow(channelType: string, threadId?: string): string {
  const inThread = threadId !== undefined && threadId !== MAIN_THREAD;
  if (channelType === 'teams') return inThread ? 'in the thread, mentioning me' : 'mentioning me';
  if (channelType === 'telegram') return 'as a reply to my message, or mentioning me';
  return threadId ? 'in the thread' : 'in the chat';
}

/** What the member "says" when they take a message on with a reaction. */
export const TAKE_REACTION_TEXT = 'Take this on.';

/**
 * `take this — <what>`, `take it: <what>`, `take this on`, after the bot
 * mention is removed: what follows (possibly empty), or null when the message
 * is not a take command. The words must be followed by the end, a line break
 * or a separator (`—`, `:`, …), so "take a look at …" and "take it easy on
 * the wording" stay ordinary requests.
 */
export function parseTake(text: string): string | null {
  const m = /^take\s+(?:this|it)(?:\s+on)?[.!]?(?:$|[ \t]*(?:\r?\n|[:—–]|\s-+\s|,(?=\s*please\b))([\s\S]*)$)/i.exec(text.trim());
  if (!m) return null;
  return (m[1] ?? '').replace(/^[\s:,.;!—–-]+/, '').trim();
}

/** How a platform's members link an account and hand work over, for the hint texts. */
export interface GroupPlatformText {
  /** `Slack`, `Teams`, `Telegram`. */
  platform: string;
  /** `send me \`link\` in a direct message`. */
  linkHow: string;
  /** The ways to take work on besides `take this — <what>`, e.g. `or add :octopus: to a message`. */
  takeAlso: string;
  /** How a conversation with the bot continues, e.g. `I reply in a thread and keep following it`. */
  followHow: string;
}

export type GroupHints = ReturnType<typeof groupHints>;

export function groupHints(p: GroupPlatformText) {
  const linkHow = p.linkHow.charAt(0).toUpperCase() + p.linkHow.slice(1);
  return {
    linkInChannel: `For your security I never post link codes in a channel. ${linkHow} instead.`,
    notEnrolled: (bot: string) => `I'm not active in this channel. Any linked member can enrol it by typing \`${bot} join\` here.`,
    linkFirst: `Link your ${p.platform} account to Octipus first: ${p.linkHow} and enter the code under Settings → Channels.`,
    emptyMention: 'Ask me something after the mention, e.g. `@Octipus what did we decide about the release?`',
    alreadyYours: 'You already enrolled this channel.',
    taken: (owner: string) => `This channel is already enrolled by *${owner}*. Ask them, or an admin, if it should change.`,
    notOwner: 'Only the member who enrolled me here, or an Octipus admin, can remove me.',
    notEnrolledLeave: "I'm not enrolled in this channel, so there is nothing to leave.",
    takeWhat: `Say what to take on: \`@Octipus take this — <what>\`, ${p.takeAlso}.`,
    takeUnreadable: "I couldn't read that message, so I can't take it on.",
    joined: (bot: string, member: string, previousOwner?: string) => {
      const head = previousOwner
        ? `*${member}* took over this channel from *${previousOwner}* (deactivated).`
        : `Octipus joined this channel; *${member}* enrolled it.`;
      return `${head}\nMention me (\`${bot}\`) to ask something; ${p.followHow}. `
        + `I act with the permissions of whoever asks, and members need a linked Octipus account. `
        + `*${member}* can remove me with \`${bot} leave\`.`;
    },
  };
}

/** Posted once a day while the channel's spend budget is used up. */
const budgetPausedText = (resetsAt: string) => `I'm paused in this channel: its spend budget is used up until `
  + `${resetsAt.slice(0, 10)} ${resetsAt.slice(11, 16)} UTC. An Octipus admin can raise it.`;

const leftText = (bot: string) => `Octipus left this channel. I'll stay quiet here until someone types \`${bot} join\`.`;
const pausedText = (bot: string) => 'I\'m paused here because the account that enrolled this channel is deactivated. '
  + `Any linked member can type \`${bot} join\` to take it over.`;

const hintTarget = (msg: GroupInbound): HintTarget => ({ channelId: msg.channelId, threadId: msg.threadId, messageId: msg.messageId });

export async function handleGroupMessage<Raw>(msg: GroupInbound<Raw>, deps: GroupDeps<Raw>): Promise<GroupOutcome> {
  const { user, text, mentioned } = msg;
  const command = mentioned ? /^(join|leave|link)$/i.exec(text)?.[1]?.toLowerCase() : undefined;
  const where = hintTarget(msg);

  if (command === 'link') {
    if (deps.shouldSendHint(`link:${user}`)) await deps.postPrivate(user, deps.hints.linkInChannel, where);
    return 'hint';
  }

  const group = await deps.findGroup(msg.channelId);
  if (!group) {
    if (!mentioned) return 'ignored';
    if (command === 'join') return join(msg, deps);
    if (deps.shouldSendHint(`unenrolled:${msg.channelId}:${user}`)) {
      await deps.postPrivate(user, deps.hints.notEnrolled(deps.bot), where);
    }
    return 'hint';
  }
  deps.seen?.(msg, group);

  const addressed = mentioned || msg.repliedToBot === true
    || (msg.threadId !== undefined && await deps.isThreadActive(group.id, msg.threadId));
  if (!addressed) return 'not_addressed';
  if (command === 'join') return join(msg, deps);
  if (command === 'leave') return leave(msg, deps);

  if (!(await deps.isGroupActive(group))) {
    if (deps.shouldSendHint(`paused:${group.id}`)) await deps.postInThread(msg.channelId, msg.replyThread, pausedText(deps.bot));
    return 'paused';
  }

  const member = await deps.findMember(user);
  if (!member || !member.isActive) {
    if (deps.shouldSendHint(`unlinked:${user}`)) await deps.postPrivate(user, deps.hints.linkFirst, where);
    return 'hint';
  }
  if (await refusedByBridge(group, member, user, where, deps)) return 'hint';

  // A bare yes/no may answer a prompt raised before the budget ran out, so it
  // still goes through; a new turn it would start is refused by the budget.
  // Not one that starts a new thread: no prompt can be waiting there.
  const answering = msg.replyThread !== msg.messageId && bareReply(text);
  if (!answering && await budgetPaused(group, msg.channelId, msg.replyThread, deps)) return 'paused';

  if (!text && !msg.hasFiles) {
    await deps.postPrivate(user, deps.hints.emptyMention, where);
    return 'hint';
  }

  // `take this — <what>`: the member's own words are the request. Alone, the
  // message it replies to is (where the platform says), else the thread's
  // first message.
  const takeText = mentioned ? parseTake(text) : null;
  let take: TakeRequest | undefined;
  if (takeText !== null) {
    if (takeText) {
      take = { text: takeText, messageKey: `${msg.channelId}:${msg.messageId}`, url: await deps.permalink(msg.channelId, msg.messageId) };
    } else if (msg.replyTo || msg.threadId) {
      const sourceId = msg.replyTo?.id ?? (msg.threadId as string);
      const source = msg.replyTo ?? await deps.readMessage(msg.channelId, sourceId);
      if (!source?.text.trim()) {
        await deps.postPrivate(user, deps.hints.takeUnreadable, where);
        return 'hint';
      }
      take = {
        text: source.text,
        author: source.user === user ? undefined : await authorOf(source, deps),
        quoted: true,
        messageKey: `${msg.channelId}:${sourceId}`,
        url: await deps.permalink(msg.channelId, sourceId),
      };
    } else {
      await deps.postPrivate(user, deps.hints.takeWhat, where);
      return 'hint';
    }
  }

  // Read even for a short "yes": whether it answers a prompt is decided later,
  // and if it does not, the model needs the thread to know what it refers to.
  const context = await deps.readContext({
    channelId: msg.channelId, messageId: msg.messageId, threadId: msg.threadId, replyThread: msg.replyThread, label: group.label,
  });
  await deps.dispatch({
    channelId: msg.channelId,
    member,
    userName: await deps.displayName(user),
    text,
    threadId: msg.replyThread,
    group,
    context,
    message: msg,
    take,
  });
  return take ? 'taken' : 'dispatched';
}

/**
 * A take-reaction on a message in an enrolled channel: the member who reacted
 * takes that message on as a task, worked in its thread. The same rules as a
 * mention: silent in a channel nobody enrolled, a private hint for an
 * unlinked member, nothing while the channel is paused or out of budget.
 * A top-level message's thread is the one it starts (its own id).
 */
export async function handleGroupReaction<Raw>(
  ev: { user: string; channelId: string; messageId: string },
  deps: GroupDeps<Raw>,
): Promise<GroupOutcome> {
  const { user, channelId, messageId } = ev;
  if (user === deps.botUserId) return 'ignored';

  const group = await deps.findGroup(channelId);
  if (!group) return 'ignored';
  const taken = await deps.readMessage(channelId, messageId);
  const replyThread = taken?.threadId ?? messageId;
  const where: HintTarget = { channelId, threadId: taken?.threadId, messageId };

  if (!(await deps.isGroupActive(group))) {
    if (deps.shouldSendHint(`paused:${group.id}`)) await deps.postInThread(channelId, replyThread, pausedText(deps.bot));
    return 'paused';
  }
  const member = await deps.findMember(user);
  if (!member || !member.isActive) {
    if (deps.shouldSendHint(`unlinked:${user}`)) await deps.postPrivate(user, deps.hints.linkFirst, where);
    return 'hint';
  }
  if (await refusedByBridge(group, member, user, where, deps)) return 'hint';
  if (await budgetPaused(group, channelId, replyThread, deps)) return 'paused';
  if (!taken?.text.trim()) {
    await deps.postPrivate(user, deps.hints.takeUnreadable, where);
    return 'hint';
  }

  const take: TakeRequest = {
    text: taken.text,
    author: taken.user === user ? undefined : await authorOf(taken, deps),
    quoted: true,
    messageKey: `${channelId}:${messageId}`,
    url: await deps.permalink(channelId, messageId),
  };
  // The taken message is left out of the transcript: it reaches the turn as
  // the request itself (see `takeContext`).
  const context = await deps.readContext({ channelId, messageId, threadId: taken.threadId, replyThread, label: group.label });
  await deps.dispatch({
    channelId,
    member,
    userName: await deps.displayName(user),
    text: TAKE_REACTION_TEXT,
    threadId: replyThread,
    group,
    context,
    // The reacted-to message stands in for the member's: the dispatcher puts
    // its progress reactions (👀, ✅) on it.
    message: {
      user, channelId, messageId, threadId: taken.threadId, replyThread, text: TAKE_REACTION_TEXT, mentioned: false, hasFiles: false,
    },
    take,
  });
  return 'taken';
}

/**
 * A ✅ / ❌ (or 👍 / 👎) a member put on — or took off — one of the bot's
 * messages in an enrolled channel: recorded as feedback on that reply
 * (`group_channel_feedback`), nothing more. Reactions on other messages,
 * from unlinked members or in other channels are ignored, silently.
 */
export async function handleGroupFeedback<Raw>(
  ev: { user: string; channelId: string; messageId: string; value: 1 | -1; removed: boolean },
  deps: GroupDeps<Raw>,
): Promise<'feedback' | 'ignored'> {
  if (!deps.feedback || ev.user === deps.botUserId) return 'ignored';
  const group = await deps.findGroup(ev.channelId);
  if (!group) return 'ignored';
  // The cheap lookup first: reading the message back is a rate-limited platform call.
  const member = await deps.findMember(ev.user);
  if (!member?.isActive) return 'ignored';
  const post = await deps.readMessage(ev.channelId, ev.messageId);
  if (!post || post.user === null || post.user !== deps.botUserId) return 'ignored';
  await deps.feedback({
    groupChannelId: group.id, messageId: ev.messageId, threadId: post.threadId, userId: member.id, value: ev.value, removed: ev.removed,
  });
  return 'feedback';
}

/** The name a taken message is attributed to: its author, the bot, or an app. */
async function authorOf<Raw>(post: GroupPost, deps: GroupDeps<Raw>): Promise<string> {
  if (post.user && post.user === deps.botUserId) return 'Octipus';
  if (post.user) return deps.displayName(post.user);
  return 'an app';
}

/**
 * A bound channel (§9.4) answers only members of its space whose role may
 * ask: anyone else linked gets a private hint (once a day) and no turn.
 */
async function refusedByBridge<Raw>(group: GroupChannel, member: GroupMember, user: string, where: HintTarget, deps: GroupDeps<Raw>): Promise<boolean> {
  if (!group.workspaceId) return false;
  const check = deps.bridgeAccess ?? (async (g: GroupChannel, userId: string) => (await import('@/channels/group-bridge')).bridgeAccess(g, userId));
  const access = await check(group, member.id);
  if (access === 'ok') return false;
  if (deps.shouldSendHint(`bridge:${group.id}:${user}`)) {
    const { bridgeHint } = await import('@/channels/group-bridge');
    await deps.postPrivate(user, bridgeHint(access), where);
  }
  return true;
}

/** True (after one notice a day) while the channel's spend budget is used up. */
async function budgetPaused<Raw>(group: GroupChannel, channelId: string, threadId: string, deps: GroupDeps<Raw>): Promise<boolean> {
  const pause = await deps.budgetPause(group);
  if (!pause) return false;
  if (deps.shouldSendHint(`budget:${group.id}`)) await deps.postInThread(channelId, threadId, budgetPausedText(pause.resetsAt));
  return true;
}

async function join<Raw>(msg: GroupInbound<Raw>, deps: GroupDeps<Raw>): Promise<GroupOutcome> {
  const where = hintTarget(msg);
  // Refusals are private and, on some platforms, open a direct chat: once a day.
  const refuse = async (text: string) => {
    if (deps.shouldSendHint(`join:${msg.channelId}:${msg.user}`)) await deps.postPrivate(msg.user, text, where);
    return 'hint' as const;
  };
  const member = await deps.findMember(msg.user);
  if (!member || !member.isActive) return refuse(deps.hints.linkFirst);
  const result = await deps.join({ channelId: msg.channelId, label: await deps.channelLabel(msg.channelId), userId: member.id });
  switch (result.status) {
    case 'enrolled':
      deps.forget?.(msg.channelId);
      await deps.postInThread(msg.channelId, msg.replyThread, deps.hints.joined(deps.bot, member.username));
      return 'joined';
    case 'took_over':
      deps.forget?.(msg.channelId);
      await deps.postInThread(msg.channelId, msg.replyThread, deps.hints.joined(deps.bot, member.username, result.previousOwner));
      return 'joined';
    case 'already_yours':
      return refuse(deps.hints.alreadyYours);
    case 'taken':
      return refuse(deps.hints.taken(result.ownerName));
  }
}

async function leave<Raw>(msg: GroupInbound<Raw>, deps: GroupDeps<Raw>): Promise<GroupOutcome> {
  const where = hintTarget(msg);
  const member = await deps.findMember(msg.user);
  if (!member || !member.isActive) {
    await deps.postPrivate(msg.user, deps.hints.notOwner, where);
    return 'hint';
  }
  const result = await deps.leave({ channelId: msg.channelId, userId: member.id, isAdmin: member.isAdmin });
  if (result === 'left') {
    await deps.postInThread(msg.channelId, msg.replyThread, leftText(deps.bot));
    deps.forget?.(msg.channelId);
    return 'left';
  }
  await deps.postPrivate(msg.user, result === 'not_owner' ? deps.hints.notOwner : deps.hints.notEnrolledLeave, where);
  return 'hint';
}
