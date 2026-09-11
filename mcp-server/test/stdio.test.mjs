import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('compiled stdio entrypoint initializes and calls the backend without an HTTP key', { timeout: 10000 }, async t => {
  let observedAuthorization;
  const backend = createServer((req, res) => {
    observedAuthorization = req.headers.authorization;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ fixture: 'stdio', path: req.url }));
  });
  await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); }));
  const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
  t.after(() => client.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: {
      OCTIPUS_URL: `http://127.0.0.1:${backend.address().port}`,
      OCTIPUS_API_KEY: 'stdio-backend-token',
    },
    stderr: 'pipe',
  });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'octipus_health'));
  const result = await client.callTool({ name: 'octipus_health', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { fixture: 'stdio', path: '/api/health/detailed' });
  assert.equal(observedAuthorization, 'Bearer stdio-backend-token');
});

test('run-scoped stdio exposes only parent tools and preserves tool errors', { timeout: 10000 }, async t => {
  const calls = [];
  const backend = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer run-capability');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/tools') {
      res.end(JSON.stringify({ tools: [{ name: 'update_work_plan', description: 'Scoped plan', inputSchema: { type: 'object' } }] }));
    } else {
      calls.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Revision conflict' }] }));
    }
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); }));
  const client = new Client({ name: 'agent-smoke', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { OCTIPUS_AGENT_URL: `http://127.0.0.1:${backend.address().port}`, OCTIPUS_AGENT_KEY: 'run-capability', OCTIPUS_API_KEY: 'must-not-be-used' }, stderr: 'pipe' }));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['update_work_plan']);
  assert.equal((await client.callTool({ name: 'update_work_plan', arguments: { revision: 3 } })).isError, true);
  assert.deepEqual(calls, [{ name: 'update_work_plan', arguments: { revision: 3 } }]);
});

for (const env of [
  { OCTIPUS_AGENT_URL: 'http://127.0.0.1:1' },
  { OCTIPUS_AGENT_KEY: 'key' },
  { OCTIPUS_AGENT_URL: 'http://example.com', OCTIPUS_AGENT_KEY: 'key' },
]) {
  test(`invalid run configuration fails initialization: ${JSON.stringify(env)}`, { timeout: 5000 }, async t => {
    const client = new Client({ name: 'invalid-agent', version: '1' });
    t.after(() => client.close());
    await assert.rejects(client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env, stderr: 'pipe' })));
  });
}
