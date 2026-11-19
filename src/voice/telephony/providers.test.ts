/**
 * Each provider reads its own webhooks into the shared event shape and
 * answers in its own protocol. The payloads are in the shapes the providers
 * document (the sources are named at each `parseWebhook`); none of this has
 * run against a live carrier.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CallInstruction } from './interface';
import { PlivoProvider } from './plivo';
import { TelnyxProvider } from './telnyx';
import { TwilioProvider } from './twilio';

const twilio = new TwilioProvider({ accountSid: 'AC1', authToken: 't', fromNumber: '+15550000000' });
const plivo = new PlivoProvider({ authId: 'MA1', authToken: 't', fromNumber: '+15550000000' });
const telnyx = new TelnyxProvider({ apiKey: 'KEY', connectionId: 'c', fromNumber: '+15550000000' });

const listen: CallInstruction = { say: { text: 'Hello & welcome' }, then: 'listen', callbackUrl: 'https://x.example/api/voice/webhook/p?a=1&b=2', locale: 'de-DE' };

afterEach(() => { vi.unstubAllGlobals(); });

/** Record the provider's API calls; every one answers 200. */
function stubFetch(status = 200): Array<{ url: string; method: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    return new Response(status === 200 ? '{"data":{"result":"ok"}}' : '{"errors":[{"code":"90018"}]}', { status });
  });
  return calls;
}

describe('Twilio', () => {
  const base = { CallSid: 'CA1', From: '+15551112222', To: '+15550000000' };

  test('webhooks → events', () => {
    expect(twilio.parseWebhook({ ...base, CallStatus: 'ringing', Direction: 'inbound' })).toMatchObject({ type: 'incoming', callId: 'CA1', direction: 'inbound', from: '+15551112222', to: '+15550000000' });
    expect(twilio.parseWebhook({ ...base, CallStatus: 'ringing', Direction: 'outbound-api' })).toMatchObject({ type: 'ringing', direction: 'outbound' });
    expect(twilio.parseWebhook({ ...base, CallStatus: 'in-progress', Direction: 'outbound-api' })).toMatchObject({ type: 'answered' });
    // A Gather callback: in-progress, with what was said.
    expect(twilio.parseWebhook({ ...base, CallStatus: 'in-progress', SpeechResult: ' What time is it? ' })).toMatchObject({ type: 'speech', speech: 'What time is it?' });
    expect(twilio.parseWebhook({ ...base, CallStatus: 'completed' })).toMatchObject({ type: 'hangup', status: 'ended' });
    expect(twilio.parseWebhook({ ...base, CallStatus: 'canceled' })).toMatchObject({ type: 'hangup', status: 'ended' });
    expect(twilio.parseWebhook({ ...base, CallStatus: 'busy' })).toMatchObject({ type: 'hangup', status: 'busy' });
    expect(twilio.parseWebhook({ ...base, CallStatus: 'no-answer' })).toMatchObject({ type: 'hangup', status: 'no-answer' });
    expect(twilio.parseWebhook({ ...base, CallStatus: 'failed' })).toMatchObject({ type: 'hangup', status: 'failed' });
    expect(twilio.parseWebhook({})).toMatchObject({ type: 'other', callId: '' });
  });

  test('listen: <Say> in the call language, no hardcoded voice, inside a <Gather> for that language', async () => {
    const { contentType, body } = await twilio.instruct('CA1', listen);
    expect(contentType).toBe('application/xml');
    expect(body).toContain('<Say language="de-DE">Hello &amp; welcome</Say>');
    expect(body).toContain('<Gather input="speech" action="https://x.example/api/voice/webhook/p?a=1&amp;b=2" speechTimeout="auto" language="de-DE"');
    expect(body).not.toMatch(/voice=|Polly/);
    expect(body).not.toContain('<Play>');
  });

  test("a line the install's engine spoke is played, not said; the re-prompt follows the Gather", async () => {
    const { body } = await twilio.instruct('CA1', {
      ...listen,
      say: { text: 'Hello', audioUrl: 'https://x.example/api/voice/webhook/audio/abc?x=1&y=2' },
      reprompt: { stillThere: { text: 'Sind Sie noch da?' }, listening: { text: 'Ich höre.', audioUrl: 'https://x.example/a/def' } },
    });
    expect(body).toContain('<Play>https://x.example/api/voice/webhook/audio/abc?x=1&amp;y=2</Play>');
    expect(body).not.toContain('>Hello<');
    expect(body.indexOf('Sind Sie noch da?')).toBeGreaterThan(body.indexOf('</Gather>'));
    expect(body).toContain('<Play>https://x.example/a/def</Play>');
    expect(body.trim().endsWith('<Hangup/>\n</Response>')).toBe(true);
  });

  test('hang up after a line, connect a stream, reject, acknowledge', async () => {
    expect((await twilio.instruct('CA1', { say: { text: 'Bye' }, then: 'hangup', locale: 'en-US' })).body).toMatch(/<Say language="en-US">Bye<\/Say>\s*<Hangup\/>/);
    const stream = (await twilio.instruct('CA1', { say: { text: 'Hi' }, then: 'stream', streamUrl: 'wss://x.example/voice/media/twilio?token=t', locale: 'en-US' })).body;
    expect(stream).toMatch(/<Say language="en-US">Hi<\/Say>\s*<Connect>\s*<Stream url="wss:\/\/x.example\/voice\/media\/twilio\?token=t" \/>/);
    expect((await twilio.rejectIncoming()).body).toContain('<Reject/>');
    expect(twilio.acknowledge().body).toContain('<Response></Response>');
    expect(await twilio.acceptIncoming()).toBe(true);
    await expect(twilio.instruct('CA1', { then: 'listen', locale: 'en-US' })).rejects.toThrow(/callback URL/);
  });
});

