import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testHooks(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mHooks\x1b[0m');

  let createdHookId: string | null = null;

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

  await runner.test('POST /hooks creates a hook', async () => {
    const { status, data } = await client.request<{
      id: string; name: string; trigger: string; action: string; isEnabled: boolean;
    }>('POST', '/hooks', {
      name: 'E2E Test Hook',
      description: 'Created by e2e test suite',
      trigger: 'webhook',
      triggerConfig: { webhookPath: 'e2e-test' },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: 'Test prompt', orchestrated: true },
      isEnabled: false,
    });
    assertStatus(status, 200);
    assert(!!data.id, 'Expected hook id');
    assert(data.name === 'E2E Test Hook', `Expected name "E2E Test Hook", got "${data.name}"`);
    assert(data.trigger === 'webhook', `Expected trigger "webhook", got "${data.trigger}"`);
    assert(data.action === 'spawn_agent', `Expected action "spawn_agent", got "${data.action}"`);
    assert(data.isEnabled === false, 'Expected isEnabled false');
    createdHookId = data.id;
  });

  await runner.test('GET /hooks/:id returns the created hook', async () => {
    if (!createdHookId) return;
    const { status, data } = await client.request<{
      id: string; name: string; triggerConfig: Record<string, unknown>; actionConfig: Record<string, unknown>;
    }>('GET', `/hooks/${createdHookId}`);
    assertStatus(status, 200);
    assert(data.id === createdHookId, 'Hook id mismatch');
    assert(data.name === 'E2E Test Hook', 'Hook name mismatch');
    assert(data.triggerConfig?.webhookPath === 'e2e-test', 'Expected webhookPath in triggerConfig');
    assert(data.actionConfig?.agentPrompt === 'Test prompt', 'Expected agentPrompt in actionConfig');
    assert(data.actionConfig?.orchestrated === true, 'Expected orchestrated true in actionConfig');
  });

  await runner.test('PATCH /hooks/:id updates hook name and config', async () => {
    if (!createdHookId) return;
    const { status, data } = await client.request<{
      id: string; name: string; description: string; actionConfig: Record<string, unknown>;
    }>('PATCH', `/hooks/${createdHookId}`, {
      name: 'E2E Updated Hook',
      description: 'Updated by e2e test',
      actionConfig: { agentPrompt: 'Updated prompt', orchestrated: false },
    });
    assertStatus(status, 200);
    assert(data.name === 'E2E Updated Hook', `Expected updated name, got "${data.name}"`);
    assert(data.actionConfig?.agentPrompt === 'Updated prompt', 'Expected updated agentPrompt');
    assert(data.actionConfig?.orchestrated === false, 'Expected orchestrated false after update');
  });

  await runner.test('PATCH /hooks/:id toggles isEnabled', async () => {
    if (!createdHookId) return;
    const { status, data } = await client.request<{ id: string; isEnabled: boolean }>(
      'PATCH', `/hooks/${createdHookId}`, { isEnabled: true },
    );
    assertStatus(status, 200);
    assert(data.isEnabled === true, 'Expected isEnabled true after toggle');
  });

  await runner.test('DELETE /hooks/:id deletes the hook', async () => {
    if (!createdHookId) return;
    const { status, data } = await client.request<{ deleted: boolean }>(
      'DELETE', `/hooks/${createdHookId}`,
    );
    assertStatus(status, 200);
    assert(data.deleted === true, 'Expected deleted: true');
    createdHookId = null;
  });

  await runner.test('GET /hooks/:id returns error for deleted hook', async () => {
    // Use a fake ID since we just deleted the hook
    const { status, data } = await client.request<{ error?: string }>(
      'GET', '/hooks/00000000-0000-0000-0000-000000000000',
    );
    assert(status === 200 || status === 404, `Unexpected status ${status}`);
    assert(!!(data as any).error, 'Expected error for non-existent hook');
  });
}
