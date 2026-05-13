import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { fixtures, BASE_URL } from '../fixtures';

/**
 * Register/login through a raw fetch so we can read the Set-Cookie header.
 * The server hands out a `session_token` cookie; the same string works as
 * a Bearer token (see auth code in src/api/server.ts which accepts either
 * `Authorization: Bearer <token>` or the cookie).
 */
async function authenticateAsUser(username: string, password: string): Promise<{ token: string; userId: string } | null> {
  // Try login first — the persistent test user usually already exists, and
  // hammering /auth/register on every run trips the registration rate-limit.
  for (const endpoint of ['/auth/login', '/auth/register']) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) continue;

    // Token may be in the body (legacy) OR in the session_token cookie (current).
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    let token = (body as { token?: string }).token || null;
    if (!token) {
      const setCookie = res.headers.get('set-cookie') || '';
      const match = setCookie.match(/session_token=([^;]+)/);
      if (match) token = match[1];
    }
    const userId = (body as { user?: { id?: string }; id?: string }).user?.id
      || (body as { id?: string }).id
      || '';
    if (token) return { token, userId };
  }
  return null;
}

export async function testAuth(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mAuthentication\x1b[0m');

  if (fixtures.usingMasterKey) {
    console.log('  \x1b[33m⊘ Using MASTER_KEY auth — skipping register/login tests\x1b[0m');

    await runner.test('GET /auth/me returns admin user via MASTER_KEY', async () => {
      const { status, data } = await client.request<{ username: string; isAdmin: boolean }>('GET', '/auth/me');
      assertStatus(status, 200);
      assert(!!data.username, 'Expected a username');
      assert(data.isAdmin === true, 'MASTER_KEY user should be admin');
    });

    await runner.test('Unauthenticated request to protected endpoint fails', async () => {
      const { status, data } = await client.request<{ error?: string }>('GET', '/sessions', undefined, '');
      assert(status === 401 || !!(data as any).error, 'Expected 401 or error for unauthenticated request');
    });

    return;
  }

  await runner.test('POST /auth/register creates test user', async () => {
    const result = await authenticateAsUser(fixtures.testUsername, fixtures.testPassword);
    assert(!!result, 'register/login failed — no token in body or session_token cookie');
    fixtures.authToken = result!.token;
    fixtures.testUserId = result!.userId;
  });

  await runner.test('POST /auth/login with correct credentials', async () => {
    const result = await authenticateAsUser(fixtures.testUsername, fixtures.testPassword);
    assert(!!result, 'login failed — no token in body or session_token cookie');
    fixtures.authToken = result!.token;
  });

  await runner.test('POST /auth/login with wrong password fails', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'POST', '/auth/login', { username: fixtures.testUsername, password: 'wrongpassword' }, '',
    );
    assert(status === 200 || status === 401, `Unexpected status ${status}`);
    assert(!!(data as any).error, 'Expected error response');
  });

  await runner.test('GET /auth/me returns current user', async () => {
    const { status, data } = await client.request<{ username: string }>('GET', '/auth/me');
    assertStatus(status, 200);
    assert(data.username === fixtures.testUsername, `Expected username ${fixtures.testUsername}, got ${data.username}`);
  });

  await runner.test('Unauthenticated request to protected endpoint fails', async () => {
    const { status, data } = await client.request<{ error?: string }>('GET', '/sessions', undefined, '');
    assert(status === 401 || !!(data as any).error, 'Expected 401 or error for unauthenticated request');
  });
}
