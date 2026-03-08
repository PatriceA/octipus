import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testHealth(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mHealth\x1b[0m');

  await runner.test('GET /health returns ok', async () => {
    const { status, data } = await client.request<{ status: string }>('GET', '/health', undefined, '');
    assertStatus(status, 200);
    assert(data.status === 'ok', `Expected status ok, got ${data.status}`);
  });

  await runner.test('GET /health/detailed rejects unauthenticated requests', async () => {
    const { status } = await client.request<{ error: string }>('GET', '/health/detailed', undefined, '');
    assertStatus(status, 401);
  });

  await runner.test('GET /health/detailed returns services (authenticated)', async () => {
    const { status, data } = await client.request<{ status: string; health?: unknown }>('GET', '/health/detailed');
    assertStatus(status, 200);
    assert(!!data.status, 'Missing status field');
  });

  await runner.test('GET /health/database returns db status', async () => {
    const { status, data } = await client.request<{ status: string }>('GET', '/health/database', undefined, '');
    assertStatus(status, 200);
    assert(!!data.status, 'Missing status field');
  });

  await runner.test('GET /health/redis returns redis status', async () => {
    const { status, data } = await client.request<{ status: string }>('GET', '/health/redis', undefined, '');
    assertStatus(status, 200);
    assert(!!data.status, 'Missing status field');
  });
}
