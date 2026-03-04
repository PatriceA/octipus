import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testSettings(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mSettings\x1b[0m');

  // The setup-status endpoint is public (no auth required)
  await runner.test('GET /settings/setup-status returns setup status', async () => {
    const { status, data } = await client.request<{ setupComplete: boolean }>('GET', '/settings/setup-status');
    assertStatus(status, 200);
    assert(typeof data.setupComplete === 'boolean', `Expected boolean setupComplete, got ${typeof data.setupComplete}`);
  });

  // Test admin-only endpoints. The test user may or may not be admin.
  // We test both the happy path and access control.
  await runner.test('GET /settings returns settings or admin error', async () => {
    const { status, data } = await client.request<{ settings?: Record<string, unknown>; categories?: string[]; error?: string }>('GET', '/settings');
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(!!data.settings, 'Expected settings object');
      assert(Array.isArray(data.categories), 'Expected categories array');
    }
  });

  await runner.test('GET /settings/registry returns registry or admin error', async () => {
    const { status, data } = await client.request<{ registry?: unknown[]; categories?: string[]; error?: string }>('GET', '/settings/registry');
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(Array.isArray(data.registry), 'Expected registry array');
      assert((data.registry as any[]).length > 0, 'Expected at least one registry entry');
      assert(Array.isArray(data.categories), 'Expected categories array');
    }
  });

  await runner.test('GET /settings/category/litellm returns litellm settings or admin error', async () => {
    const { status, data } = await client.request<{ category?: string; settings?: unknown[]; error?: string }>(
      'GET', '/settings/category/litellm',
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin') || (data as any).error.includes('Unknown'), `Unexpected error: ${(data as any).error}`);
    } else {
      assert(data.category === 'litellm', `Expected category litellm, got ${data.category}`);
      assert(Array.isArray(data.settings), 'Expected settings array');
    }
  });

  await runner.test('GET /settings/category/nonexistent returns error', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'GET', '/settings/category/nonexistent',
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for nonexistent category');
  });

  await runner.test('PUT /settings/:key updates setting or returns admin error', async () => {
    const { status, data } = await client.request<{ success?: boolean; key?: string; error?: string }>(
      'PUT', '/settings/logging.level', { value: 'debug' },
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(data.success === true, 'Expected success: true');
      assert(data.key === 'logging.level', `Expected key logging.level, got ${data.key}`);
    }
  });

  await runner.test('PUT /settings/:key returns error for unknown setting', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'PUT', '/settings/nonexistent.key', { value: 'test' },
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown setting');
  });

  await runner.test('PUT /settings/batch batch-updates settings or returns admin error', async () => {
    const { status, data } = await client.request<{ updated?: string[]; errors?: Record<string, string>; error?: string }>(
      'PUT', '/settings/batch', {
        settings: {
          'logging.level': 'info',
          'agent.maxConcurrent': 3,
        },
      },
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin'), `Expected admin error, got: ${(data as any).error}`);
    } else {
      assert(Array.isArray(data.updated), 'Expected updated array');
    }
  });

  await runner.test('PUT /settings/batch reports errors for unknown keys', async () => {
    const { status, data } = await client.request<{ updated?: string[]; errors?: Record<string, string>; error?: string }>(
      'PUT', '/settings/batch', {
        settings: {
          'nonexistent.key1': 'a',
          'nonexistent.key2': 'b',
        },
      },
    );
    assertStatus(status, 200);
    if (!(data as any).error) {
      assert(!!data.errors, 'Expected errors object for unknown keys');
      assert(Object.keys(data.errors!).length === 2, 'Expected 2 errors');
    }
  });

  await runner.test('POST /settings/:key/reset resets setting or returns admin error', async () => {
    const { status, data } = await client.request<{ success?: boolean; key?: string; value?: unknown; error?: string }>(
      'POST', '/settings/logging.level/reset',
    );
    assertStatus(status, 200);
    if ((data as any).error) {
      assert((data as any).error.includes('Admin') || (data as any).error.includes('Unknown'), `Unexpected error: ${(data as any).error}`);
    } else {
      assert(data.success === true, 'Expected success: true');
      assert(data.key === 'logging.level', `Expected key logging.level, got ${data.key}`);
    }
  });

  await runner.test('POST /settings/:key/reset returns error for unknown setting', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'POST', '/settings/nonexistent.key/reset',
    );
    assertStatus(status, 200);
    assert(!!(data as any).error, 'Expected error for unknown setting');
  });

  await runner.test('POST /settings/setup-complete returns admin error for non-admin', async () => {
    const { status, data } = await client.request<{ success?: boolean; error?: string }>(
      'POST', '/settings/setup-complete',
    );
    assertStatus(status, 200);
    // Non-admin gets error, admin gets success — both are valid
    assert(data.success === true || !!(data as any).error, 'Expected success or admin error');
  });

  // Test unauthenticated access to settings
  await runner.test('GET /settings without auth returns error', async () => {
    const { status, data } = await client.request<{ error?: string }>('GET', '/settings', undefined, '');
    // Should fail without auth (401 or error in body)
    assert(status === 401 || !!(data as any).error, 'Expected 401 or error for unauthenticated settings request');
  });
}
