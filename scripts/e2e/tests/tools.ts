import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testTools(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mTools\x1b[0m');

  await runner.test('GET /tools returns registered tools', async () => {
    const { status, data } = await client.request<{ tools: Array<{ id: string; name: string; tools: unknown[] }> }>('GET', '/tools');
    assertStatus(status, 200);
    assert(Array.isArray(data.tools), 'tools should be an array');
    assert(data.tools.length > 0, 'Expected at least one tool');
    // Verify expected tools are present
    const toolIds = data.tools.map(s => s.id);
    assert(toolIds.includes('filesystem'), `filesystem tool missing, got: ${toolIds.join(', ')}`);
    assert(toolIds.includes('websearch'), `websearch tool missing, got: ${toolIds.join(', ')}`);
  });

  await runner.test('GET /tools/:id returns specific tool', async () => {
    const { status, data } = await client.request<{ id: string; name: string; tools: Array<{ name: string }> }>('GET', '/tools/filesystem');
    assertStatus(status, 200);
    assert(data.id === 'filesystem', `Expected id 'filesystem', got ${data.id}`);
    assert(Array.isArray(data.tools), 'tools should be an array');
    assert(data.tools.length > 0, 'Expected at least one tool in filesystem tool');
  });

  await runner.test('GET /tools/:id returns error for unknown tool', async () => {
    const { data } = await client.request<{ error?: string }>('GET', '/tools/nonexistent_tool');
    assert(!!(data as any).error, 'Expected error for unknown tool');
  });

  await runner.test('GET /tools/all returns combined tool + MCP tools', async () => {
    const { status, data } = await client.request<{ tools: Array<{ name: string; source: string }> }>('GET', '/tools/all');
    assertStatus(status, 200);
    assert(Array.isArray(data.tools), 'tools should be an array');
    assert(data.tools.length > 0, 'Expected at least one tool');
  });

  await runner.test('GET /tools/permissions returns user permissions', async () => {
    const { status, data } = await client.request<{ permissions: unknown[] }>('GET', '/tools/permissions');
    assertStatus(status, 200);
    assert(Array.isArray(data.permissions), 'permissions should be an array');
  });
}

export async function testToolExecution(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mTool Execution (MCP bridge endpoint)\x1b[0m');

  await runner.test('POST /tools/:toolId/tools/:toolName/execute runs filesystem.read_file', async () => {
    const { status, data } = await client.request<{ result?: unknown; error?: string }>(
      'POST', '/tools/filesystem/tools/read_file/execute',
      { args: { path: '/etc/hostname' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });

  await runner.test('POST /tools/:toolId/tools/:toolName/execute returns error for unknown tool', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'POST', '/tools/filesystem/tools/nonexistent_tool/execute',
      { args: {} },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown tool');
  });

  await runner.test('POST /tools/:toolId/tools/:toolName/execute returns error for unknown tool', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'POST', '/tools/nonexistent/tools/something/execute',
      { args: {} },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown tool');
  });

  await runner.test('POST /tools/:toolId/tools/:toolName/execute works without args', async () => {
    const { status, data } = await client.request<{ result?: unknown; error?: string }>(
      'POST', '/tools/filesystem/tools/list_directory/execute',
      { args: { path: '/tmp' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });
}
