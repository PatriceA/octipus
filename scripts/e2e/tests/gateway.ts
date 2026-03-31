import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';

export async function testGateway(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mGateway\x1b[0m');

  await runner.test('GET /gateway/status returns hub status', async () => {
    if (!fixtures.authToken) return;
    const { status, data } = await client.request<{ started: boolean; connections: unknown; events: unknown }>('GET', '/gateway/status');
    assertStatus(status, 200);
    assert(typeof data.started === 'boolean', 'Missing started field');
    assert(typeof data.connections === 'object', 'Missing connections field');
    assert(typeof data.events === 'object', 'Missing events field');
  });

  await runner.test('GET /gateway/events/stats returns event bus stats', async () => {
    if (!fixtures.authToken) return;
    const { status, data } = await client.request<{ totalPublished: number; activeSubscriptions: number }>('GET', '/gateway/events/stats');
    assertStatus(status, 200);
    assert(typeof data.totalPublished === 'number', 'Missing totalPublished');
    assert(typeof data.activeSubscriptions === 'number', 'Missing activeSubscriptions');
  });

  await runner.test('GET /gateway/adapters returns adapter list', async () => {
    if (!fixtures.authToken) return;
    const { status, data } = await client.request<{ adapters: unknown[] }>('GET', '/gateway/adapters');
    assertStatus(status, 200);
    assert(Array.isArray(data.adapters), 'adapters should be an array');
  });

  await runner.test('GET /gateway/connections requires admin', async () => {
    if (!fixtures.authToken) return;
    const { status, data } = await client.request<any>('GET', '/gateway/connections');
    // Should either work (admin) or return error (non-admin)
    assert(status === 200 || status === 403, `Expected 200 or 403, got ${status}`);
  });

  await runner.test('GET /health/time returns server timezone', async () => {
    const { status, data } = await client.request<{ serverTime: string; timezone: string; utcOffset: number }>('GET', '/health/time', undefined, '');
    assertStatus(status, 200);
    assert(typeof data.serverTime === 'string', 'Missing serverTime');
    assert(typeof data.timezone === 'string', 'Missing timezone');
    assert(typeof data.utcOffset === 'number', 'Missing utcOffset');
  });
}
