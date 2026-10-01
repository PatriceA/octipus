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
 *  - the turn runs as the member who asked, never as the channel's owner.
 *
 * Platform calls are injected so the rules can be tested without Slack.
 */
import type { GroupChannel } from '@/db/schema/group-channels';
import type { JoinResult, LeaveResult } from '@/channels/group-channels';

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
  }): void;
}

export type GroupOutcome =
  | 'ignored'
  | 'not_addressed'
  | 'hint'
  | 'joined'
  | 'left'
  | 'paused'
  | 'dispatched';

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
};

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

  if (!text && !msg.files?.length) {
    await deps.postEphemeral(msg.channel, slackUser, HINTS.emptyMention, msg.thread_ts);
    return 'hint';
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
  });
  return 'dispatched';
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
