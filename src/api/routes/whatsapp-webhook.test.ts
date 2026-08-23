import { describe, expect, test } from 'vitest';
import { whatsappWebhookRoutes } from './whatsapp-webhook';

/**
 * An install that doesn't use WhatsApp is a normal install. Its webhook
 * endpoints must not report a *server* fault: a 5xx here tells Meta to retry a
 * verification that can never succeed, and it lights up any alerting that
 * watches 5xx rates.
 */
describe('WhatsApp webhook — channel not configured', () => {
  const app = whatsappWebhookRoutes;

  test('GET verification answers 404, not 5xx', async () => {
    const res = await app.handle(
      new Request(
        'http://localhost/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc',
      ),
    );
    expect(res.status).toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  test('POST stays 200 so Meta does not retry-storm an unconfigured install', async () => {
    const res = await app.handle(
      new Request('http://localhost/channels/whatsapp/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
