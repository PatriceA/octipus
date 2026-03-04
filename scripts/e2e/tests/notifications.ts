import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testNotifications(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mNotifications\x1b[0m');

  await runner.test('GET /notifications returns notification list', async () => {
    const { status, data } = await client.request<{ notifications: unknown[] }>('GET', '/notifications');
    assertStatus(status, 200);
    assert(Array.isArray(data.notifications), 'notifications should be an array');
  });

  await runner.test('POST /notifications/read-all marks all read', async () => {
    const { status } = await client.request<unknown>('POST', '/notifications/read-all');
    assertStatus(status, 200);
  });
}
