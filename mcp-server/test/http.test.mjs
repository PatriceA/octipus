import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createHttpBridge } from '../dist/http.js';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await setTimeout(10);
  }
  assert.ok(check(), 'condition did not settle');
}

test('HTTP transport requires an explicit key', () => {
  assert.throws(() => createHttpBridge({ backendUrl: 'http://localhost', apiKey: ' ', allowedOrigins: [] }), /MCP_API_KEY/);
});

test('real SDK sessions dispatch tools independently and enforce HTTP boundaries', { timeout: 20000 }, async t => {
  const previousKey = process.env.OCTIPUS_API_KEY;
  process.env.OCTIPUS_API_KEY = 'backend-test-token';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OCTIPUS_API_KEY;
    else process.env.OCTIPUS_API_KEY = previousKey;
  });
  const calls = [];
  const backend = createServer((req, res) => {
    calls.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    // Distinct payloads and completion order expose response cross-routing.
    const reply = () => res.end(JSON.stringify({ path: req.url }));
    if (req.url === '/api/health/detailed') setTimeout(25).then(reply);
    else reply();
  });
  const backendUrl = await listen(backend);
  t.after(() => new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); }));
  const bridge = createHttpBridge({ backendUrl, apiKey: 'transport-test-token', allowedOrigins: ['http://localhost:3007'] });
  const baseUrl = await listen(bridge.httpServer);
  let bridgeClosed = false;
  t.after(async () => { if (!bridgeClosed) await bridge.close(); });
  const headers = { Authorization: 'Bearer transport-test-token', 'Content-Type': 'application/json' };
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); });

  async function connect() {
    let endpoint;
    const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`), {
      fetch: (url, options) => {
        if (String(url).includes('/messages?')) endpoint = String(url);
        const authenticated = new Headers(options?.headers);
        authenticated.set('Authorization', headers.Authorization);
        return fetch(url, { ...options, headers: authenticated });
      },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    return { client, endpoint: () => endpoint };
  }
  const [first, second] = await Promise.all([connect(), connect()]);
  assert.equal(bridge.activeSessionCount, 2);
  const [list1, list2] = await Promise.all([first.client.listTools(), second.client.listTools()]);
  assert.ok(list1.tools.some(tool => tool.name === 'octipus_health'));
  assert.deepEqual(list1.tools.map(tool => tool.name), list2.tools.map(tool => tool.name));
  const [health, time] = await Promise.all([
    first.client.callTool({ name: 'octipus_health', arguments: {} }),
    second.client.callTool({ name: 'octipus_server_time', arguments: {} }),
  ]);
  assert.deepEqual(JSON.parse(health.content[0].text), { path: '/api/health/detailed' });
  assert.deepEqual(JSON.parse(time.content[0].text), { path: '/api/health/time' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.authorization === 'Bearer backend-test-token'));
  assert.notEqual(first.endpoint(), second.endpoint());

  for (const path of ['/sse', '/messages']) {
    const method = path === '/sse' ? 'GET' : 'POST';
    for (const authorization of ['', 'Bearer wrong-key']) {
      const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: authorization } });
      assert.equal(response.status, 401);
      await response.text();
    }
    const denied = await fetch(`${baseUrl}${path}`, { method, headers: { ...headers, Origin: 'https://untrusted.example' } });
    assert.equal(denied.status, 403);
    await denied.text();
  }
  const preflight = await fetch(`${baseUrl}/sse`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3007' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3007');
  const wrongMethod = await fetch(`${baseUrl}/sse`, { method: 'POST', headers });
  assert.equal(wrongMethod.status, 405);
  await wrongMethod.text();
  for (const path of ['/messages', '/messages?sessionId=missing']) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 400);
    await response.text();
  }
  for (const body of ['not json', '{}', JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024 + 1) })]) {
    const response = await fetch(first.endpoint(), { method: 'POST', headers, body });
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.equal(calls.length, 2, 'rejected requests must not call the backend');
  assert.ok((await first.client.listTools()).tools.length > 0, 'bad requests must not kill the session');
  const expiredEndpoint = first.endpoint();
  await first.client.close();
  await eventually(() => bridge.activeSessionCount === 1);
  const expired = await fetch(expiredEndpoint, { method: 'POST', headers, body: '{}' });
  assert.equal(expired.status, 400);
  await expired.text();
  assert.ok((await second.client.listTools()).tools.length > 0);
  await bridge.close();
  bridgeClosed = true;
  assert.equal(bridge.activeSessionCount, 0);
});
