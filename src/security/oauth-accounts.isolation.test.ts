/**
 * Several accounts of one provider (two Gmail accounts): connecting a further
 * one, choosing it, making it the default, disconnecting one. Driven through
 * the real routes (`createServer()`) on ephemeral PGlite; the provider's
 * token and userinfo endpoints are stand-ins.
 *
 * What must hold: the browser binding applies to "add another account" as to
 * any connect; an account is only ever its own user's; a request without an
 * account gets the default, so agents and the heartbeat see what they always
 * saw; a refresh keeps which account an entry is and whether it is the default.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { normalizeAccount, orderAccounts, pickAccount } from './oauth';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

describe('account selection (pure)', () => {
  const entry = (id: string, createdAt: number, oauthConfig: Record<string, unknown>) => ({ id, createdAt: new Date(createdAt), metadata: { oauthConfig: { provider: 'google', scopes: [], ...oauthConfig } } });

  test('the marked default first, else the one connected first; other providers left out', () => {
    const first = entry('1', 1, {});
    const later = entry('2', 2, { account: 'b@x.org' });
    const outlook = { ...entry('3', 0, {}), metadata: { oauthConfig: { provider: 'microsoft', scopes: [] } } };
    expect(orderAccounts([later, outlook, first], 'google').map(e => e.id)).toEqual(['1', '2']);
    const chosen = entry('2', 2, { account: 'b@x.org', isDefault: true });
    const unchosen = entry('1', 1, { isDefault: false });
    expect(orderAccounts([unchosen, chosen], 'google').map(e => e.id)).toEqual(['2', '1']);
  });

  test('a named account is that account or nothing; no name is the default', () => {
    const ordered = [entry('1', 1, { account: 'a@x.org' }), entry('2', 2, { account: 'b@x.org' })];
    expect(pickAccount(ordered)?.id).toBe('1');
    expect(pickAccount(ordered, ' B@X.org ')?.id).toBe('2');
    expect(pickAccount(ordered, 'c@x.org')).toBeNull();
    expect(pickAccount(ordered, 'not an address')).toBeNull();
    expect(pickAccount([], undefined)).toBeNull();
    expect(normalizeAccount('Me@Example.COM')).toBe('me@example.com');
    expect(normalizeAccount('two words@x.org')).toBeNull();
  });
});

const aliceId = randomUUID();
const bobId = randomUUID();

type App = { handle(request: Request, options?: { socketAddress?: string }): Promise<Response> };
let app: App;
const sessions: Record<string, string> = {};

/** The stand-in Google: which code yields which tokens, and which token belongs to which address. */
const codes: Record<string, { access_token: string; refresh_token?: string; expires_in: number; scope?: string }> = {};
const addressOf: Record<string, string | null> = {};
let refreshes = 0;

function fakeGoogle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (form.get('grant_type') === 'refresh_token') {
      refreshes++;
      return json({ access_token: `${form.get('refresh_token')}-refreshed`, expires_in: 3600, token_type: 'bearer' });
    }
    const tokens = codes[form.get('code') ?? ''];
    return tokens ? json({ ...tokens, token_type: 'bearer' }) : json({ error: 'invalid_grant' }, 400);
  }
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
    const token = String(new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
    const email = addressOf[token];
    return email ? json({ email }) : json({ error: 'unknown' }, 401);
  }
  if (url.startsWith('https://oauth2.googleapis.com/revoke')) return Promise.resolve(new Response('', { status: 200 }));
  return Promise.reject(new Error(`unexpected request in test: ${url}`));
}

/** Each request from its own address: the auth endpoints allow 20 a minute per address, and this test makes more. */
let addresses = 0;
const from = () => ({ socketAddress: `10.9.${(++addresses >> 8) & 255}.${addresses & 255}` });

