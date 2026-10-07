/**
 * Telnyx webhook signatures (docs/plans/federation-spec.md §4.3, §11 item 17).
 *
 * The old check ran an HMAC keyed with the public key — which anyone holding
 * the (public) key could forge — and passed every webhook when no key was
 * configured. Telnyx signs `${timestamp}|${body}` with Ed25519 and publishes
 * a raw 32-byte public key.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { TelnyxProvider } from './telnyx';

function telnyxKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // The raw key is the last 32 bytes of the SPKI DER, as Telnyx shows it.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { raw, privateKey };
}

const body = JSON.stringify({ data: { event_type: 'call.answered', payload: { call_control_id: 'v3:abc' } } });
const timestamp = '1790000000';
const NOW = Number(timestamp) * 1000;

function provider(publicKey?: string) {
  return new TelnyxProvider({ apiKey: 'k', connectionId: 'c', fromNumber: '+15550000000', publicKey });
}

describe('TelnyxProvider.verifyWebhook', () => {
  test('a real Ed25519 signature verifies', () => {
    const { raw, privateKey } = telnyxKeypair();
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
    expect(provider(raw).verifyWebhook({ 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(true);
  });

  test('a forged signature, another key, a changed body or timestamp fail', () => {
    const { raw, privateKey } = telnyxKeypair();
    const other = telnyxKeypair();
    const good = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
    const byOther = sign(null, Buffer.from(`${timestamp}|${body}`), other.privateKey).toString('base64');
    const p = provider(raw);
    expect(p.verifyWebhook({ 'telnyx-signature-ed25519': byOther, 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(false);
    expect(p.verifyWebhook({ 'telnyx-signature-ed25519': good, 'telnyx-timestamp': timestamp }, `${body} `, undefined, NOW)).toBe(false);
    expect(p.verifyWebhook({ 'telnyx-signature-ed25519': good, 'telnyx-timestamp': '1790000001' }, body, undefined, NOW)).toBe(false);
    expect(p.verifyWebhook({ 'telnyx-signature-ed25519': Buffer.alloc(64, 1).toString('base64'), 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(false);
    // The old scheme's output — an HMAC keyed with the public key — is no signature.
    expect(p.verifyWebhook({ 'telnyx-signature-ed25519': 'ab'.repeat(32), 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(false);
    expect(p.verifyWebhook({ 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(false);
  });

  test('a signed webhook whose timestamp is more than 300 s from now fails (replay)', () => {
    const { raw, privateKey } = telnyxKeypair();
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
    const headers = { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp };
    const p = provider(raw);
    expect(p.verifyWebhook(headers, body, undefined, NOW + 300_000)).toBe(true);
    expect(p.verifyWebhook(headers, body, undefined, NOW + 301_000)).toBe(false);
    expect(p.verifyWebhook(headers, body, undefined, NOW - 301_000)).toBe(false);
  });

  test('a missing public key fails instead of passing', () => {
    const { privateKey } = telnyxKeypair();
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
    expect(provider(undefined).verifyWebhook({ 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(false);
    expect(provider('').verifyWebhook({ 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(false);
  });

  test('a configured key that is not an Ed25519 key fails', () => {
    const { privateKey } = telnyxKeypair();
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
    expect(provider('bm90LWEta2V5').verifyWebhook({ 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': timestamp }, body, undefined, NOW)).toBe(false);
  });
});
