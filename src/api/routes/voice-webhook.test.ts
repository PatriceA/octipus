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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
/** The install's Speech lane, as the phone lines see it. */
const speech = vi.hoisted(() => ({ available: false }));
vi.mock('@/voice/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/voice/resolve')>()),
  speechStatus: async () => ({ available: speech.available, model: speech.available ? 'kokoro' : null, engine: null, local: true, reason: null }),
  synthesizeWithLane: async (text: string) => ({ audio: Buffer.from(`mp3:${text}`), format: 'mp3', contentType: 'audio/mpeg', model: 'kokoro' }),
}));
vi.mock('@/voice/telephony', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/voice/telephony')>();
  return { ...real, getTelephonyProvider: async (name: string) => providers[name] ?? null };
});

const { voiceRoutes } = await import('./voice');
const { getCallManager } = await import('@/voice/telephony');
const { CALL_AUDIO_TTL_MS, getCallAudioStore } = await import('@/voice/telephony/audio-store');
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
  speech.available = false;
  providers.twilio = new TwilioProvider({ accountSid: 'AC1', authToken: TWILIO_TOKEN, fromNumber: '+15550000000' });
  providers.plivo = new PlivoProvider({ authId: 'MA1', authToken: PLIVO_TOKEN, fromNumber: '+15550000000' });
  providers.telnyx = new TelnyxProvider({
    apiKey: 'k', connectionId: 'c', fromNumber: '+15550000000',
    publicKey: telnyxKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  });
  for (const c of getCallManager().getActive()) getCallManager().updateStatus(c.id, 'ended');
});
afterEach(() => { vi.unstubAllGlobals(); });

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

  test("with a Speech engine and a public URL the greeting is the install's voice: <Play> of a clip the carrier can fetch", async () => {
    speech.available = true;
    settings['voice.language'] = 'de';
    const call = { ...form, CallSid: 'CA-twilio-play' };
    const sig = twilioSignature(`${PUBLIC}/voice/webhook/twilio`, call);
    const xml = await (await post('/voice/webhook/twilio', new URLSearchParams(call).toString(), { ...formType, 'x-twilio-signature': sig })).text();
    const played = /<Play>https:\/\/voice\.example\.org\/voice\/webhook\/audio\/([0-9a-f]{32})<\/Play>/.exec(xml);
    expect(played).not.toBeNull();
    expect(xml).toContain('<Gather input="speech"');
    expect(xml).toContain('language="de-DE"');
    expect(xml).not.toContain('<Say');
    const clip = await app.handle(new Request(`http://127.0.0.1:3000/voice/webhook/audio/${played?.[1]}`));
    expect(await clip.text()).toBe('mp3:Hallo, wie kann ich Ihnen helfen?');
  });

  test('without a Speech engine the carrier says the greeting in voice.language, with no hardcoded voice', async () => {
    settings['voice.language'] = 'de';
    const call = { ...form, CallSid: 'CA-twilio-say' };
    const sig = twilioSignature(`${PUBLIC}/voice/webhook/twilio`, call);
    const xml = await (await post('/voice/webhook/twilio', new URLSearchParams(call).toString(), { ...formType, 'x-twilio-signature': sig })).text();
    expect(xml).toContain('<Say language="de-DE">Hallo, wie kann ich Ihnen helfen?</Say>');
    expect(xml).not.toMatch(/<Play>|voice=|Polly/);
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
  // Call Control v2: the event under `data`, the call under `data.payload`.
  const body = JSON.stringify({
    data: { record_type: 'event', event_type: 'call.initiated', id: 'e-1', payload: { call_control_id: 'v3:telnyx-1', direction: 'incoming', from: '+15551112222', to: '+15550000000' } },
  });
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
    // An accepted inbound call is answered with a Call Control command.
    const commands: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => { commands.push(String(url)); return new Response('{}', { status: 200 }); });
    const spaced = body.replace(/,/g, ', ');
    const res = await post('/voice/webhook/telnyx', spaced, signed(nowTs(), spaced));
    expect(res.status).toBe(200);
    expect(inboundCalls().map((c) => c.providerCallId)).toEqual(['v3:telnyx-1']);
    // Same fields, other bytes: the signature does not carry over.
    expect((await post('/voice/webhook/telnyx', body, signed(nowTs(), spaced))).status).toBe(403);
    expect(commands).toEqual(['https://api.telnyx.com/v2/calls/v3%3Atelnyx-1/actions/answer']);
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
  // The answer URL of an inbound call, as Plivo documents it.
  const form = { CallUUID: 'plivo-1', CallStatus: 'ringing', Direction: 'inbound', From: '+15551112222', To: '+15550000000' };
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

describe('call audio (GET /voice/webhook/audio/:id)', () => {
  const get = (path: string) => app.handle(new Request(`http://127.0.0.1:3000${path}`));

  test('a held clip is served to anyone with its id, as it was stored, and not cached', async () => {
    const audio = Buffer.from('ID3-fake-mp3-bytes');
    const id = getCallAudioStore().put(audio, 'audio/mpeg');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const res = await get(`/voice/webhook/audio/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(audio);
    // A carrier may fetch it again (a retry, a HEAD first).
    expect((await get(`/voice/webhook/audio/${id}`)).status).toBe(200);
  });

  test('an unknown, malformed or expired id → 404', async () => {
    expect((await get(`/voice/webhook/audio/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await get('/voice/webhook/audio/not-an-id')).status).toBe(404);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const id = getCallAudioStore().put(Buffer.from('x'), 'audio/wav');
      expect((await get(`/voice/webhook/audio/${id}`)).status).toBe(200);
      vi.setSystemTime(Date.now() + CALL_AUDIO_TTL_MS + 1);
      expect((await get(`/voice/webhook/audio/${id}`)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });
});
