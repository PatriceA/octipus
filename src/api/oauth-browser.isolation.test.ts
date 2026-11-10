/**
 * An OAuth connect (the Google and Microsoft 365 mailbox flow) is bound to
 * the browser that started it (`src/api/oauth-browser.ts`): the callback
 * refuses a request without the starting browser's cookie, or with someone
 * else's, before the code is redeemed; the same browser completes it.
 *
 * Driven through the real routes (`createServer()`). Backed by ephemeral
 * PGlite; the provider's token endpoint is a stand-in.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = randomUUID();
const bobId = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};

async function call(who: string, method: string, path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  if (cookie) headers.cookie = cookie;
  return app.handle(new Request(`http://localhost${path}`, { method, headers }));
}

/** Start a connect: the authorization URL's state and the browser cookie it set. */
async function started(res: Response): Promise<{ state: string; cookie: string }> {
  expect(res.status).toBe(200);
  const { url } = await res.json() as { url: string };
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(setCookie).toMatch(/^octipus_oauth_browser=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/api; Max-Age=600/);
  return { state: new URL(url).searchParams.get('state') as string, cookie: setCookie.split(';')[0] };
}

/** The provider's redirect back, as a browser with (or without) the cookie makes it. */
async function callback(state: string, cookie?: string): Promise<string> {
  const res = await app.handle(new Request(`http://localhost/api/auth/oauth/google/callback?code=the-code&state=${state}`, {
    headers: cookie ? { cookie } : {},
  }));
  return res.text();
}

const tokenResponse = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-oauth-browser-'));
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
  tokens.alice = (await getSessionManager().create(aliceId)).token;
  tokens.bob = (await getSessionManager().create(bobId)).token;
  // The install's Google OAuth client.
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

describe('a mailbox OAuth connect is bound to the browser that started it', () => {
  test('refused from no browser or another one, before the code is redeemed; stored from the same one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse({ access_token: 'alice-at', refresh_token: 'alice-rt', expires_in: 3600, token_type: 'bearer' }));
    try {
      const { getOAuthManager } = await import('@/security/oauth');

      // The URL handed to someone else: their browser has no cookie.
      const first = await started(await call('alice', 'GET', '/api/auth/oauth/google/authorize'));
      expect(await callback(first.state)).toMatch(/different browser/);
      // Someone else's cookie does not match either.
      const other = await started(await call('bob', 'GET', '/api/auth/oauth/google/authorize'));
      const second = await started(await call('alice', 'GET', '/api/auth/oauth/google/authorize'));
      expect(await callback(second.state, other.cookie)).toMatch(/different browser/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await getOAuthManager().getValidToken(aliceId, 'google')).toBeNull();

      // The starting browser (its cookie reused across flows).
      const third = await started(await call('alice', 'GET', '/api/auth/oauth/google/authorize', second.cookie));
      expect(third.cookie).toBe(second.cookie);
      expect(await callback(third.state, third.cookie)).toMatch(/Google Connected/);
      expect(String(fetchSpy.mock.calls[0]![1]?.body)).toContain('code_verifier=');
      expect(await getOAuthManager().getValidToken(aliceId, 'google')).toBe('alice-at');
      expect(await getOAuthManager().getValidToken(bobId, 'google')).toBeNull();
      // A state is single use.
      expect(await callback(third.state, third.cookie)).toMatch(/Invalid or expired OAuth state/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