describe('Plivo', () => {
  test('an inbound call is known by its CallUUID (there is no RequestUUID)', () => {
    // https://www.plivo.com/docs/voice/xml/request — the answer URL of an inbound call.
    const event = plivo.parseWebhook({ CallUUID: 'c-uuid-1', From: '15551112222', To: '15550000000', CallStatus: 'ringing', Direction: 'inbound', Event: 'StartApp' });
    expect(event).toMatchObject({ type: 'incoming', callId: 'c-uuid-1', aliases: [], direction: 'inbound', from: '15551112222', to: '15550000000' });
  });

  test("an outbound call's callbacks carry the request id it was created with, next to the CallUUID", () => {
    // https://www.plivo.com/docs/voice/api/calls — ring_url, answer_url and hangup_url callbacks.
    const ids = { RequestUUID: 'req-1', CallUUID: 'c-uuid-2', From: '15550000000', To: '15551112222', Direction: 'outbound' };
    expect(plivo.parseWebhook({ ...ids, Event: 'Ring', CallStatus: 'ringing' })).toMatchObject({ type: 'ringing', callId: 'c-uuid-2', aliases: ['req-1'] });
    expect(plivo.parseWebhook({ ...ids, Event: 'StartApp', CallStatus: 'in-progress' })).toMatchObject({ type: 'answered', callId: 'c-uuid-2', aliases: ['req-1'], direction: 'outbound' });
    expect(plivo.parseWebhook({ ...ids, Event: 'Hangup', CallStatus: 'completed' })).toMatchObject({ type: 'hangup', status: 'ended' });
    expect(plivo.parseWebhook({ ...ids, Event: 'Hangup', CallStatus: 'busy' })).toMatchObject({ type: 'hangup', status: 'busy' });
    expect(plivo.parseWebhook({ ...ids, Event: 'Hangup', CallStatus: 'timeout' })).toMatchObject({ type: 'hangup', status: 'no-answer' });
    expect(plivo.parseWebhook({ ...ids, Event: 'Hangup', CallStatus: 'no-answer' })).toMatchObject({ type: 'hangup', status: 'no-answer' });
    expect(plivo.parseWebhook({ ...ids, Event: 'Hangup', CallStatus: 'failed' })).toMatchObject({ type: 'hangup', status: 'failed' });
  });

  test('a GetInput action posts what was said', () => {
    // https://www.plivo.com/docs/voice/xml/getinput — parameters sent to the action URL.
    const event = plivo.parseWebhook({ CallUUID: 'c-uuid-1', From: '15551112222', To: '15550000000', Direction: 'inbound', CallStatus: 'in-progress', InputType: 'speech', Speech: 'what time is it', SpeechConfidenceScore: '0.93', Digits: '' });
    expect(event).toMatchObject({ type: 'speech', callId: 'c-uuid-1', speech: 'what time is it' });
  });

  test('listen: <Speak> or <Play> inside a speech <GetInput> in the call language; then the re-prompt and a hangup', async () => {
    const said = (await plivo.instruct('c', listen)).body;
    expect(said).toContain('<GetInput action="https://x.example/api/voice/webhook/p?a=1&amp;b=2" method="POST" inputType="speech" language="de-DE"');
    expect(said).toContain('<Speak language="de-DE">Hello &amp; welcome</Speak>');
    expect(said).not.toMatch(/voice=/);
    const played = (await plivo.instruct('c', { ...listen, say: { text: 'Hello', audioUrl: 'https://x.example/a/1' }, reprompt: { stillThere: { text: 'Noch da?' }, listening: { text: 'Bitte.' } } })).body;
    expect(played).toContain('<Play>https://x.example/a/1</Play>');
    expect(played).not.toContain('>Hello<');
    expect(played.indexOf('Noch da?')).toBeGreaterThan(played.indexOf('</GetInput>'));
    expect(played.trim().endsWith('<Hangup/>\n</Response>')).toBe(true);
  });

  test('hang up after a line, reject, no media stream', async () => {
    expect((await plivo.instruct('c', { say: { text: 'Bye' }, then: 'hangup', locale: 'en-US' })).body).toMatch(/<Speak language="en-US">Bye<\/Speak>\s*<Hangup\/>/);
    expect((await plivo.rejectIncoming()).body).toContain('<Hangup reason="rejected"/>');
    expect(plivo.mediaStream).toBe(false);
    await expect(plivo.instruct('c', { then: 'stream', streamUrl: 'wss://x', locale: 'en-US' })).rejects.toThrow(/media stream/);
  });

  test('ending a call addresses it by CallUUID and fails loud', async () => {
    const calls = stubFetch(204);
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), method: init.method ?? 'GET', body: {} }); return new Response(null, { status: 204 }); });
    await plivo.endCall('c-uuid-2');
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.plivo.com/v1/Account/MA1/Call/c-uuid-2/', method: 'DELETE' });
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    await expect(plivo.endCall('gone')).rejects.toThrow(/HTTP 404/);
  });
});

