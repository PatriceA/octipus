/**
 * Concrete clients for the channel read tools.
 *
 * The readers in `slack-read.ts` and `teams-read.ts` take injected interfaces
 * so they can be tested without a workspace or a tenant. This is where those
 * interfaces get their real implementations, and the only place that knows
 * about `WebClient` and the Graph base URL.
 */
import { getConfig } from '@/config';
import { getOAuthManager } from '@/security/oauth';
import { fetchWithTimeout } from '@/utils/http';
import type { SlackReadClient } from './slack-read';
import type { GraphClient } from './teams-read';

/** Minimal shape of the Slack Web API surface these tools use. */
interface SlackWebApi {
  conversations: {
    list(args: unknown): Promise<unknown>;
    history(args: unknown): Promise<unknown>;
    replies(args: unknown): Promise<unknown>;
  };
  users: { info(args: unknown): Promise<unknown> };
  search: { messages(args: unknown): Promise<unknown> };
}

function adapt(web: SlackWebApi, canSearch: boolean): SlackReadClient {
  const client: SlackReadClient = {
    conversationsList: (args) => web.conversations.list(args) as never,
    conversationsHistory: (args) => web.conversations.history(args) as never,
    conversationsReplies: (args) => web.conversations.replies(args) as never,
    usersInfo: (args) => web.users.info(args) as never,
  };
  // Only attach `searchMessages` when the token can actually use it, so the
  // reader's own capability check means what it says.
  if (canSearch) client.searchMessages = (args) => web.search.messages(args) as never;
  return client;
}

/**
 * The running bot's client, for reading history and replies.
 *
 * Null when Slack is not configured or not connected — the caller turns that
 * into a message telling the user to connect it, which is more useful than an
 * exception from deep inside the reader.
 */
export async function slackBotClient(): Promise<SlackReadClient | null> {
  const { slackChannel } = await import('@/channels/slack');
  const web = slackChannel.getWebClient();
  if (!web) return null;
  return adapt(web as unknown as SlackWebApi, false);
}

/**
 * A client on the configured user token, for `search.messages`.
 *
 * Slack does not expose message search to bot tokens at all, so without this
 * setting there is no search — only a scan of a named channel's history.
 */
export async function slackUserClient(): Promise<SlackReadClient | null> {
  const token = getConfig().slack?.userToken;
  if (!token) return null;
  const { WebClient } = await import('@slack/web-api');
  return adapt(new WebClient(token) as unknown as SlackWebApi, true);
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * A Microsoft Graph client acting as the given user.
 *
 * Same delegated token the `microsoft365` tool group uses, so connecting the
 * account once covers mail, calendar and now Teams.
 */
export async function teamsGraphClient(userId: string): Promise<GraphClient | null> {
  const token = await getOAuthManager().getValidToken(userId, 'microsoft');
  if (!token) return null;

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchWithTimeout(`${GRAPH_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Microsoft Graph error (${response.status}): ${detail.slice(0, 500)}`);
    }
    if (response.status === 204) return {};
    return response.json();
  };

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}
