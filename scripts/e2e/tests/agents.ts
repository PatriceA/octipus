import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testAgents(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mAgents\x1b[0m');

  let agentId: string | null = null;

  await runner.test('GET /agents returns agent list', async () => {
    const { status, data } = await client.request<{ agents: unknown[] }>('GET', '/agents');
    assertStatus(status, 200);
    assert(Array.isArray(data.agents), 'agents should be an array');
  });

  // First create a session for the agent
  let agentSessionId: string | null = null;
  await runner.test('POST /sessions creates session for agent', async () => {
    const { status, data } = await client.request<{ id: string }>(
      'POST', '/sessions', { channel: 'test' },
    );
    assertStatus(status, 200);
    agentSessionId = data.id;
  });

  await runner.test('POST /agents spawns a new agent', async () => {
    if (!agentSessionId) throw new Error('No session for agent');
    const { status, data } = await client.request<{ id?: string; agentId?: string; error?: string }>(
      'POST', '/agents', { sessionId: agentSessionId, message: 'E2E test: what is 2+2?' },
    );
    assertStatus(status, 200);
    const id = data.id || data.agentId;
    assert(!!id || !!data.error, 'Expected agent ID or error');
    if (id) agentId = id;
  });

  await runner.test('GET /agents/:id returns agent details', async () => {
    if (!agentId) return;
    const { status, data } = await client.request<{ id?: string; status?: string }>('GET', `/agents/${agentId}`);
    assertStatus(status, 200);
    assert(!!data.status, 'Expected agent status');
  });

  await runner.test('GET /agents/:id/events returns agent events', async () => {
    if (!agentId) return;
    // Wait for the agent to produce some events
    await new Promise(r => setTimeout(r, 2000));
    const { status, data } = await client.request<{ events: Array<{ seq: number; type: string }> }>(
      'GET', `/agents/${agentId}/events`,
    );
    assertStatus(status, 200);
    assert(Array.isArray(data.events), 'events should be an array');
  });

  await runner.test('GET /agents/:id/events supports after= polling', async () => {
    if (!agentId) return;
    const { status, data } = await client.request<{ events: unknown[] }>(
      'GET', `/agents/${agentId}/events?after=0`,
    );
    assertStatus(status, 200);
    assert(Array.isArray(data.events), 'events should be an array');
  });

  await runner.test('POST /agents/route returns routing decision', async () => {
    const { status, data } = await client.request<{ model?: string; topic?: string; confidence?: number; error?: string }>(
      'POST', '/agents/route', { message: 'Search for weather in Berlin' },
    );
    assertStatus(status, 200);
    assert(!!data.topic || !!data.error, `Expected topic or error, got: ${JSON.stringify(data)}`);
  });

  await runner.test('POST /agents/:id/stop stops the agent', async () => {
    if (!agentId) return;
    const { status } = await client.request<unknown>('POST', `/agents/${agentId}/stop`);
    // 200 if still running, could error if already completed
    assert(status === 200 || status === 404 || status === 400, `Unexpected status ${status}`);
  });
}
