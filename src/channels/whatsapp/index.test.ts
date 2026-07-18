/**
 * WhatsApp webhook authentication — the two request-authenticity gates Meta
 * relies on: the `X-Hub-Signature-256` HMAC on inbound POSTs and the
 * `hub.verify_token` challenge on subscription. These are the channel's only
 * defense against forged webhook traffic and were untested.
 *
 * `appSecret` / `verifyToken` are populated by `connect()` from config; the
 * tests set them directly so no config singleton or network is involved.
 */
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'bun:test';
import { WhatsAppChannel } from './index';

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'octipus-verify-token';

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

let channel: WhatsAppChannel;

beforeEach(() => {
  channel = new WhatsAppChannel();
  (channel as unknown as { appSecret: string | null }).appSecret = APP_SECRET;
  (channel as unknown as { verifyToken: string | null }).verifyToken = VERIFY_TOKEN;
});

describe('WhatsAppChannel.verifySignature', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  test('accepts a correctly signed body', () => {
    expect(channel.verifySignature(body, sign(body))).toBe(true);
  });

  test('rejects a tampered body', () => {
    const header = sign(body);
    expect(channel.verifySignature(`${body} `, header)).toBe(false);
  });

  test('rejects a signature computed with the wrong secret', () => {
    expect(channel.verifySignature(body, sign(body, 'attacker-secret'))).toBe(false);
  });

  test('rejects a missing signature header', () => {
    expect(channel.verifySignature(body, null)).toBe(false);
  });

  test('rejects a malformed header (no algorithm prefix)', () => {
    const digest = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(channel.verifySignature(body, digest)).toBe(false);
  });

  test('rejects a non-sha256 algorithm prefix', () => {
    const digest = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(channel.verifySignature(body, `md5=${digest}`)).toBe(false);
  });

  test('documents the insecure skip: with no app secret configured, verification is bypassed', () => {
    (channel as unknown as { appSecret: string | null }).appSecret = null;
    expect(channel.verifySignature(body, null)).toBe(true);
  });
});

describe('WhatsAppChannel.handleVerification', () => {
  test('echoes the challenge on a valid subscribe with the right token', () => {
    const res = channel.handleVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '1234567890',
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('1234567890');
  });

  test('rejects a wrong verify token', () => {
    const res = channel.handleVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': '1234567890',
    });
    expect(res.status).toBe(403);
  });

  test('rejects when the mode is not "subscribe" even with the right token', () => {
    const res = channel.handleVerification({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '1234567890',
    });
    expect(res.status).toBe(403);
  });
});
