import type { TestRunner } from '../runner';
import { assert } from '../runner';
import type { APIClient } from '../client';

export async function testAudit(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mAudit\x1b[0m');

  await runner.test('GET /audit returns audit log or error', async () => {
    const { status } = await client.request<{ entries?: unknown[]; error?: string }>('GET', '/audit');
    // May require admin or may not exist — both acceptable
    assert(status === 200 || status === 404, `Unexpected status ${status}`);
  });
}
