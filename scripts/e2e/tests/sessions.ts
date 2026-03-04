import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';

export async function testSessions(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mSessions\x1b[0m');

  let sessionId: string | null = null;

  await runner.test('GET /sessions returns session list', async () => {
    const { status, data } = await client.request<{ sessions: unknown[] }>('GET', '/sessions');
    assertStatus(status, 200);
    assert(Array.isArray(data.sessions), 'sessions should be an array');
  });

  await runner.test('POST /sessions creates a new session', async () => {
    const { status, data } = await client.request<{ id: string; channel?: string }>(
      'POST', '/sessions', { channel: 'test' },
    );
    assertStatus(status, 200);
    assert(!!data.id, 'No session ID returned');
    sessionId = data.id;
  });

  await runner.test('GET /sessions/:id returns session details', async () => {
    if (!sessionId) throw new Error('No session to get');
    const { status, data } = await client.request<{ id: string }>('GET', `/sessions/${sessionId}`);
    assertStatus(status, 200);
    assert(data.id === sessionId, 'Session ID mismatch');
  });

  await runner.test('GET /sessions/:id/messages returns empty messages for new session', async () => {
    if (!sessionId) throw new Error('No session');
    const { status, data } = await client.request<{ messages: unknown[] }>('GET', `/sessions/${sessionId}/messages`);
    assertStatus(status, 200);
    assert(Array.isArray(data.messages), 'messages should be an array');
  });

  await runner.test('GET /sessions/:id/messages supports pagination', async () => {
    if (!sessionId) throw new Error('No session');
    const { status, data } = await client.request<{ messages: unknown[] }>(
      'GET', `/sessions/${sessionId}/messages?limit=5&offset=0`,
    );
    assertStatus(status, 200);
    assert(Array.isArray(data.messages), 'messages should be an array');
  });

  await runner.test('PATCH /sessions/:id updates session', async () => {
    if (!sessionId) throw new Error('No session');
    const { status } = await client.request<unknown>(
      'PATCH', `/sessions/${sessionId}`, { status: 'active' },
    );
    assertStatus(status, 200);
  });

  await runner.test('POST /sessions/:id/complete marks session complete', async () => {
    if (!sessionId) throw new Error('No session');
    const { status } = await client.request<unknown>(
      'POST', `/sessions/${sessionId}/complete`,
    );
    assertStatus(status, 200);
  });

  await runner.test('DELETE /sessions/:id deletes session', async () => {
    if (!sessionId) throw new Error('No session');
    const { status } = await client.request<unknown>('DELETE', `/sessions/${sessionId}`);
    assertStatus(status, 200);
  });
}
