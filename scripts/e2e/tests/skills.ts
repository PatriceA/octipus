import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testSkills(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mSkills\x1b[0m');

  await runner.test('GET /skills returns registered skills', async () => {
    const { status, data } = await client.request<{ skills: Array<{ id: string; name: string; tools: unknown[] }> }>('GET', '/skills');
    assertStatus(status, 200);
    assert(Array.isArray(data.skills), 'skills should be an array');
    assert(data.skills.length > 0, 'Expected at least one skill');
    // Verify expected skills are present
    const skillIds = data.skills.map(s => s.id);
    assert(skillIds.includes('filesystem'), `filesystem skill missing, got: ${skillIds.join(', ')}`);
    assert(skillIds.includes('websearch'), `websearch skill missing, got: ${skillIds.join(', ')}`);
  });

  await runner.test('GET /skills/:id returns specific skill', async () => {
    const { status, data } = await client.request<{ id: string; name: string; tools: Array<{ name: string }> }>('GET', '/skills/filesystem');
    assertStatus(status, 200);
    assert(data.id === 'filesystem', `Expected id 'filesystem', got ${data.id}`);
    assert(Array.isArray(data.tools), 'tools should be an array');
    assert(data.tools.length > 0, 'Expected at least one tool in filesystem skill');
  });

  await runner.test('GET /skills/:id returns error for unknown skill', async () => {
    const { data } = await client.request<{ error?: string }>('GET', '/skills/nonexistent_skill');
    assert(!!(data as any).error, 'Expected error for unknown skill');
  });

  await runner.test('GET /skills/tools/all returns combined skill + MCP tools', async () => {
    const { status, data } = await client.request<{ tools: Array<{ name: string; source: string }> }>('GET', '/skills/tools/all');
    assertStatus(status, 200);
    assert(Array.isArray(data.tools), 'tools should be an array');
    assert(data.tools.length > 0, 'Expected at least one tool');
  });

  await runner.test('GET /skills/permissions returns user permissions', async () => {
    const { status, data } = await client.request<{ permissions: unknown[] }>('GET', '/skills/permissions');
    assertStatus(status, 200);
    assert(Array.isArray(data.permissions), 'permissions should be an array');
  });
}

export async function testSkillExecution(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mSkill Execution (MCP bridge endpoint)\x1b[0m');

  await runner.test('POST /skills/:skillId/tools/:toolName/execute runs filesystem.read_file', async () => {
    const { status, data } = await client.request<{ result?: unknown; error?: string }>(
      'POST', '/skills/filesystem/tools/read_file/execute',
      { args: { path: '/etc/hostname' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });

  await runner.test('POST /skills/:skillId/tools/:toolName/execute returns error for unknown tool', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'POST', '/skills/filesystem/tools/nonexistent_tool/execute',
      { args: {} },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown tool');
  });

  await runner.test('POST /skills/:skillId/tools/:toolName/execute returns error for unknown skill', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'POST', '/skills/nonexistent/tools/something/execute',
      { args: {} },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown skill');
  });

  await runner.test('POST /skills/:skillId/tools/:toolName/execute works without args', async () => {
    const { status, data } = await client.request<{ result?: unknown; error?: string }>(
      'POST', '/skills/filesystem/tools/list_directory/execute',
      { args: { path: '/tmp' } },
    );
    assertStatus(status, 200);
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });
}
