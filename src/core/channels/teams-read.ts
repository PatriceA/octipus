/**
 * Reading Microsoft Teams conversations.
 *
 * Deliberately NOT through `TeamsChannel`. That class holds a Bot Framework
 * app credential and an in-memory map of conversation references — it can
 * reply to a conversation the process has already seen, and nothing else. It
 * cannot read history, and it never knew a conversation existed before someone
 * spoke in it.
 *
 * Microsoft Graph can, on the signed-in user's behalf, with the delegated
 * token the `microsoft365` tool group already obtains. So this reads as the
 * user, which is also the right answer for privacy: an agent sees exactly the
 * conversations its user can see.
 */
import { type ChannelMessage, cleanHtml } from './messages';

export interface GraphClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export class TeamsReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsReadError';
  }
}

interface GraphMessage {
  id: string;
  createdDateTime?: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: { id?: string; displayName?: string }; application?: { displayName?: string } };
  replyToId?: string;
  webUrl?: string;
  messageType?: string;
}

interface GraphList<T> { value?: T[]; '@odata.nextLink'?: string }

/** A Teams conversation: either a channel inside a team, or a 1:1 / group chat. */
export interface TeamsConversation {
  kind: 'channel' | 'chat';
  id: string;
  name?: string;
  teamId?: string;
  teamName?: string;
  /** Graph path prefix for this conversation's messages. */
  path: string;
}

/** Graph chat ids are long and unmistakable; a channel id has its own shape. */
function looksLikeChatId(target: string): boolean {
  return target.startsWith('19:') && target.includes('@thread');
}

/**
 * Resolve `Engineering/General`, a raw channel id, or a chat id.
 *
 * A bare name is ambiguous — Teams allows the same channel name in several
 * teams — so a name must be qualified as `team/channel`. Saying that is
 * better than picking one team and being quietly wrong about which General.
 */
export async function resolveTeamsConversation(
  graph: GraphClient,
  target: string,
): Promise<TeamsConversation> {
  const wanted = target.trim();
  if (wanted.length === 0) throw new TeamsReadError('No channel or chat given');

  if (looksLikeChatId(wanted) && !wanted.includes('/')) {
    // A channel id has the same 19:...@thread shape as a chat id, so a bare
    // one is only usable as a chat; a channel needs its team.
    return { kind: 'chat', id: wanted, path: `/chats/${wanted}` };
  }

  const [teamPart, channelPart] = wanted.split('/').map((part) => part.trim());
  if (!channelPart) {
    throw new TeamsReadError(
      `Name a Teams channel as "Team/Channel" (e.g. "Engineering/General"), or pass a chat id. Got "${wanted}".`,
    );
  }

  const teams = await graph.get('/me/joinedTeams?$select=id,displayName') as GraphList<{ id: string; displayName: string }>;
  const team = (teams.value ?? []).find((t) => t.displayName?.toLowerCase() === teamPart.toLowerCase());
  if (!team) {
    const names = (teams.value ?? []).map((t) => t.displayName).slice(0, 20);
    throw new TeamsReadError(
      `No team named "${teamPart}".${names.length > 0 ? ` Teams you are in: ${names.join(', ')}` : ''}`,
    );
  }

  const channels = await graph.get(`/teams/${team.id}/channels?$select=id,displayName`) as GraphList<{ id: string; displayName: string }>;
  const channel = (channels.value ?? []).find((c) => c.displayName?.toLowerCase() === channelPart.toLowerCase());
  if (!channel) {
    const names = (channels.value ?? []).map((c) => c.displayName).slice(0, 20);
    throw new TeamsReadError(
      `Team "${team.displayName}" has no channel named "${channelPart}".${names.length > 0 ? ` Channels: ${names.join(', ')}` : ''}`,
    );
  }

  return {
    kind: 'channel',
    id: channel.id,
    name: channel.displayName,
    teamId: team.id,
    teamName: team.displayName,
    path: `/teams/${team.id}/channels/${channel.id}`,
  };
}

function toChannelMessage(raw: GraphMessage, conversation: TeamsConversation): ChannelMessage {
  const body = raw.body?.content ?? '';
  const message: ChannelMessage = {
    id: raw.id,
    conversationId: conversation.id,
    author: raw.from?.user?.displayName ?? raw.from?.application?.displayName ?? 'unknown',
    text: raw.body?.contentType === 'html' ? cleanHtml(body) : body.trim(),
    at: raw.createdDateTime ?? new Date(0).toISOString(),
  };
  const name = conversation.teamName && conversation.name
    ? `${conversation.teamName}/${conversation.name}`
    : conversation.name;
  if (name) message.conversationName = name;
  if (raw.from?.user?.id) message.authorId = raw.from.user.id;
  if (raw.replyToId) message.threadId = raw.replyToId;
  if (raw.webUrl) message.permalink = raw.webUrl;
  return message;
}

export interface TeamsHistoryOptions {
  target: string;
  limit: number;
  after?: string;
  before?: string;
  /** Read the replies to one message instead of the conversation. */
  thread?: string;
}

export async function readTeamsHistory(
  graph: GraphClient,
  options: TeamsHistoryOptions,
): Promise<{ conversation: TeamsConversation; messages: ChannelMessage[]; hasMore: boolean }> {
  const conversation = await resolveTeamsConversation(graph, options.target);
  const top = Math.min(Math.max(options.limit, 1), 50);

  const path = options.thread
    ? `${conversation.path}/messages/${options.thread}/replies?$top=${top}`
    : `${conversation.path}/messages?$top=${top}`;

  const res = await graph.get(path) as GraphList<GraphMessage>;
  let messages = (res.value ?? [])
    // A join/leave/rename event has no body worth quoting.
    .filter((raw) => (raw.messageType ?? 'message') === 'message')
    .map((raw) => toChannelMessage(raw, conversation));

  // Graph's channel-message endpoint has no time filter, so the window is
  // applied here. It narrows the page that came back rather than paging
  // further, which is reported as `hasMore`.
  if (options.after) messages = messages.filter((m) => m.at >= options.after!);
  if (options.before) messages = messages.filter((m) => m.at <= options.before!);

  return {
    conversation,
    messages: messages.filter((m) => m.text.length > 0),
    hasMore: Boolean(res['@odata.nextLink']),
  };
}

/**
 * Search Teams messages with the Graph search API.
 *
 * This is a real index search across the user's chats and channels, so unlike
 * the Slack fallback it does not need a channel to scan.
 */
export async function searchTeamsMessages(
  graph: GraphClient,
  options: { query: string; limit: number },
): Promise<ChannelMessage[]> {
  const size = Math.min(Math.max(options.limit, 1), 50);
  const res = await graph.post('/search/query', {
    requests: [{
      entityTypes: ['chatMessage'],
      query: { queryString: options.query },
      from: 0,
      size,
    }],
  }) as {
    value?: Array<{
      hitsContainers?: Array<{
        hits?: Array<{ resource?: GraphMessage & { channelIdentity?: { channelId?: string }; chatId?: string } }>;
      }>;
    }>;
  };

  const hits = res.value?.[0]?.hitsContainers?.flatMap((c) => c.hits ?? []) ?? [];
  return hits
    .map((hit) => hit.resource)
    .filter((raw): raw is NonNullable<typeof raw> => !!raw)
    .map((raw) => {
      const conversationId = raw.channelIdentity?.channelId ?? raw.chatId ?? '';
      return toChannelMessage(raw, { kind: 'chat', id: conversationId, path: '' });
    })
    .filter((message) => message.text.length > 0);
}
