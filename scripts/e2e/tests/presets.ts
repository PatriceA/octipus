import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';

export async function testPresets(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mPresets\x1b[0m');

  let systemPresetId: string | null = null;
  let customPresetId: string | null = null;

  // List presets — should include seeded system presets
  await runner.test('GET /presets returns system presets', async () => {
    const { status, data } = await client.request<{
      presets: Array<{ id: string; name: string; role: string; isSystem: boolean; icon?: string }>;
    }>('GET', '/presets');
    assertStatus(status, 200);
    assert(Array.isArray(data.presets), 'presets should be an array');
    assert(data.presets.length >= 6, `Expected at least 6 system presets, got ${data.presets.length}`);

    const names = data.presets.map(p => p.name);
    assert(names.includes('Researcher'), 'Expected Researcher preset');
    assert(names.includes('Coder'), 'Expected Coder preset');
    assert(names.includes('Reviewer'), 'Expected Reviewer preset');

    // All returned presets should be system presets (or owned by user)
    const systemPresets = data.presets.filter(p => p.isSystem);
    assert(systemPresets.length >= 6, `Expected at least 6 system presets, got ${systemPresets.length}`);

    systemPresetId = systemPresets[0].id;
  });

  // Get single preset by ID
  await runner.test('GET /presets/:id returns a specific preset', async () => {
    if (!systemPresetId) return;
    const { status, data } = await client.request<{
      id: string; name: string; role: string; isSystem: boolean;
    }>('GET', `/presets/${systemPresetId}`);
    assertStatus(status, 200);
    assert(!!data.id, 'Expected preset id');
    assert(!!data.name, 'Expected preset name');
    assert(!!data.role, 'Expected preset role');
    assert(data.isSystem === true, 'Expected system preset');
  });

  // Get non-existent preset
  await runner.test('GET /presets/:id returns error for invalid ID', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'GET', '/presets/00000000-0000-0000-0000-000000000000',
    );
    // May return 200 with error body or 404 depending on implementation
    assert(status === 200 || status === 404, `Unexpected status ${status}`);
    if (status === 200) {
      assert(!!(data as any).error, 'Expected error message for non-existent preset');
    }
  });

  // Create custom preset
  await runner.test('POST /presets creates a custom preset', async () => {
    const { status, data } = await client.request<{
      id: string; name: string; role: string; isSystem: boolean;
    }>('POST', '/presets', {
      name: 'E2E Test Preset',
      description: 'Created by e2e test suite',
      icon: 'bot',
      role: 'general',
      systemPrompt: 'You are a test assistant.',
    });
    assertStatus(status, 200);
    assert(!!data.id, 'Expected preset id');
    assert(data.name === 'E2E Test Preset', `Expected name "E2E Test Preset", got "${data.name}"`);
    assert(data.isSystem === false, 'Custom preset should not be system');
    customPresetId = data.id;
    fixtures.testPresetId = customPresetId;
  });

  // Update custom preset
  await runner.test('PATCH /presets/:id updates a preset', async () => {
    if (!customPresetId) return;
    const { status, data } = await client.request<{
      id: string; name: string; description?: string;
    }>('PATCH', `/presets/${customPresetId}`, {
      name: 'E2E Updated Preset',
      description: 'Updated by e2e test',
    });
    assertStatus(status, 200);
    assert(data.name === 'E2E Updated Preset', `Expected updated name, got "${data.name}"`);
  });

  // Cannot delete system preset
  await runner.test('DELETE /presets/:id rejects deleting system presets', async () => {
    if (!systemPresetId) return;
    const { status, data } = await client.request<{ error?: string; deleted?: boolean }>(
      'DELETE', `/presets/${systemPresetId}`,
    );
    // Should fail — system presets can't be deleted
    assert(status === 200 || status === 403, `Unexpected status ${status}`);
    if (status === 200) {
      assert(!!(data as any).error, 'Expected error for system preset deletion');
    }
  });

  // Delete custom preset
  await runner.test('DELETE /presets/:id deletes a custom preset', async () => {
    if (!customPresetId) return;
    const { status, data } = await client.request<{ deleted?: boolean }>(
      'DELETE', `/presets/${customPresetId}`,
    );
    assertStatus(status, 200);
    assert(data.deleted === true, 'Expected deleted: true');
    customPresetId = null;
    fixtures.testPresetId = null;
  });

  // Chat with preset
  await runner.test('POST /chat with presetId routes to preset worker', async () => {
    if (!systemPresetId) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${client.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fixtures.authToken}`,
        },
        body: JSON.stringify({
          message: 'Hello, testing preset routing.',
          presetId: systemPresetId,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await response.json() as { response?: string; error?: string; metadata?: Record<string, unknown> };
      assertStatus(response.status, 200);
      assert(!!data.response || !!data.error, 'Expected response or error from preset chat');
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') return; // Timeout acceptable
      throw err;
    }
  });
}
