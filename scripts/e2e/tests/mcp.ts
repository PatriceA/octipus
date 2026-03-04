import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testMCP(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mMCP\x1b[0m');

  await runner.test('GET /mcp/tools returns available MCP tools', async () => {
    const { status, data } = await client.request<{ tools: unknown[] }>('GET', '/mcp/tools');
    assertStatus(status, 200);
    assert(Array.isArray(data.tools), 'tools should be an array');
  });

  await runner.test('GET /mcp/servers returns server list', async () => {
    const { status, data } = await client.request<{ servers?: unknown[]; error?: string }>('GET', '/mcp/servers');
    assertStatus(status, 200);
    // Non-admin users get an error, that's expected behavior
    assert(Array.isArray(data.servers) || !!data.error, 'Expected servers array or error');
  });
}
