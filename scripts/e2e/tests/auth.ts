import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';

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
    const { status, data } = await client.request<{ token: string; user: { id: string } }>(
      'POST', '/auth/register', { username: fixtures.testUsername, password: fixtures.testPassword }, '',
    );
    if (status === 200) {
      assert(!!data.token, 'No token returned');
      assert(!!data.user?.id, 'No user ID returned');
      fixtures.authToken = data.token;
      fixtures.testUserId = data.user.id;
    } else {
      // User already exists from a parallel runner — login instead
      const login = await client.request<{ token: string; user: { id: string } }>(
        'POST', '/auth/login', { username: fixtures.testUsername, password: fixtures.testPassword }, '',
      );
      assertStatus(login.status, 200);
      assert(!!login.data.token, 'No token returned from login fallback');
      fixtures.authToken = login.data.token;
      fixtures.testUserId = login.data.user?.id || '';
    }
  });

  await runner.test('POST /auth/login with correct credentials', async () => {
    const { status, data } = await client.request<{ token: string }>(
      'POST', '/auth/login', { username: fixtures.testUsername, password: fixtures.testPassword }, '',
    );
    assertStatus(status, 200);
    assert(!!data.token, 'No token returned');
    fixtures.authToken = data.token;
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
