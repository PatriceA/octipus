/**
 * Reading Slack and Teams conversations.
 *
 * Both readers take injected clients, so every case here runs against a fake
 * that returns exactly what the platform documents — no workspace, no tenant,
 * no network. The assertions that matter are the ones about *not* being
 * quietly wrong: an unresolvable channel name says which names exist, a bare
 * Teams channel name is refused rather than guessed at across teams, and
 * Slack's wire markup is turned back into something quotable.
 */
import { describe, expect, it } from 'vitest';
import {
  capMessages,
  type ChannelMessage,
  cleanHtml,
  cleanSlackText,
  isoToSlackTs,
  matchesQuery,
  slackTsToIso,
  sortNewestFirst,
} from './messages';
import {
  looksLikeChannelId,
  readSlackHistory,
  resolveSlackConversation,
  searchSlackMessages,
  SlackReadError,
  type SlackReadClient,
} from './slack-read';
import {
  readTeamsHistory,
  resolveTeamsConversation,
  searchTeamsMessages,
  TeamsReadError,
  type GraphClient,
} from './teams-read';

function slackClient(overrides: Partial<SlackReadClient> = {}): SlackReadClient {
  return {
    conversationsList: async () => ({
      channels: [
        { id: 'C0111AAAA', name: 'engineering' },
        { id: 'C0222BBBB', name: 'design' },
      ],
    }),
    conversationsHistory: async () => ({
      messages: [
        { ts: '1757000100.000100', text: 'Ship on <@U9>?', user: 'U1' },
        { ts: '1757000000.000100', text: 'Decision: we ship Friday', user: 'U2', reply_count: 2 },
      ],
      has_more: false,
    }),
    conversationsReplies: async () => ({
      messages: [
        { ts: '1757000000.000100', text: 'Decision: we ship Friday', user: 'U2' },
        { ts: '1757000050.000100', text: 'agreed', user: 'U1', thread_ts: '1757000000.000100' },
      ],
    }),
    usersInfo: async ({ user }) => ({ user: { id: user, real_name: user === 'U1' ? 'Ada' : 'Grace' } }),
    ...overrides,
  };
}

describe('slack timestamps', () => {
  it('round-trips', () => {
    // `.000100` is 100 microseconds, so it rounds away below millisecond
    // resolution — the seconds must still survive exactly.
    const iso = slackTsToIso('1757000000.000100');
    expect(iso).toBe('2025-09-04T15:33:20.000Z');
    expect(isoToSlackTs(iso)).toBe('1757000000.000000');
  });

  it('does not throw on nonsense', () => {
    expect(slackTsToIso('nope')).toBe('1970-01-01T00:00:00.000Z');
    expect(isoToSlackTs('nope')).toBeUndefined();
  });
});

describe('cleanSlackText', () => {
  it('turns wire markup back into something quotable', () => {
    const names = new Map([['U1', 'Ada']]);
    expect(cleanSlackText('hi <@U1> see <#C9|eng> and <https://x.dev|the doc>', names))
      .toBe('hi @Ada see #eng and the doc (https://x.dev)');
  });

  it('falls back to the id when the name is unknown', () => {
    expect(cleanSlackText('<@U404>')).toBe('@U404');
  });

  it('unescapes the entities Slack sends', () => {
    expect(cleanSlackText('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
  });

  it('keeps a bare link readable', () => {
    expect(cleanSlackText('see <https://x.dev/a>')).toBe('see https://x.dev/a');
  });
});

describe('cleanHtml', () => {
  it('renders the HTML Teams sends as text', () => {
    expect(cleanHtml('<p>We ship <b>Friday</b></p><p>Agreed&nbsp;&amp; done</p>'))
      .toBe('We ship Friday\n\nAgreed & done');
  });
});

describe('matchesQuery', () => {
  const message: ChannelMessage = {
    id: '1', conversationId: 'C1', author: 'Ada', text: 'we ship on Friday', at: '2026-09-01T00:00:00Z',
  };

  it('requires every term', () => {
    expect(matchesQuery(message, 'ship friday')).toBe(true);
    expect(matchesQuery(message, 'ship monday')).toBe(false);
  });

  it('matches a quoted phrase whole', () => {
    expect(matchesQuery(message, '"ship on"')).toBe(true);
    expect(matchesQuery(message, '"ship Friday"')).toBe(false);
  });

  it('matches the author too', () => {
    expect(matchesQuery(message, 'ada')).toBe(true);
  });

  it('is false for an empty query', () => {
    expect(matchesQuery(message, '   ')).toBe(false);
  });
});

describe('capMessages', () => {
  it('drops whole messages rather than cutting one in half', () => {
    const many: ChannelMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), conversationId: 'C1', author: 'Ada', text: 'x'.repeat(100), at: '2026-09-01T00:00:00Z',
    }));
    const kept = capMessages(many, 400);
    expect(kept.length).toBeLessThan(10);
    expect(kept.every((m) => m.text.length === 100)).toBe(true);
  });

  it('always keeps at least one', () => {
    const one: ChannelMessage[] = [{ id: '1', conversationId: 'C1', author: 'A', text: 'x'.repeat(999), at: 'z' }];
    expect(capMessages(one, 10)).toHaveLength(1);
  });
});

