import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testVault(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mVault\x1b[0m');
  let credentialId: string | null = null;

  await runner.test('POST /vault creates credential', async () => {
    const { status, data } = await client.request<{ id: string }>(
      'POST', '/vault', { name: 'e2e_test_key', value: 'test_secret_value', credentialType: 'api_key' },
    );
    assertStatus(status, 200);
    assert(!!data.id, 'No credential ID returned');
    credentialId = data.id;
  });

  await runner.test('GET /vault lists credentials', async () => {
    const { status, data } = await client.request<{ credentials: Array<{ name: string }> }>('GET', '/vault');
    assertStatus(status, 200);
    assert(Array.isArray(data.credentials), 'credentials should be an array');
    const found = data.credentials.some(c => c.name === 'e2e_test_key');
    assert(found, 'Created credential not found');
  });

  await runner.test('DELETE /vault/:id removes credential', async () => {
    if (!credentialId) throw new Error('No credential to delete');
    const { status } = await client.request<unknown>('DELETE', `/vault/${credentialId}`);
    assertStatus(status, 200);
  });
}
