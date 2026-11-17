import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseToolset, rankTools } from '../dist/compact.js';

async function backend(t) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    // No modules or capabilities on: their tools stay hidden.
    if (req.url === '/api/modules') return res.end(JSON.stringify({ enabled: [], capabilities: [{ id: 'embedding', on: false }] }));
    res.end(JSON.stringify({ fixture: 'compact', path: req.url }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function connect(t, url, extra = {}) {
  const client = new Client({ name: 'compact-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), ...(extra.args ?? [])],
    env: { OCTIPUS_URL: url, OCTIPUS_API_KEY: 'token', ...(extra.env ?? {}) },
    stderr: 'pipe',
  }));
  return client;
}

const json = result => JSON.parse(result.content[0].text);

test('compact toolset lists three tools that search, describe and call the full set', { timeout: 15000 }, async t => {
  const client = await connect(t, await backend(t), { args: ['--toolset', 'compact'] });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
    ['octipus_call_tool', 'octipus_describe_tool', 'octipus_search_tools']);

  const found = json(await client.callTool({ name: 'octipus_search_tools', arguments: { query: 'health status' } }));
  assert.ok(found.tools.some(tool => tool.name === 'octipus_health'));
  assert.ok(found.available > 50);

  const described = json(await client.callTool({ name: 'octipus_describe_tool', arguments: { name: 'octipus_health' } }));
  assert.equal(described.name, 'octipus_health');
  assert.equal(described.inputSchema.type, 'object');

  const called = await client.callTool({ name: 'octipus_call_tool', arguments: { name: 'octipus_health', arguments: {} } });
  assert.notEqual(called.isError, true);
  assert.deepEqual(json(called), { fixture: 'compact', path: '/api/health/detailed' });
});

test('compact toolset refuses unknown, module-gated and recursive calls as tool errors', { timeout: 15000 }, async t => {
  const client = await connect(t, await backend(t), { env: { OCTIPUS_MCP_TOOLSET: 'compact' } });
  const unknown = await client.callTool({ name: 'octipus_call_tool', arguments: { name: 'nope' } });
  assert.equal(unknown.isError, true);
  // The knowledge tools need an embedding model, which this backend does not report.
  const gated = await client.callTool({ name: 'octipus_describe_tool', arguments: { name: 'octipus_search_knowledge' } });
  assert.equal(gated.isError, true);
  const recursive = await client.callTool({ name: 'octipus_call_tool', arguments: { name: 'octipus_call_tool', arguments: {} } });
  assert.equal(recursive.isError, true);
});

test('the full toolset stays the default', { timeout: 15000 }, async t => {
  const client = await connect(t, await backend(t));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('octipus_health'));
  assert.ok(!names.includes('octipus_call_tool'));
});

test('parseToolset rejects unknown names instead of falling back', () => {
  assert.equal(parseToolset(undefined), 'full');
  assert.equal(parseToolset('compact'), 'compact');
  assert.throws(() => parseToolset('tiny'), /Unknown toolset/);
});

test('rankTools orders by matched words, then name', () => {
  const tools = [
    { name: 'octipus_spawn_agent', description: 'Spawn a new autonomous agent' },
    { name: 'octipus_list_agents', description: 'List running agents' },
    { name: 'octipus_health', description: 'Health status' },
  ];
  assert.deepEqual(rankTools(tools, 'spawn agent', 5).map(t => t.name), ['octipus_spawn_agent', 'octipus_list_agents']);
  assert.deepEqual(rankTools(tools, 'zzz', 5), []);
});
