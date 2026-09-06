/**
 * Reading Slack conversations.
 *
 * The client is an injected interface rather than a `WebClient`, so the whole
 * read path is testable without a workspace — and so the caller decides which
 * token each call uses. That last part matters: history and replies work on
 * the bot token the channel already holds, but `search.messages` is not
 * available to a bot token at all, only to a user token. Rather than pretend
 * otherwise, `searchSlackMessages` is a separate entry point and the tool asks
 * for the user token explicitly.
 */
import {
  type ChannelMessage,
  cleanSlackText,
  isoToSlackTs,
  slackTsToIso,
} from './messages';

export interface RawSlackMessage {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  permalink?: string;
}

export interface SlackConversation {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
}

export interface SlackReadClient {
  conversationsList(args: { types: string; limit: number; cursor?: string; exclude_archived: boolean }):
    Promise<{ channels?: SlackConversation[]; response_metadata?: { next_cursor?: string } }>;
  conversationsHistory(args: { channel: string; limit: number; oldest?: string; latest?: string; cursor?: string }):
    Promise<{ messages?: RawSlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>;
  conversationsReplies(args: { channel: string; ts: string; limit: number }):
    Promise<{ messages?: RawSlackMessage[] }>;
  usersInfo(args: { user: string }): Promise<{ user?: { id: string; real_name?: string; name?: string } }>;
  searchMessages?(args: { query: string; count: number; sort: string }): Promise<{
    messages?: {
      matches?: Array<{
        ts: string; text?: string; username?: string; user?: string;
        channel?: { id?: string; name?: string }; permalink?: string;
      }>;
    };
  }>;
}

export class SlackReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackReadError';
  }
}

/** A channel id, as opposed to a name the user typed. */
export function looksLikeChannelId(target: string): boolean {
  return /^[CDG][A-Z0-9]{6,}$/.test(target);
}

/**
 * Turn `#engineering`, `engineering` or `C0123ABCD` into a conversation.
 *
 * Slack has no lookup-by-name API, so a name means paging `conversations.list`.
 * The paging is bounded: a workspace with more channels than this needs the
 * id, and saying so beats scanning forever.
 */
export async function resolveSlackConversation(
  client: SlackReadClient,
  target: string,
): Promise<SlackConversation> {
  const wanted = target.trim().replace(/^#/, '');
  if (wanted.length === 0) throw new SlackReadError('No channel given');
  if (looksLikeChannelId(wanted)) return { id: wanted };

  const MAX_PAGES = 10;
  const seen: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.conversationsList({
      types: 'public_channel,private_channel',
      limit: 200,
      cursor,
      exclude_archived: true,
    });
    for (const channel of res.channels ?? []) {
      if (channel.name?.toLowerCase() === wanted.toLowerCase()) return channel;
      if (channel.name) seen.push(channel.name);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  const nearby = seen
    .filter((name) => name.toLowerCase().includes(wanted.toLowerCase().slice(0, 4)))
    .slice(0, 10);
  throw new SlackReadError(
    `No channel named "${wanted}" is visible to the bot. Invite it to the channel first.${nearby.length > 0 ? ` Similar names: ${nearby.join(', ')}` : ''}`,
  );
}

/** Resolve author ids to display names once per batch, not once per message. */
async function nameLookup(
  client: SlackReadClient,
  messages: RawSlackMessage[],
): Promise<Map<string, string>> {
  const ids = [...new Set(messages.map((m) => m.user).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await client.usersInfo({ user: id });
      const name = res.user?.real_name || res.user?.name;
      if (name) names.set(id, name);
    } catch {
      // A deactivated or out-of-scope user is not an error for a transcript;
      // the id still identifies them consistently across messages.
    }
  }));
  return names;
}

function toChannelMessage(
  raw: RawSlackMessage,
  conversation: SlackConversation,
  names: Map<string, string>,
): ChannelMessage {
  const authorId = raw.user ?? raw.bot_id;
  const message: ChannelMessage = {
    id: raw.ts,
    conversationId: conversation.id,
    author: raw.username || (raw.user ? names.get(raw.user) ?? raw.user : raw.bot_id ?? 'unknown'),
    text: cleanSlackText(raw.text ?? '', names),
    at: slackTsToIso(raw.ts),
  };
  if (conversation.name) message.conversationName = conversation.name;
  if (authorId) message.authorId = authorId;
  if (raw.thread_ts && raw.thread_ts !== raw.ts) message.threadId = raw.thread_ts;
  if (raw.reply_count) message.replyCount = raw.reply_count;
  if (raw.permalink) message.permalink = raw.permalink;
  return message;
}

export interface SlackHistoryOptions {
  target: string;
  limit: number;
  /** ISO-8601 lower bound (inclusive). */
  after?: string;
  /** ISO-8601 upper bound. */
  before?: string;
  /** Read one thread instead of the channel: the parent message's `ts`. */
  thread?: string;
}

export async function readSlackHistory(
  client: SlackReadClient,
  options: SlackHistoryOptions,
): Promise<{ conversation: SlackConversation; messages: ChannelMessage[]; hasMore: boolean }> {
  const conversation = await resolveSlackConversation(client, options.target);

  if (options.thread) {
    const res = await client.conversationsReplies({
      channel: conversation.id,
      ts: options.thread,
      limit: options.limit,
    });
    const raw = res.messages ?? [];
    const names = await nameLookup(client, raw);
    return {
      conversation,
      messages: raw.map((m) => toChannelMessage(m, conversation, names)),
      hasMore: false,
    };
  }

  const res = await client.conversationsHistory({
    channel: conversation.id,
    limit: options.limit,
    oldest: options.after ? isoToSlackTs(options.after) : undefined,
    latest: options.before ? isoToSlackTs(options.before) : undefined,
  });
  const raw = res.messages ?? [];
  const names = await nameLookup(client, raw);
  return {
    conversation,
    messages: raw.map((m) => toChannelMessage(m, conversation, names)),
    hasMore: res.has_more === true,
  };
}

/**
 * Slack's own message search. Requires a user token — see the file header.
 *
 * `in:#channel` and `after:YYYY-MM-DD` are Slack's own modifiers, so they are
 * appended to the query rather than passed as parameters.
 */
export async function searchSlackMessages(
  client: SlackReadClient,
  options: { query: string; limit: number; target?: string; after?: string },
): Promise<ChannelMessage[]> {
  if (!client.searchMessages) {
    throw new SlackReadError('This Slack client cannot search');
  }

  const parts = [options.query];
  if (options.target) parts.push(`in:#${options.target.replace(/^#/, '')}`);
  if (options.after) {
    const day = options.after.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) parts.push(`after:${day}`);
  }

  const res = await client.searchMessages({
    query: parts.join(' '),
    count: options.limit,
    sort: 'timestamp',
  });

  return (res.messages?.matches ?? []).map((match) => {
    const message: ChannelMessage = {
      id: match.ts,
      conversationId: match.channel?.id ?? '',
      author: match.username || match.user || 'unknown',
      text: cleanSlackText(match.text ?? ''),
      at: slackTsToIso(match.ts),
    };
    if (match.channel?.name) message.conversationName = match.channel.name;
    if (match.user) message.authorId = match.user;
    if (match.permalink) message.permalink = match.permalink;
    return message;
  });
}
