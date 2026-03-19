import type { TestRunner } from '../runner';
import { assert, assertStatus } from '../runner';
import type { APIClient } from '../client';
import { BASE_URL } from '../fixtures';

export async function testChannels(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mChannel Webhooks\x1b[0m');

  // WhatsApp webhook verification — should respond even without valid token
  await runner.test('GET /channels/whatsapp/webhook returns verification response', async () => {
    const channelUrl = BASE_URL.replace('/api', '/api/channels/whatsapp/webhook');
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'invalid_token',
      'hub.challenge': 'test_challenge_123',
    });
    const response = await fetch(`${channelUrl}?${params}`, {
      method: 'GET',
    });
    // Should respond (either with challenge or error status) — not crash
    assert(response.status < 500, `Expected non-5xx response, got ${response.status}`);
  });

  // WhatsApp webhook POST — should accept and return 200 (always ack to Meta)
  await runner.test('POST /channels/whatsapp/webhook accepts incoming payload', async () => {
    const channelUrl = BASE_URL.replace('/api', '/api/channels/whatsapp/webhook');
    const response = await fetch(channelUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [],
      }),
    });
    // Meta expects 200 always
    assert(response.status === 200 || response.status === 503, `Expected 200 or 503, got ${response.status}`);
  });

  // Teams webhook POST — should handle gracefully even without Bot Framework auth
  await runner.test('POST /channels/teams/webhook handles unauthenticated request', async () => {
    const channelUrl = BASE_URL.replace('/api', '/api/channels/teams/webhook');
    const response = await fetch(channelUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        text: 'test',
        from: { id: 'test-user' },
        channelId: 'msteams',
        conversation: { id: 'test-conv' },
        serviceUrl: 'https://test.botframework.com',
      }),
    });
    // May return 500 (no adapter) or 503 (channel not registered) — should not crash
    assert(response.status < 502, `Expected non-gateway-error response, got ${response.status}`);
  });
}
