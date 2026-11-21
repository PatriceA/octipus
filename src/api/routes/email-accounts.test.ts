/**
 * Mail requests that name one of several accounts of a provider
 * (core/email/account-context.ts): the provider call runs on that account's
 * token, the rows say which account they came from, an account the user has
 * not connected is refused before any provider is reached, and the default
 * account named explicitly is the default account.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

/** Alice's Google accounts: the default first. */
const ALICE = ['alice@home.example', 'alice@work.example'];
/** Which account each token request named (undefined: the default). */
const tokenRequests: Array<{ userId: string; provider: string; account?: string | null }> = [];
const fetched: Array<{ url: string; token: string }> = [];

vi.mock('@/security/oauth', async (original) => {
  const real = await original<typeof import('@/security/oauth')>();
  const owned = (userId: string) => (userId.endsWith('1') ? ALICE : []);
  return {
    ...real,
    getOAuthManager: () => ({
      getValidToken: async (userId: string, provider: string, account?: string | null) => {
        tokenRequests.push({ userId, provider, account });
        if (provider !== 'google') return null;
        const list = owned(userId);
        if (!account) return list.length ? `token:${list[0]}` : null;
        return list.includes(account) ? `token:${account}` : null;
      },
      accountRole: async (userId: string, provider: string, account: string) => {
        const list = provider === 'google' ? owned(userId) : [];
        const i = list.indexOf(account);
        return i < 0 ? null : i === 0 ? 'default' : 'other';
      },
      listAccounts: async (userId: string, provider: string) =>
        (provider === 'google' ? owned(userId) : []).map((account, i) => ({ provider, account, isDefault: i === 0 })),
    }),
  };
});
vi.mock('@/core/email/triage-labels', async (original) => ({
  ...(await original<typeof import('@/core/email/triage-labels')>()),
  storedTriage: async () => ({}),
}));

type App = { handle: (req: Request) => Promise<Response> };

async function buildApp(userId: string): Promise<App> {
  const { emailMailboxRoutes } = await import('./email-mailbox');
  const { emailRoutes } = await import('./email');
  const { principalFromUser } = await import('@/security/principal');
  const u = { id: userId, username: 'alice', isAdmin: false };
  return new Elysia()
    .derive(() => ({ user: u, session: null, principal: principalFromUser(u) }))
    .group('/api', (a) => a.use(emailRoutes).use(emailMailboxRoutes)) as unknown as App;
}
const ALICE_ID = '00000000-0000-4000-8000-000000000001';
const BOB_ID = '00000000-0000-4000-8000-000000000002';

async function get(app: App, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  tokenRequests.length = 0;
  fetched.length = 0;
  vi.restoreAllMocks();
  // The provider: a Gmail list of one message, then its metadata; the token says which mailbox it is.
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const token = String(new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
    fetched.push({ url, token });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/batch/')) return new Response('', { status: 500 });
    if (url.includes('/labels/INBOX')) return json({ messagesUnread: 0 });
    if (/\/messages\?/.test(url)) return json({ messages: [{ id: `m-${token}` }] });
    if (/\/messages\/[^/?]+\?format=metadata/.test(url)) {
      return json({ id: `m-${token}`, threadId: 't', labelIds: ['INBOX'], snippet: 's', internalDate: '0', payload: { headers: [{ name: 'Subject', value: `from ${token}` }, { name: 'From', value: 'x@y.org' }] } });
    }
    return json({});
  }) as typeof fetch);
});

describe('a mail request names one of the user\'s accounts', () => {
  test('without an account: the default, rows unmarked', async () => {
    const res = await get(await buildApp(ALICE_ID), '/api/email/messages?provider=google&folder=inbox&refresh=true');
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string; account?: string }>;
    expect(items.map((it) => it.id)).toEqual(['m-token:alice@home.example']);
    expect(items[0].account).toBeUndefined();
    expect(new Set(fetched.map((f) => f.token))).toEqual(new Set(['token:alice@home.example']));
  });

  test('another account: its own token, rows marked with it, kept apart in the page memory', async () => {
    const app = await buildApp(ALICE_ID);
    const res = await get(app, '/api/email/messages?provider=google&account=Alice@Work.example&folder=inbox');
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string; account?: string }>;
    expect(items).toMatchObject([{ id: 'm-token:alice@work.example', account: 'alice@work.example' }]);
    expect(new Set(fetched.map((f) => f.token))).toEqual(new Set(['token:alice@work.example']));
    // The default account's page is not the other account's page from memory.
    const again = await get(app, '/api/email/messages?provider=google&folder=inbox');
    expect((again.body.items as Array<{ id: string }>).map((it) => it.id)).toEqual(['m-token:alice@home.example']);
  });

  test('the default account named explicitly is the default account', async () => {
    const res = await get(await buildApp(ALICE_ID), '/api/email/messages?provider=google&account=alice@home.example&folder=inbox&refresh=true');
    expect((res.body.items as Array<{ account?: string }>)[0].account).toBeUndefined();
    expect(tokenRequests.every((r) => !r.account)).toBe(true);
  });

  test('an account the user has not connected is refused before any provider call', async () => {
    const res = await get(await buildApp(BOB_ID), '/api/email/messages?provider=google&account=alice@work.example&folder=inbox');
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not one of your connected Google accounts/);
    expect(fetched).toEqual([]);
    expect(tokenRequests).toEqual([]);
    const bad = await get(await buildApp(ALICE_ID), '/api/email/messages?account=alice@work.example&folder=inbox');
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/together with its provider/);
    const notAddress = await get(await buildApp(ALICE_ID), '/api/email/messages?provider=google&account=nope&folder=inbox');
    expect(notAddress.status).toBe(400);
  });

  test('the older routes take the account too (a thread read on the chosen account)', async () => {
    await get(await buildApp(ALICE_ID), '/api/email/message/m1?provider=google&account=alice@work.example');
    expect(fetched.length).toBeGreaterThan(0);
    expect(new Set(fetched.map((f) => f.token))).toEqual(new Set(['token:alice@work.example']));
  });

  test('accounts lists each account, the default first', async () => {
    const res = await get(await buildApp(ALICE_ID), '/api/email/accounts');
    expect(res.body).toEqual({ accounts: [
      { provider: 'google', address: 'alice@home.example', isDefault: true },
      { provider: 'google', address: 'alice@work.example', isDefault: false },
    ] });
  });
});

describe('outside a request', () => {
  test('no account is in scope: the default account, and the bare mailbox key', async () => {
    const { mailboxKey, selectedAccount, inMailbox } = await import('@/core/email/account-context');
    expect(selectedAccount('google')).toBeUndefined();
    expect(mailboxKey('google')).toBe('google');
    // In scope across awaits, and only for its own provider.
    const seen = await inMailbox({ provider: 'google', account: 'alice@work.example' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return [selectedAccount('google'), selectedAccount('microsoft'), mailboxKey('google'), mailboxKey('microsoft')];
    });
    expect(seen).toEqual(['alice@work.example', undefined, 'google:alice@work.example', 'microsoft']);
    expect(selectedAccount('google')).toBeUndefined();
  });
});
