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
