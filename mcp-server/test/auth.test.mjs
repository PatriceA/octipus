import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { AuthSession } from '../dist/auth.js';
import { OctiClient } from '../dist/client.js';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const authEnvKeys = ['OCTIPUS_API_KEY', 'OCTIPUS_USER', 'OCTIPUS_PASSWORD'];

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const key of authEnvKeys) delete process.env[key];
});

function loginResponse(token, expiresAt = new Date(Date.now() + 120_000).toISOString()) {
  return new Response(JSON.stringify({ token, expiresAt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('API key takes precedence without attempting credential login', async () => {
  globalThis.fetch = async () => { throw new Error('fetch must not be called'); };
  const auth = new AuthSession({ apiKey: 'octi_api', username: 'alice', password: 'secret' });
  assert.deepEqual(await auth.getHeaders('http://octipus.test'), {
    Authorization: 'Bearer octi_api',
  });
  assert.equal(auth.canRefresh, false);
});

test('credential login uses login-mobile, sends a device name, and caches the token', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return loginResponse('session-one');
  };
  const auth = new AuthSession({ username: 'alice', password: 'secret' });

  const first = await auth.getHeaders('http://octipus.test');
  const second = await auth.getHeaders('http://octipus.test');

  assert.deepEqual(first, { Authorization: 'Bearer session-one' });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://octipus.test/api/auth/login-mobile');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    username: 'alice',
    password: 'secret',
    deviceName: 'Octipus MCP server',
  });
});

test('concurrent requests share one credential login', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await gate;
    return loginResponse('shared-session');
  };
  const auth = new AuthSession({ username: 'alice', password: 'secret' });
  const pending = Promise.all([
    auth.getHeaders('http://octipus.test'),
    auth.getHeaders('http://octipus.test'),
  ]);
  release();
  const headers = await pending;
  assert.equal(calls, 1);
  assert.deepEqual(headers[0], headers[1]);
});

test('separate auth clients and backends do not share credentials or cached sessions', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), username: body.username });
    return loginResponse(`session-${body.username}`);
  };
  const first = new AuthSession({ username: 'alice', password: 'secret' });
  const second = new AuthSession({ username: 'bob', password: 'different-secret' });

  assert.equal((await first.getHeaders('http://one.test')).Authorization, 'Bearer session-alice');
  assert.equal((await second.getHeaders('http://two.test')).Authorization, 'Bearer session-bob');
  assert.deepEqual(calls, [
    { url: 'http://one.test/api/auth/login-mobile', username: 'alice' },
    { url: 'http://two.test/api/auth/login-mobile', username: 'bob' },
  ]);
});

test('partial credential configuration fails before making a request', async () => {
  globalThis.fetch = async () => { throw new Error('fetch must not be called'); };
  await assert.rejects(
    new AuthSession({ username: 'alice' }).getHeaders('http://octipus.test'),
    /Both OCTIPUS_USER and OCTIPUS_PASSWORD are required/,
  );
});

test('login rejects missing and expired server expiry values', async () => {
  const responses = [
    { token: 'missing-expiry' },
    { token: 'expired', expiresAt: new Date(Date.now() - 1).toISOString() },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const auth = new AuthSession({ username: 'alice', password: 'secret' });
  await assert.rejects(auth.getHeaders('http://octipus.test'), /missing expiresAt/);
  await assert.rejects(auth.getHeaders('http://octipus.test'), /invalid or expired expiresAt/);
});

test('server-provided expiry controls when credentials are refreshed', async () => {
  let now = 1_800_000_000_000;
  Date.now = () => now;
  let calls = 0;
  globalThis.fetch = async () => loginResponse(`session-${++calls}`, new Date(now + 10_000).toISOString());
  const auth = new AuthSession({ username: 'alice', password: 'secret' });

  assert.equal((await auth.getHeaders('http://octipus.test')).Authorization, 'Bearer session-1');
  now += 4_999;
  assert.equal((await auth.getHeaders('http://octipus.test')).Authorization, 'Bearer session-1');
  now += 2;
  assert.equal((await auth.getHeaders('http://octipus.test')).Authorization, 'Bearer session-2');
  assert.equal(calls, 2);
});

test('OctiClient retries one 401 after refreshing a credential session', async () => {
  process.env.OCTIPUS_USER = 'alice';
  process.env.OCTIPUS_PASSWORD = 'secret';
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.Authorization });
    if (String(url).endsWith('/login-mobile')) {
      const loginNumber = calls.filter((call) => call.url.endsWith('/login-mobile')).length;
      return loginResponse(`session-${loginNumber}`);
    }
    const apiNumber = calls.filter((call) => call.url.endsWith('/api/experts')).length;
    return apiNumber === 1
      ? new Response('expired', { status: 401 })
      : new Response(JSON.stringify({ experts: [] }), { status: 200 });
  };

  assert.deepEqual(await new OctiClient('http://octipus.test').listExperts(), []);
  assert.deepEqual(calls.map((call) => call.authorization), [
    undefined,
    'Bearer session-1',
    undefined,
    'Bearer session-2',
  ]);
});

test('OctiClient stops after one credential retry when the second response is 401', async () => {
  process.env.OCTIPUS_USER = 'alice';
  process.env.OCTIPUS_PASSWORD = 'secret';
  let loginCalls = 0;
  let apiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/login-mobile')) {
      return loginResponse(`session-${++loginCalls}`);
    }
    apiCalls++;
    return new Response('still unauthorized', { status: 401 });
  };

  await assert.rejects(
    new OctiClient('http://octipus.test').listExperts(),
    /failed: 401 still unauthorized/,
  );
  assert.equal(loginCalls, 2);
  assert.equal(apiCalls, 2);
});

test('concurrent 401 responses share one refresh and keep the newer token', async () => {
  process.env.OCTIPUS_USER = 'alice';
  process.env.OCTIPUS_PASSWORD = 'secret';
  let loginCalls = 0;
  let oldTokenCalls = 0;
  let releaseOldResponses;
  const oldResponsesReady = new Promise((resolve) => { releaseOldResponses = resolve; });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/login-mobile')) {
      return loginResponse(`session-${++loginCalls}`);
    }
    if (init.headers?.Authorization === 'Bearer session-1') {
      oldTokenCalls++;
      if (oldTokenCalls === 2) releaseOldResponses();
      await oldResponsesReady;
      return new Response('expired', { status: 401 });
    }
    assert.equal(init.headers?.Authorization, 'Bearer session-2');
    return new Response(JSON.stringify({ experts: [] }), { status: 200 });
  };
  const client = new OctiClient('http://octipus.test');

  assert.deepEqual(await Promise.all([client.listExperts(), client.listExperts()]), [[], []]);
  assert.equal(loginCalls, 2);
  assert.equal(oldTokenCalls, 2);
});

test('OctiClient does not retry a rejected API key', async () => {
  process.env.OCTIPUS_API_KEY = 'octi_bad';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('unauthorized', { status: 401 });
  };

  await assert.rejects(
    new OctiClient('http://octipus.test').listExperts(),
    /failed: 401 unauthorized/,
  );
  assert.equal(calls, 1);
});

test('login failures do not include submitted credentials', async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'bad password secret-value' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
  const auth = new AuthSession({ username: 'alice', password: 'secret-value' });
  await assert.rejects(
    auth.getHeaders('http://octipus.test'),
    (error) => error instanceof Error && error.message === 'Login failed: 401',
  );
});
