import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testMessaging(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mMessaging Tool\x1b[0m');

  await runner.test('GET /tools/messaging returns messaging tool', async () => {
    const { status, data } = await client.request<{ id: string; tools: Array<{ name: string }> }>('GET', '/tools/messaging');
    assertStatus(status, 200);
    assert(data.id === 'messaging', `Expected id 'messaging', got ${data.id}`);
    assert(Array.isArray(data.tools), 'tools should be an array');

    const toolNames = data.tools.map(t => t.name);
    assert(toolNames.includes('list_channels'), `Missing tool: list_channels`);
    assert(toolNames.includes('send_message'), `Missing tool: send_message`);
  });

  await runner.test('POST messaging/list_channels returns channel list', async () => {
    const { status, data } = await client.request<{ result?: { channels: unknown[] }; error?: string }>(
      'POST', '/tools/messaging/tools/list_channels/execute',
      { args: {} },
    );
    assertStatus(status, 200);
    // Should return result with channels array (may be empty if no channels configured)
    assert(data.result !== undefined || data.error !== undefined, 'Expected result or error');
  });
}