describe('sortNewestFirst', () => {
  it('orders by timestamp descending', () => {
    const out = sortNewestFirst([
      { id: 'a', conversationId: 'C', author: 'A', text: 'a', at: '2026-01-01T00:00:00Z' },
      { id: 'b', conversationId: 'C', author: 'A', text: 'b', at: '2026-02-01T00:00:00Z' },
    ]);
    expect(out.map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('resolveSlackConversation', () => {
  it('takes an id as given', async () => {
    expect(looksLikeChannelId('C0123ABCD')).toBe(true);
    expect(await resolveSlackConversation(slackClient(), 'C0123ABCD')).toEqual({ id: 'C0123ABCD' });
  });

  it('resolves a name, with or without the hash', async () => {
    expect((await resolveSlackConversation(slackClient(), '#engineering')).id).toBe('C0111AAAA');
    expect((await resolveSlackConversation(slackClient(), 'Engineering')).id).toBe('C0111AAAA');
  });

  it('says the bot needs an invite, and names what it can see', async () => {
    await expect(resolveSlackConversation(slackClient(), 'enginering'))
      .rejects.toThrow(/Invite it to the channel first/);
    await expect(resolveSlackConversation(slackClient(), 'enginering'))
      .rejects.toThrow(/engineering/);
  });

  it('stops paging rather than looping forever', async () => {
    let calls = 0;
    const client = slackClient({
      conversationsList: async () => {
        calls++;
        return { channels: [{ id: 'C0999ZZZZ', name: 'other' }], response_metadata: { next_cursor: 'more' } };
      },
    });
    await expect(resolveSlackConversation(client, 'missing')).rejects.toThrow(SlackReadError);
    expect(calls).toBe(10);
  });
});

describe('readSlackHistory', () => {
  it('returns named authors and readable text', async () => {
    const result = await readSlackHistory(slackClient(), { target: 'engineering', limit: 50 });
    expect(result.conversation.id).toBe('C0111AAAA');
    expect(result.messages[0].author).toBe('Ada');
    expect(result.messages[0].text).toBe('Ship on @U9?');
    expect(result.messages[1].author).toBe('Grace');
    expect(result.messages[1].replyCount).toBe(2);
  });

  it('passes the time window through as slack timestamps', async () => {
    let seen: Record<string, unknown> = {};
    const client = slackClient({
      conversationsHistory: async (args) => { seen = args; return { messages: [] }; },
    });
    await readSlackHistory(client, { target: 'C0111AAAA', limit: 10, after: '2025-09-04T15:33:20.000Z' });
    expect(seen.oldest).toBe('1757000000.000000');
    expect(seen.latest).toBeUndefined();
  });

  it('reads one thread when asked', async () => {
    const result = await readSlackHistory(slackClient(), {
      target: 'C0111AAAA', limit: 10, thread: '1757000000.000100',
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].threadId).toBe('1757000000.000100');
  });

  it('does not fail a transcript because one user lookup failed', async () => {
    const client = slackClient({ usersInfo: async () => { throw new Error('user_not_found'); } });
    const result = await readSlackHistory(client, { target: 'C0111AAAA', limit: 10 });
    expect(result.messages[0].author).toBe('U1');
  });
});

describe('searchSlackMessages', () => {
  it('adds slack\'s own modifiers to the query', async () => {
    let seen: Record<string, unknown> = {};
    const client = slackClient({
      searchMessages: async (args) => { seen = args; return { messages: { matches: [] } }; },
    });
    await searchSlackMessages(client, {
      query: 'ship date', limit: 5, target: '#eng', after: '2026-09-01T00:00:00Z',
    });
    expect(seen.query).toBe('ship date in:#eng after:2026-09-01');
  });

  it('refuses when the client cannot search', async () => {
    await expect(searchSlackMessages(slackClient(), { query: 'x', limit: 5 }))
      .rejects.toThrow(/cannot search/);
  });

  it('maps matches to the shared message shape', async () => {
    const client = slackClient({
      searchMessages: async () => ({
        messages: {
          matches: [{
            ts: '1757000000.000100', text: 'we ship <@U1>', username: 'grace',
            channel: { id: 'C0111AAAA', name: 'engineering' }, permalink: 'https://slack/x',
          }],
        },
      }),
    });
    const [message] = await searchSlackMessages(client, { query: 'ship', limit: 5 });
    expect(message).toMatchObject({
      conversationId: 'C0111AAAA', conversationName: 'engineering', author: 'grace', text: 'we ship @U1',
    });
  });
});

function graphClient(responses: Record<string, unknown>, posts: Record<string, unknown> = {}): GraphClient {
  return {
    get: async (path) => {
      // Longest prefix wins: `/teams/T1/channels/<id>/messages` must not be
      // answered by the `/teams/T1/channels` listing.
      const key = Object.keys(responses)
        .sort((a, b) => b.length - a.length)
        .find((k) => path.startsWith(k));
      if (!key) throw new Error(`unexpected GET ${path}`);
      return responses[key];
    },
    post: async (path) => {
      const key = Object.keys(posts).find((k) => path.startsWith(k));
      if (!key) throw new Error(`unexpected POST ${path}`);
      return posts[key];
    },
  };
}

const TEAMS_BASE = {
  '/me/joinedTeams': { value: [{ id: 'T1', displayName: 'Engineering' }] },
  '/teams/T1/channels': { value: [{ id: '19:abc@thread.tacv2', displayName: 'General' }] },
};

describe('resolveTeamsConversation', () => {
  it('resolves Team/Channel', async () => {
    const conversation = await resolveTeamsConversation(graphClient(TEAMS_BASE), 'Engineering/General');
    expect(conversation).toMatchObject({ kind: 'channel', teamId: 'T1', name: 'General' });
    expect(conversation.path).toBe('/teams/T1/channels/19:abc@thread.tacv2');
  });

  it('refuses a bare channel name instead of guessing a team', async () => {
    // The same channel name exists in many teams; picking one silently would
    // answer a question about the wrong General.
    await expect(resolveTeamsConversation(graphClient(TEAMS_BASE), 'General'))
      .rejects.toThrow(/Team\/Channel/);
  });

  it('names the teams and channels it can see when the name is wrong', async () => {
    await expect(resolveTeamsConversation(graphClient(TEAMS_BASE), 'Sales/General'))
      .rejects.toThrow(/Teams you are in: Engineering/);
    await expect(resolveTeamsConversation(graphClient(TEAMS_BASE), 'Engineering/Random'))
      .rejects.toThrow(/Channels: General/);
  });

  it('takes a chat id directly', async () => {
    const conversation = await resolveTeamsConversation(graphClient({}), '19:xyz@thread.v2');
    expect(conversation).toMatchObject({ kind: 'chat', path: '/chats/19:xyz@thread.v2' });
  });

  it('rejects an empty target', async () => {
    await expect(resolveTeamsConversation(graphClient({}), '  ')).rejects.toThrow(TeamsReadError);
  });
});

describe('readTeamsHistory', () => {
  const messages = {
    ...TEAMS_BASE,
    '/teams/T1/channels/19:abc@thread.tacv2/messages': {
      value: [
        {
          id: 'm2', createdDateTime: '2026-09-02T10:00:00Z',
          body: { contentType: 'html', content: '<p>We ship <b>Friday</b></p>' },
          from: { user: { id: 'u1', displayName: 'Ada' } },
        },
        {
          id: 'm1', createdDateTime: '2026-09-01T10:00:00Z',
          body: { contentType: 'text', content: 'kickoff' },
          from: { user: { id: 'u2', displayName: 'Grace' } },
        },
        { id: 'sys', messageType: 'systemEventMessage', body: { content: '' } },
      ],
    },
  };

  it('reads a channel as text, dropping system events', async () => {
    const result = await readTeamsHistory(graphClient(messages), { target: 'Engineering/General', limit: 50 });
    expect(result.messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(result.messages[0].text).toBe('We ship Friday');
    expect(result.messages[0].conversationName).toBe('Engineering/General');
  });

  it('applies the time window the Graph endpoint has no parameter for', async () => {
    const result = await readTeamsHistory(graphClient(messages), {
      target: 'Engineering/General', limit: 50, after: '2026-09-02T00:00:00Z',
    });
    expect(result.messages.map((m) => m.id)).toEqual(['m2']);
  });
});

describe('searchTeamsMessages', () => {
  it('flattens the search response', async () => {
    const graph = graphClient({}, {
      '/search/query': {
        value: [{
          hitsContainers: [{
            hits: [{
              resource: {
                id: 'm2', createdDateTime: '2026-09-02T10:00:00Z',
                body: { contentType: 'html', content: '<p>ship Friday</p>' },
                from: { user: { id: 'u1', displayName: 'Ada' } },
                channelIdentity: { channelId: '19:abc@thread.tacv2' },
              },
            }],
          }],
        }],
      },
    });
    const found = await searchTeamsMessages(graph, { query: 'ship', limit: 10 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ author: 'Ada', text: 'ship Friday', conversationId: '19:abc@thread.tacv2' });
  });

  it('returns nothing rather than throwing on an empty response', async () => {
    const graph = graphClient({}, { '/search/query': {} });
    expect(await searchTeamsMessages(graph, { query: 'x', limit: 10 })).toEqual([]);
  });
});
