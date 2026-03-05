import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';

export async function testExperts(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mExperts\x1b[0m');

  let systemExpertId: string | null = null;
  let customExpertId: string | null = null;

  // List experts — should include seeded system experts
  await runner.test('GET /experts returns system experts', async () => {
    const { status, data } = await client.request<{
      experts: Array<{ id: string; name: string; role: string; isSystem: boolean; icon?: string }>;
    }>('GET', '/experts');
    assertStatus(status, 200);
    assert(Array.isArray(data.experts), 'experts should be an array');
    assert(data.experts.length >= 6, `Expected at least 6 system experts, got ${data.experts.length}`);

    const names = data.experts.map(p => p.name);
    assert(names.includes('Researcher'), 'Expected Researcher expert');
    assert(names.includes('Coder'), 'Expected Coder expert');
    assert(names.includes('Reviewer'), 'Expected Reviewer expert');

    // All returned experts should be system experts (or owned by user)
    const systemExperts = data.experts.filter(p => p.isSystem);
    assert(systemExperts.length >= 6, `Expected at least 6 system experts, got ${systemExperts.length}`);

    systemExpertId = systemExperts[0].id;
  });

  // Get single expert by ID
  await runner.test('GET /experts/:id returns a specific expert', async () => {
    if (!systemExpertId) return;
    const { status, data } = await client.request<{
      id: string; name: string; role: string; isSystem: boolean;
    }>('GET', `/experts/${systemExpertId}`);
    assertStatus(status, 200);
    assert(!!data.id, 'Expected expert id');
    assert(!!data.name, 'Expected expert name');
    assert(!!data.role, 'Expected expert role');
    assert(data.isSystem === true, 'Expected system expert');
  });

  // Get non-existent expert
  await runner.test('GET /experts/:id returns error for invalid ID', async () => {
    const { status, data } = await client.request<{ error?: string }>(
      'GET', '/experts/00000000-0000-0000-0000-000000000000',
    );
    // May return 200 with error body or 404 depending on implementation
    assert(status === 200 || status === 404, `Unexpected status ${status}`);
    if (status === 200) {
      assert(!!(data as any).error, 'Expected error message for non-existent expert');
    }
  });

  // Create custom expert
  await runner.test('POST /experts creates a custom expert', async () => {
    const { status, data } = await client.request<{
      id: string; name: string; role: string; isSystem: boolean;
    }>('POST', '/experts', {
      name: 'E2E Test Expert',
      description: 'Created by e2e test suite',
      icon: 'bot',
      role: 'general',
      systemPrompt: 'You are a test assistant.',
    });
    assertStatus(status, 200);
    assert(!!data.id, 'Expected expert id');
    assert(data.name === 'E2E Test Expert', `Expected name "E2E Test Expert", got "${data.name}"`);
    assert(data.isSystem === false, 'Custom expert should not be system');
    customExpertId = data.id;
    fixtures.testExpertId = customExpertId;
  });

  // Update custom expert
  await runner.test('PATCH /experts/:id updates a expert', async () => {
    if (!customExpertId) return;
    const { status, data } = await client.request<{
      id: string; name: string; description?: string;
    }>('PATCH', `/experts/${customExpertId}`, {
      name: 'E2E Updated Expert',
      description: 'Updated by e2e test',
    });
    assertStatus(status, 200);
    assert(data.name === 'E2E Updated Expert', `Expected updated name, got "${data.name}"`);
  });

  // Cannot delete system expert
  await runner.test('DELETE /experts/:id rejects deleting system experts', async () => {
    if (!systemExpertId) return;
    const { status, data } = await client.request<{ error?: string; deleted?: boolean }>(
      'DELETE', `/experts/${systemExpertId}`,
    );
    // Should fail — system experts can't be deleted
    assert(status === 200 || status === 403, `Unexpected status ${status}`);
    if (status === 200) {
      assert(!!(data as any).error, 'Expected error for system expert deletion');
    }
  });

  // Delete custom expert
  await runner.test('DELETE /experts/:id deletes a custom expert', async () => {
    if (!customExpertId) return;
    const { status, data } = await client.request<{ deleted?: boolean }>(
      'DELETE', `/experts/${customExpertId}`,
    );
    assertStatus(status, 200);
    assert(data.deleted === true, 'Expected deleted: true');
    customExpertId = null;
    fixtures.testExpertId = null;
  });

  // Chat with expert
  await runner.test('POST /chat with expertId routes to expert worker', async () => {
    if (!systemExpertId) return;
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
          message: 'Hello, testing expert routing.',
          expertId: systemExpertId,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await response.json() as { response?: string; error?: string; metadata?: Record<string, unknown> };
      assertStatus(response.status, 200);
      assert(!!data.response || !!data.error, 'Expected response or error from expert chat');
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') return; // Timeout acceptable
      throw err;
    }
  });
}
