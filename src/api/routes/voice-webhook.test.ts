/**
 * Telephony webhooks are authenticated (POST /voice/webhook/:provider and
 * /voice/webhook/:provider/status): the signature is checked over the exact
 * bytes received, against the URL the provider called, before anything acts
 * on the body. An unsigned, forged or stale webhook is refused with 403 and
 * creates no call.
 *
 * The providers are the real classes with test credentials; only the lookup
 * (`getTelephonyProvider`) and the settings it reads are stubbed.
 */
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import { PlivoProvider } from '@/voice/telephony/plivo';
import { TelnyxProvider } from '@/voice/telephony/telnyx';
import { TwilioProvider } from '@/voice/telephony/twilio';
import type { TelephonyProvider } from '@/voice/telephony';

const PUBLIC = 'https://voice.example.org';
const settings: Record<string, unknown> = {};
const providers: Record<string, TelephonyProvider> = {};

vi.mock('@/config/settings-service', () => ({
  getSettingsService: () => ({ get: async (key: string) => settings[key] ?? null }),
}));
vi.mock('@/voice/telephony', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/voice/telephony')>();
  return { ...real, getTelephonyProvider: async (name: string) => providers[name] ?? null };
});

const { voiceRoutes } = await import('./voice');
const { getCallManager } = await import('@/voice/telephony');
const app = new Elysia().use(voiceRoutes);

const TWILIO_TOKEN = 'twilio-auth-token';
const PLIVO_TOKEN = 'plivo-auth-token';
const telnyxKeys = generateKeyPairSync('ed25519');

function post(path: string, body: string, headers: Record<string, string>): Promise<Response> {
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, { method: 'POST', headers, body }));
}

/** Twilio's scheme: HMAC-SHA1 of the URL followed by each sorted form key and its value. */
function twilioSignature(url: string, form: Record<string, string>): string {
  const data = url + Object.keys(form).sort().map((k) => k + form[k]).join('');
  return createHmac('sha1', TWILIO_TOKEN).update(data).digest('base64');
}

const inboundCalls = () => getCallManager().getActive().filter((c) => c.direction === 'inbound');

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  settings['voice.publicUrl'] = PUBLIC;
  settings['voice.inboundPolicy'] = 'open';
  providers.twilio = new TwilioProvider({ accountSid: 'AC1', authToken: TWILIO_TOKEN, fromNumber: '+15550000000' });
  providers.plivo = new PlivoProvider({ authId: 'MA1', authToken: PLIVO_TOKEN, fromNumber: '+15550000000' });
  providers.telnyx = new TelnyxProvider({
    apiKey: 'k', connectionId: 'c', fromNumber: '+15550000000',
    publicKey: telnyxKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  });
  for (const c of getCallManager().getActive()) getCallManager().updateStatus(c.id, 'ended');
});

