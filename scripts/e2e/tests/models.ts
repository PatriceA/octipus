import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testModels(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mModels\x1b[0m');

  await runner.test('GET /models returns model list', async () => {
    const { status, data } = await client.request<{ models: Array<{ name: string; provider: string }> }>('GET', '/models');
    assertStatus(status, 200);
    assert(Array.isArray(data.models), 'models should be an array');
  });

  await runner.test('GET /models/health returns health status', async () => {
    const { status, data } = await client.request<Record<string, unknown>>('GET', '/models/health');
    assertStatus(status, 200);
    assert(typeof data === 'object', 'Expected health object');
  });

  await runner.test('GET /models/cli/status returns CLI tools status', async () => {
    const { status, data } = await client.request<Record<string, unknown>>('GET', '/models/cli/status');
    assertStatus(status, 200);
    assert(typeof data === 'object', 'Expected status object');
  });

  await runner.test('GET /models/usage returns user usage stats', async () => {
    const { status, data } = await client.request<Record<string, unknown>>('GET', '/models/usage');
    assertStatus(status, 200);
    assert(typeof data === 'object', 'Expected usage object');
  });

  await runner.test('GET /models/providers/ollama/models lists ollama models', async () => {
    const { status } = await client.request<unknown>('GET', '/models/providers/ollama/models');
    // May return 200 with list or error if ollama not running — both valid
    assert(status === 200 || status === 500, `Unexpected status ${status}`);
  });

  await runner.test('GET /models/providers/litellm/models lists litellm models', async () => {
    const { status } = await client.request<unknown>('GET', '/models/providers/litellm/models');
    assert(status === 200 || status === 500, `Unexpected status ${status}`);
  });
}
