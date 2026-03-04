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
}