describe('Twilio webhook', () => {
  const form = { CallSid: 'CA-twilio-1', CallStatus: 'ringing', From: '+15551112222', To: '+15550000000' };
  const raw = new URLSearchParams(form).toString();
  const formType = { 'content-type': 'application/x-www-form-urlencoded' };

  test('unsigned → 403, and no call is created', async () => {
    const res = await post('/voice/webhook/twilio', raw, formType);
    expect(res.status).toBe(403);
    expect(inboundCalls()).toEqual([]);
  });

  test('a signature over other parameters → 403', async () => {
    const sig = twilioSignature(`${PUBLIC}/voice/webhook/twilio`, { ...form, From: '+15559999999' });
    const res = await post('/voice/webhook/twilio', raw, { ...formType, 'x-twilio-signature': sig });
    expect(res.status).toBe(403);
  });

  test('signed over the public URL and the form body → accepted', async () => {
    const sig = twilioSignature(`${PUBLIC}/voice/webhook/twilio`, form);
    const res = await post('/voice/webhook/twilio', raw, { ...formType, 'x-twilio-signature': sig });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(inboundCalls().map((c) => c.providerCallId)).toEqual(['CA-twilio-1']);
  });

  test('the status callback is verified against its own path', async () => {
    const status = { CallSid: 'CA-twilio-2', CallStatus: 'completed' };
    const body = new URLSearchParams(status).toString();
    const wrongPath = twilioSignature(`${PUBLIC}/voice/webhook/twilio`, status);
    expect((await post('/voice/webhook/twilio/status', body, { ...formType, 'x-twilio-signature': wrongPath })).status).toBe(403);
    const sig = twilioSignature(`${PUBLIC}/voice/webhook/twilio/status`, status);
    const res = await post('/voice/webhook/twilio/status', body, { ...formType, 'x-twilio-signature': sig });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('Telnyx webhook', () => {
  const body = JSON.stringify({ call_control_id: 'v3:telnyx-1', event_type: 'call.initiated', from: '+15551112222', to: '+15550000000' });
  const json = { 'content-type': 'application/json' };
  const signed = (ts: string, payload = body) => ({
    ...json,
    'telnyx-timestamp': ts,
    'telnyx-signature-ed25519': sign(null, Buffer.from(`${ts}|${payload}`), telnyxKeys.privateKey).toString('base64'),
  });
  const nowTs = () => String(Math.floor(Date.now() / 1000));

  test('unsigned → 403', async () => {
    expect((await post('/voice/webhook/telnyx', body, json)).status).toBe(403);
    expect(inboundCalls()).toEqual([]);
  });

  test('signed over the raw bytes → accepted; the same signature on re-serialised JSON → 403', async () => {
    const spaced = body.replace(/,/g, ', ');
    const res = await post('/voice/webhook/telnyx', spaced, signed(nowTs(), spaced));
    expect(res.status).toBe(200);
    expect(inboundCalls().map((c) => c.providerCallId)).toEqual(['v3:telnyx-1']);
    // Same fields, other bytes: the signature does not carry over.
    expect((await post('/voice/webhook/telnyx', body, signed(nowTs(), spaced))).status).toBe(403);
  });

  test('a stale timestamp → 403 even with a valid signature', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    expect((await post('/voice/webhook/telnyx', body, signed(stale))).status).toBe(403);
    const future = String(Math.floor(Date.now() / 1000) + 301);
    expect((await post('/voice/webhook/telnyx/status', body, signed(future))).status).toBe(403);
    expect(inboundCalls()).toEqual([]);
  });
});

describe('Plivo webhook', () => {
  const form = { CallUUID: 'p-1', RequestUUID: 'plivo-1', Event: 'ringing', From: '+15551112222', To: '+15550000000' };
  const raw = new URLSearchParams(form).toString();
  const formType = { 'content-type': 'application/x-www-form-urlencoded' };
  const v2 = (url: string, nonce: string) => createHmac('sha256', PLIVO_TOKEN).update(url + nonce).digest('base64');

  test('unsigned, legacy-only or nonce-less → 403', async () => {
    expect((await post('/voice/webhook/plivo', raw, formType)).status).toBe(403);
    const sig = v2(`${PUBLIC}/voice/webhook/plivo`, '');
    expect((await post('/voice/webhook/plivo', raw, { ...formType, 'x-plivo-signature': sig })).status).toBe(403);
    expect((await post('/voice/webhook/plivo', raw, { ...formType, 'x-plivo-signature-v2': sig })).status).toBe(403);
  });

  test('a V2 signature over the URL (query excluded) and nonce → accepted', async () => {
    const nonce = '12345678901234567890';
    const sig = v2(`${PUBLIC}/voice/webhook/plivo`, nonce);
    const res = await post('/voice/webhook/plivo?x=1', raw, { ...formType, 'x-plivo-signature-v2': sig, 'x-plivo-signature-v2-nonce': nonce });
    expect(res.status).toBe(200);
    expect(inboundCalls().map((c) => c.providerCallId)).toEqual(['plivo-1']);
  });
});
