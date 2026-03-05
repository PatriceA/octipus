import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testHooks(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mHooks\x1b[0m');

  await runner.test('GET /hooks returns hook list', async () => {
    const { status, data } = await client.request<{ hooks: unknown[] }>('GET', '/hooks');
    assertStatus(status, 200);
    assert(Array.isArray(data.hooks), 'hooks should be an array');
  });

  await runner.test('GET /hooks/suggestions returns suggestions array', async () => {
    const { status, data } = await client.request<{ suggestions: unknown[] }>('GET', '/hooks/suggestions');
    assertStatus(status, 200);
    assert(Array.isArray(data.suggestions), 'suggestions should be an array');
  });
}