async function call(who: string, method: string, path: string, options: { cookie?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${sessions[who]}` };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), from());
}

let cookie = '';
/** One whole connect from Alice's browser: authorize (add another, or not), then the provider's redirect back. */
async function connect(code: string, opts: { addAccount?: boolean; as?: string; fromCookie?: string } = {}): Promise<{ page: string; url: string }> {
  const who = opts.as ?? 'alice';
  const res = await call(who, 'GET', `/api/auth/oauth/google/authorize${opts.addAccount ? '?addAccount=true' : ''}`, { cookie: cookie || undefined });
  expect(res.status).toBe(200);
  const { url } = await res.json() as { url: string };
  const set = res.headers.get('set-cookie');
  if (set && who === 'alice') cookie = set.split(';')[0];
  const state = new URL(url).searchParams.get('state') as string;
  const back = await app.handle(new Request(`http://localhost/api/auth/oauth/google/callback?code=${code}&state=${state}`, {
    headers: (opts.fromCookie ?? (who === 'alice' ? cookie : set?.split(';')[0])) ? { cookie: opts.fromCookie ?? (who === 'alice' ? cookie : set!.split(';')[0]) } : {},
  }), from());
  return { page: await back.text(), url };
}

const accounts = async (who = 'alice') => {
  const body = (await (await call(who, 'GET', '/api/auth/oauth/google/accounts')).json()) as { provider: string; accounts: Array<{ account?: string; isDefault: boolean }> };
  expect(body.provider).toBe('google');
  return { accounts: body.accounts };
};

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-oauth-accounts-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { initializeVault, getVault } = await import('@/security/vault');
  await initializeVault();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }, { id: bobId, username: 'bob' }]);
  const { getSessionManager } = await import('@/security/auth/session');
  sessions.alice = (await getSessionManager().create(aliceId)).token;
  sessions.bob = (await getSessionManager().create(bobId)).token;
  const { OAUTH_VAULT_NAMES } = await import('@/security/oauth');
  await getVault().setSystemSecret(OAUTH_VAULT_NAMES.google.clientId, 'google-client-id');
  await getVault().setSystemSecret(OAUTH_VAULT_NAMES.google.clientSecret, 'google-client-secret');
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('several accounts of one provider', () => {
  test('connect, add another, choose, make default, disconnect one, disconnect all', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeGoogle as typeof fetch);
    try {
      const { getOAuthManager } = await import('@/security/oauth');
      const oauth = getOAuthManager();

      // The first connect: the default account, its address kept.
      codes.c1 = { access_token: 'home-at', refresh_token: 'home-rt', expires_in: 3600 };
      addressOf['home-at'] = 'Alice@Home.example';
      expect((await connect('c1')).page).toMatch(/Google Connected/);
      expect(await accounts()).toEqual({ accounts: [{ account: 'alice@home.example', isDefault: true }] });

      // "Add another account": asks the person to pick an account; a second entry next to the first.
      codes.c2 = { access_token: 'work-at', refresh_token: 'work-rt', expires_in: 3600 };
      addressOf['work-at'] = 'alice@work.example';
      const added = await connect('c2', { addAccount: true });
      expect(added.page).toMatch(/Google Connected/);
      expect(new URL(added.url).searchParams.get('prompt')).toBe('select_account consent');
      expect(await accounts()).toEqual({ accounts: [{ account: 'alice@home.example', isDefault: true }, { account: 'alice@work.example', isDefault: false }] });

      // Without an account: the default, exactly as agents and the heartbeat ask. With one: that one, any case.
      expect(await oauth.getValidToken(aliceId, 'google')).toBe('home-at');
      expect(await oauth.getValidToken(aliceId, 'google', 'ALICE@work.example')).toBe('work-at');
      expect(await oauth.getValidToken(aliceId, 'google', 'nobody@work.example')).toBeNull();
      expect(await oauth.accountRole(aliceId, 'google', 'alice@work.example')).toBe('other');
      expect(await oauth.accountRole(aliceId, 'google', 'alice@home.example')).toBe('default');
      // Another user can never reach Alice's accounts, named or not.
      expect(await oauth.getValidToken(bobId, 'google', 'alice@work.example')).toBeNull();
      expect(await oauth.getValidToken(bobId, 'google')).toBeNull();
      expect(await oauth.accountRole(bobId, 'google', 'alice@work.example')).toBeNull();
      expect(await accounts('bob')).toEqual({ accounts: [] });
      expect((await call('bob', 'POST', '/api/auth/oauth/google/accounts/default', { body: { account: 'alice@work.example' } })).status).toBe(404);
      expect((await call('bob', 'POST', '/api/auth/oauth/google/disconnect', { body: { account: 'alice@work.example' } })).status).toBe(404);
      expect(await oauth.getValidToken(aliceId, 'google', 'alice@work.example')).toBe('work-at');

      // The same account added again updates its entry: never a second copy.
      codes.c3 = { access_token: 'work-at-2', refresh_token: 'work-rt-2', expires_in: 3600 };
      addressOf['work-at-2'] = 'alice@work.example';
      expect((await connect('c3', { addAccount: true })).page).toMatch(/Google Connected/);
      expect((await accounts()).accounts).toHaveLength(2);
      expect(await oauth.getValidToken(aliceId, 'google', 'alice@work.example')).toBe('work-at-2');

      // An added account the provider does not name cannot be told apart: refused, nothing stored.
      codes.c4 = { access_token: 'mystery-at', expires_in: 3600 };
      addressOf['mystery-at'] = null;
      expect((await connect('c4', { addAccount: true })).page).toMatch(/did not say which account/);
      expect((await accounts()).accounts).toHaveLength(2);

      // "Add another account" is bound to the starting browser like every connect: from no browser, refused before the code is used.
      codes.c5 = { access_token: 'stolen-at', expires_in: 3600 };
      addressOf['stolen-at'] = 'mallory@evil.example';
      const before = fetchSpy.mock.calls.length;
      const stolen = await call('alice', 'GET', '/api/auth/oauth/google/authorize?addAccount=true', { cookie });
      const state = new URL(((await stolen.json()) as { url: string }).url).searchParams.get('state');
      const page = await (await app.handle(new Request(`http://localhost/api/auth/oauth/google/callback?code=c5&state=${state}`), from())).text();
      expect(page).toMatch(/different browser/);
      expect(fetchSpy.mock.calls.length).toBe(before);
      expect((await accounts()).accounts).toHaveLength(2);

      // The default can change; requests without an account follow it.
      expect((await call('alice', 'POST', '/api/auth/oauth/google/accounts/default', { body: { account: 'alice@work.example' } })).status).toBe(200);
      expect(await accounts()).toEqual({ accounts: [{ account: 'alice@work.example', isDefault: true }, { account: 'alice@home.example', isDefault: false }] });
      expect(await oauth.getValidToken(aliceId, 'google')).toBe('work-at-2');
      expect((await (await call('alice', 'GET', '/api/auth/oauth/google/status')).json())).toMatchObject({ connected: true, email: 'alice@work.example', accounts: 2 });

      // A refresh keeps which account an entry is and whether it is the default.
      codes.c6 = { access_token: 'home-at-old', refresh_token: 'home-rt-2', expires_in: 1, scope: 'openid granted.then' };
      addressOf['home-at-old'] = 'alice@home.example';
      expect((await connect('c6', { addAccount: true })).page).toMatch(/Google Connected/);
      expect(await oauth.getValidToken(aliceId, 'google', 'alice@home.example')).toBe('home-rt-2-refreshed');
      expect(refreshes).toBe(1);
      // The refresh answer names no scopes: the grant stays what it was, not
      // what the provider config asks for today.
      const { getDb } = await import('@/db/postgres');
      const { vault } = await import('@/db/schema/vault');
      const stored = (await getDb().select({ metadata: vault.metadata }).from(vault))
        .map((row) => (row.metadata as { oauthConfig?: { account?: string; scopes?: string[] } } | null)?.oauthConfig)
        .find((config) => config?.account === 'alice@home.example');
      expect(stored?.scopes).toEqual(['openid', 'granted.then']);
      expect(await accounts()).toEqual({ accounts: [{ account: 'alice@work.example', isDefault: true }, { account: 'alice@home.example', isDefault: false }] });

      // Disconnecting the default: the other account becomes it.
      expect((await call('alice', 'POST', '/api/auth/oauth/google/disconnect', { body: { account: 'alice@work.example' } })).status).toBe(200);
      expect(await accounts()).toEqual({ accounts: [{ account: 'alice@home.example', isDefault: true }] });
      expect(await oauth.getValidToken(aliceId, 'google')).toBe('home-rt-2-refreshed');

      // Disconnecting the provider without naming an account removes every account of it.
      codes.c7 = { access_token: 'third-at', expires_in: 3600 };
      addressOf['third-at'] = 'alice@third.example';
      await connect('c7', { addAccount: true });
      expect((await accounts()).accounts).toHaveLength(2);
      expect((await call('alice', 'POST', '/api/auth/oauth/google/disconnect')).status).toBe(200);
      expect(await accounts()).toEqual({ accounts: [] });
      expect(await oauth.getValidToken(aliceId, 'google')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('reconnecting as another account is refused; data keyed to the default follows a default change, both ways', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeGoogle as typeof fetch);
    try {
      const { getDb } = await import('@/db/postgres');
      const { emailTriageLabels } = await import('@/db/schema/email-triage-labels');
      const { emailSnoozes } = await import('@/db/schema/email-snoozes');
      const { users } = await import('@/db/schema/users');
      const { and, eq } = await import('drizzle-orm');
      const db = getDb();
      codes.d1 = { access_token: 'one-at', refresh_token: 'one-rt', expires_in: 3600 };
      addressOf['one-at'] = 'bob@one.example';
      expect((await connect('d1', { as: 'bob' })).page).toMatch(/Google Connected/);

      // Reconnect (not "add") but signed in as someone else: refused, the connection unchanged.
      codes.d2 = { access_token: 'two-at', refresh_token: 'two-rt', expires_in: 3600 };
      addressOf['two-at'] = 'bob@two.example';
      expect((await connect('d2', { as: 'bob' })).page).toMatch(/Add another account/);
      expect(await accounts('bob')).toEqual({ accounts: [{ account: 'bob@one.example', isDefault: true }] });
      const { getOAuthManager } = await import('@/security/oauth');
      expect(await getOAuthManager().getValidToken(bobId, 'google')).toBe('one-at');
      // The same account again is an ordinary reconnect.
      codes.d3 = { access_token: 'one-at-2', refresh_token: 'one-rt-2', expires_in: 3600 };
      addressOf['one-at-2'] = 'bob@one.example';
      expect((await connect('d3', { as: 'bob' })).page).toMatch(/Google Connected/);
      expect(await getOAuthManager().getValidToken(bobId, 'google')).toBe('one-at-2');
      expect((await connect('d2', { as: 'bob', addAccount: true })).page).toMatch(/Google Connected/);

      // Data of each account, keyed the way it is while bob@one is the default.
      const label = (key: string, messageId: string) => ({ userId: bobId, provider: key, messageId, fromEmail: 'x@y.z', subject: 's', snippet: '' });
      await db.insert(emailTriageLabels).values([label('google', 'm-one'), label('google:bob@two.example', 'm-two'), label('imap:acc1', 'm-imap')]);
      await db.insert(emailSnoozes).values({ userId: bobId, provider: 'google', account: null, messageIds: ['m-one'], fromEmail: 'x@y.z', subject: 's', snippet: '', wakeAt: new Date(Date.now() + 3_600_000) });
      await db.update(users).set({ preferences: { calendar: { visible: ['google:bob@one.example', 'google:bob@two.example:bob@two.example', 'microsoft:cal-1'] } } }).where(eq(users.id, bobId));
      const keys = async () => (await db.select().from(emailTriageLabels).where(eq(emailTriageLabels.userId, bobId))).map((r) => `${r.provider} ${r.messageId}`).sort();
      const visible = async () => (await db.select().from(users).where(eq(users.id, bobId)))[0].preferences?.calendar?.visible;

      expect((await call('bob', 'POST', '/api/auth/oauth/google/accounts/default', { body: { account: 'bob@two.example' } })).status).toBe(200);
      expect(await keys()).toEqual(['google m-two', 'google:bob@one.example m-one', 'imap:acc1 m-imap']);
      expect((await db.select().from(emailSnoozes).where(and(eq(emailSnoozes.userId, bobId))))[0].account).toBe('bob@one.example');
      expect(await visible()).toEqual(['google:bob@one.example:bob@one.example', 'google:bob@two.example', 'microsoft:cal-1']);

      // The default disconnected: the remaining account takes its place, and its data its bare keys again.
      expect((await call('bob', 'POST', '/api/auth/oauth/google/disconnect', { body: { account: 'bob@two.example' } })).status).toBe(200);
      expect(await keys()).toEqual(['google m-one', 'google:bob@two.example m-two', 'imap:acc1 m-imap']);
      expect(await visible()).toEqual(['google:bob@one.example', 'google:bob@two.example:bob@two.example', 'microsoft:cal-1']);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
