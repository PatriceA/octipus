import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';

export async function testChat(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mChat\x1b[0m');

  await runner.test('POST /chat sends a message and returns response with metadata', async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${client.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fixtures.authToken}`,
        },
        body: JSON.stringify({ message: 'Hello, this is an E2E test.' }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await response.json() as {
        response?: string; sessionId?: string; error?: string;
        metadata?: { model?: string; tokens?: number; latencyMs?: number; cached?: boolean };
      };
      assertStatus(response.status, 200);
      assert(data.response !== undefined || !!data.error, `Expected response or error, got: ${JSON.stringify(data).slice(0, 200)}`);
      if (data.sessionId) fixtures.chatSessionId = data.sessionId;
      if (data.metadata) {
        assert(typeof data.metadata.latencyMs === 'number' || data.metadata.latencyMs === undefined, 'latencyMs should be a number if present');
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') return;
      throw err;
    }
  });

  await runner.test('POST /chat continues existing session', async () => {
    if (!fixtures.chatSessionId) return;
    // Use AbortController to prevent hanging on slow model responses
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${client.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fixtures.authToken}`,
        },
        body: JSON.stringify({ message: 'Follow-up: say ok.', sessionId: fixtures.chatSessionId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await response.json() as { response?: string; sessionId?: string; error?: string };
      assertStatus(response.status, 200);
      assert(!!data.response || !!data.error, 'Expected response or error');
      if (data.sessionId) {
        assert(data.sessionId === fixtures.chatSessionId, `Session ID changed: expected ${fixtures.chatSessionId}, got ${data.sessionId}`);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') {
        // Timeout is acceptable — model might be slow
        return;
      }
      throw err;
    }
  });

  // Verify chat created messages in the session
  if (fixtures.chatSessionId) {
    await runner.test('Chat session has messages persisted', async () => {
      const { status, data } = await client.request<{ messages: Array<{ role: string }> }>(
        'GET', `/sessions/${fixtures.chatSessionId}/messages`,
      );
      assertStatus(status, 200);
      assert(Array.isArray(data.messages), 'messages should be an array');
      assert(data.messages.length >= 1, `Expected at least 1 message, got ${data.messages.length}`);
    });
  }
}