describe('Telnyx', () => {
  /** A Call Control v2 webhook: everything under `data`, the call under `data.payload`. */
  const webhook = (event_type: string, payload: Record<string, unknown> = {}) => ({
    data: {
      record_type: 'event', event_type, id: '0ccc7b54-4df3-4bca-a65a-3da1ecc777f0', occurred_at: '2018-02-02T22:25:27.521992Z',
      payload: { call_control_id: 'v3:abc', connection_id: '7267', call_leg_id: 'leg', call_session_id: 'sess', client_state: null, from: '+12025550133', to: '+12025550131', ...payload },
    },
    meta: { attempt: 1, delivered_to: 'https://x.example/api/voice/webhook/telnyx' },
  });

  test('webhooks → events (fields are nested under data.payload)', () => {
    expect(telnyx.parseWebhook(webhook('call.initiated', { direction: 'incoming', state: 'parked' }))).toMatchObject({ type: 'incoming', callId: 'v3:abc', direction: 'inbound', from: '+12025550133', to: '+12025550131' });
    expect(telnyx.parseWebhook(webhook('call.initiated', { direction: 'outgoing', state: 'bridging' }))).toMatchObject({ type: 'ringing', direction: 'outbound' });
    expect(telnyx.parseWebhook(webhook('call.answered'))).toMatchObject({ type: 'answered', callId: 'v3:abc' });
    expect(telnyx.parseWebhook(webhook('call.hangup', { hangup_cause: 'normal_clearing' }))).toMatchObject({ type: 'hangup', status: 'ended' });
    expect(telnyx.parseWebhook(webhook('call.hangup', { hangup_cause: 'user_busy' }))).toMatchObject({ type: 'hangup', status: 'busy' });
    expect(telnyx.parseWebhook(webhook('call.hangup', { hangup_cause: 'timeout' }))).toMatchObject({ type: 'hangup', status: 'no-answer' });
    expect(telnyx.parseWebhook(webhook('call.dtmf.received', { digit: '1' }))).toMatchObject({ type: 'other', callId: 'v3:abc' });
    // The old, flat shape names no call: nothing is acted on.
    expect(telnyx.parseWebhook({ call_control_id: 'v3:abc', event_type: 'call.initiated' })).toMatchObject({ type: 'other', callId: '' });
  });

  test('a final transcription is what the caller said; an interim one is not a turn', () => {
    const final = webhook('call.transcription', { transcription_data: { transcript: 'hello this is a test speech', is_final: true, confidence: 0.977219 } });
    expect(telnyx.parseWebhook(final)).toMatchObject({ type: 'speech', speech: 'hello this is a test speech' });
    const interim = webhook('call.transcription', { transcription_data: { transcript: 'hello this', is_final: false } });
    expect(telnyx.parseWebhook(interim)).toMatchObject({ type: 'other' });
    expect(telnyx.parseWebhook(webhook('call.transcription', { transcription_data: { transcript: ' ', is_final: true } }))).toMatchObject({ type: 'other' });
  });

  test('answering, rejecting and hanging up are Call Control commands; the webhook is only acknowledged', async () => {
    const calls = stubFetch();
    expect(await telnyx.acceptIncoming('v3:abc')).toBe(false); // call.answered follows
    expect(await telnyx.rejectIncoming('v3:abc')).toEqual({ contentType: 'application/json', body: '{}' });
    await telnyx.endCall('v3:abc');
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://api.telnyx.com/v2/calls/v3%3Aabc/actions/answer', {}],
      ['POST', 'https://api.telnyx.com/v2/calls/v3%3Aabc/actions/reject', { cause: 'CALL_REJECTED' }],
      ['POST', 'https://api.telnyx.com/v2/calls/v3%3Aabc/actions/hangup', {}],
    ]);
  });

  test('opening a conversation starts transcription of the caller, then speaks in the call language', async () => {
    const calls = stubFetch();
    const reply = await telnyx.instruct('v3:abc', { ...listen, opening: true });
    expect(reply).toEqual({ contentType: 'application/json', body: '{}' });
    expect(calls.map((c) => c.url.split('/actions/')[1])).toEqual(['transcription_start', 'speak']);
    expect(calls[0].body).toEqual({ transcription_engine: 'Google', transcription_engine_config: { language: 'de' }, transcription_tracks: 'inbound' });
    expect(calls[1].body).toMatchObject({ payload: 'Hello & welcome', voice: 'AWS.Polly.Vicki', language: 'de-DE' });

    // Later turns only speak: transcription is already running.
    calls.length = 0;
    await telnyx.instruct('v3:abc', listen);
    expect(calls.map((c) => c.url.split('/actions/')[1])).toEqual(['speak']);
  });

  test("a line the install's engine spoke is played from its URL", async () => {
    const calls = stubFetch();
    await telnyx.instruct('v3:abc', { ...listen, say: { text: 'Hello', audioUrl: 'https://x.example/api/voice/webhook/audio/abc' } });
    expect(calls[0].url).toContain('/actions/playback_start');
    expect(calls[0].body).toMatchObject({ audio_url: 'https://x.example/api/voice/webhook/audio/abc', audio_type: 'mp3' });
  });

  test('what follows a line travels as client_state and comes back when the line has ended', async () => {
    const calls = stubFetch();
    await telnyx.instruct('v3:abc', { say: { text: 'Goodbye' }, then: 'hangup', locale: 'en-US' });
    const farewell = calls[0].body.client_state as string;
    await telnyx.instruct('v3:abc', listen);
    const line = calls[1].body.client_state as string;

    expect(telnyx.parseWebhook(webhook('call.speak.ended', { client_state: farewell }))).toMatchObject({ type: 'spoken', after: 'hangup' });
    expect(telnyx.parseWebhook(webhook('call.playback.ended', { client_state: farewell }))).toMatchObject({ type: 'spoken', after: 'hangup' });
    expect(telnyx.parseWebhook(webhook('call.speak.ended', { client_state: line }))).toMatchObject({ type: 'spoken', after: 'listen' });
    // A client_state that is not ours (or none) asks for nothing.
    expect(telnyx.parseWebhook(webhook('call.speak.ended', { client_state: 'aGF2ZSBhIG5pY2UgZGF5ID1d' })).after).toBeUndefined();
    expect(telnyx.parseWebhook(webhook('call.speak.ended')).after).toBeUndefined();
  });

  test('hanging up with nothing to say is the hangup command; a failed command fails loud', async () => {
    const calls = stubFetch();
    await telnyx.instruct('v3:abc', { then: 'hangup', locale: 'en-US' });
    expect(calls.map((c) => c.url.split('/actions/')[1])).toEqual(['hangup']);
    stubFetch(422);
    await expect(telnyx.instruct('v3:abc', listen)).rejects.toThrow(/Telnyx speak failed \(HTTP 422\)/);
    await expect(telnyx.instruct('v3:abc', { then: 'stream', streamUrl: 'wss://x', locale: 'en-US' })).rejects.toThrow(/media stream/);
  });
});
