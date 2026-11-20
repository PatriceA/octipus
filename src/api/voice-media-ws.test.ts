/**
 * The media socket of a streamed call, for each carrier: the token check,
 * the carrier's own frames in (recorded shapes from each carrier's docs, see
 * src/voice/telephony/media-wire.ts) and out, and the call's lifecycle. The
 * call itself (`PhoneMediaCall`) is a recorder here: what it hears and says
 * is media-call.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

interface FakeTransport { audio(frame: Uint8Array): void; clear(): void; mark(name: string): void }

const media = vi.hoisted(() => ({
  calls: [] as Array<{ pushed: string[]; reached: string[]; started: boolean; closed: boolean; transport: FakeTransport }>,
}));
vi.mock('@/voice/telephony/media-call', () => ({
  PhoneMediaCall: class {
    record: (typeof media.calls)[number];
    constructor(_options: unknown, _deps: unknown, transport: FakeTransport) {
      this.record = { pushed: [], reached: [], started: false, closed: false, transport };
      media.calls.push(this.record);
    }
    pushMedia(payload: string) { this.record.pushed.push(payload); }
    markReached(name: string) { this.record.reached.push(name); }
    async start() { this.record.started = true; }
    async close() { this.record.closed = true; }
  },
}));

/** Settings; `gate` holds every read until released (a slow call setup). */
const config = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('@/config/settings-service', () => ({
  getSettingsService: () => ({ get: async () => { await config.gate; return null; } }),
}));
vi.mock('@/voice/resolve', () => ({}));

const carrier = vi.hoisted(() => ({ ended: [] as string[] }));
vi.mock('@/voice/telephony', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/voice/telephony')>();
  return { ...real, getTelephonyProvider: async () => ({ endCall: async (id: string) => { carrier.ended.push(id); } }) };
});

const { consumeMediaStreamToken, endMediaStream, handleMediaFrame, mintMediaStreamToken, openMediaStream } = await import('./voice-media-ws');
const { getCallManager } = await import('@/voice/telephony');

function socket() {
  const sent: Array<Record<string, unknown>> = [];
  const closed: Array<number | undefined> = [];
  return { sent, closed, send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>); }, close: (code?: number) => { closed.push(code); } };
}

/** The call as the webhook registered it, before the carrier opens its stream. */
function registerCall(provider: string, providerCallId: string) {
  const id = `inbound-${providerCallId}`;
  getCallManager().create({
    id, provider, providerCallId, direction: 'inbound', from: '+15551112222', to: '+15550000000',
    status: 'active', startedAt: new Date(), metadata: { mode: 'conversation', conversationHistory: [] },
  });
  return id;
}

const PAYLOAD = Buffer.alloc(160, 0xff).toString('base64');

beforeEach(() => {
  media.calls.length = 0;
  carrier.ended.length = 0;
  config.gate = null;
});
afterEach(() => {
  for (const c of getCallManager().getActive()) getCallManager().updateStatus(c.id, 'ended');
});

describe('media stream token store', () => {
  test('a minted token validates exactly once (single-use)', () => {
    const tok = mintMediaStreamToken('CA_abc');
    expect(consumeMediaStreamToken(tok)).toBe(true);
    expect(consumeMediaStreamToken(tok)).toBe(false); // replay rejected
  });

  test('unknown / null tokens are rejected', () => {
    expect(consumeMediaStreamToken('never-minted')).toBe(false);
    expect(consumeMediaStreamToken(null)).toBe(false);
    expect(consumeMediaStreamToken('')).toBe(false);
  });

  test('distinct calls mint distinct tokens', () => {
    const a = mintMediaStreamToken('CA_1');
    const b = mintMediaStreamToken('CA_2');
    expect(a).not.toBe(b);
    expect(consumeMediaStreamToken(a)).toBe(true);
    expect(consumeMediaStreamToken(b)).toBe(true);
  });

  test('a socket opens only with a valid token, for a carrier that streams', () => {
    expect(openMediaStream('twilio', 'never-minted')).toBeNull();
    expect(openMediaStream('acme', mintMediaStreamToken('X'))).toBeNull();
    expect(openMediaStream('telnyx', mintMediaStreamToken('v3:1'))).toMatchObject({ provider: 'telnyx', callSid: 'v3:1' });
  });
});

/** One carrier's frames, in the shapes its docs record. */
interface Fixture {
  provider: string;
  callId: string;
  frames: { connected?: unknown; start: unknown; media: unknown; mark: (name: string) => unknown; stop: unknown };
  out: { audio: Record<string, unknown>; clear: Record<string, unknown>; mark: (name: string) => Record<string, unknown> };
}

const fixtures: Fixture[] = [
  {
    provider: 'twilio',
    callId: 'CA0001',
    frames: {
      connected: { event: 'connected', protocol: 'Call', version: '1.0.0' },
      start: {
        event: 'start', sequenceNumber: '1', streamSid: 'MZ0001',
        start: { accountSid: 'AC1', streamSid: 'MZ0001', callSid: 'CA0001', tracks: ['inbound'], customParameters: {}, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } },
      },
      media: { event: 'media', sequenceNumber: '3', streamSid: 'MZ0001', media: { track: 'inbound', chunk: '1', timestamp: '5', payload: PAYLOAD } },
      mark: (name) => ({ event: 'mark', sequenceNumber: '4', streamSid: 'MZ0001', mark: { name } }),
      stop: { event: 'stop', sequenceNumber: '5', streamSid: 'MZ0001', stop: { accountSid: 'AC1', callSid: 'CA0001' } },
    },
    out: {
      audio: { event: 'media', streamSid: 'MZ0001', media: { payload: PAYLOAD } },
      clear: { event: 'clear', streamSid: 'MZ0001' },
      mark: (name) => ({ event: 'mark', streamSid: 'MZ0001', mark: { name } }),
    },
  },
  {
    provider: 'telnyx',
    callId: 'v3:telnyx-call-1',
    frames: {
      connected: { event: 'connected', version: '1.0.0' },
      start: {
        event: 'start', sequence_number: '1', stream_id: 'telnyx-stream-1',
        start: { user_id: 'u1', call_control_id: 'v3:telnyx-call-1', call_session_id: 's1', from: '+15551112222', to: '+15550000000', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } },
      },
      media: { event: 'media', sequence_number: '4', stream_id: 'telnyx-stream-1', media: { track: 'inbound', chunk: '2', timestamp: '5', payload: PAYLOAD } },
      mark: (name) => ({ event: 'mark', sequence_number: '5', stream_id: 'telnyx-stream-1', mark: { name } }),
      stop: { event: 'stop', sequence_number: '6', stream_id: 'telnyx-stream-1', stop: { user_id: 'u1', call_control_id: 'v3:telnyx-call-1' } },
    },
    out: {
      audio: { event: 'media', media: { payload: PAYLOAD } },
      clear: { event: 'clear' },
      mark: (name) => ({ event: 'mark', mark: { name } }),
    },
  },
  {
    provider: 'plivo',
    callId: 'plivo-call-uuid-1',
    frames: {
      start: {
        event: 'start', sequenceNumber: 1,
        start: { callId: 'plivo-call-uuid-1', streamId: 'plivo-stream-1', accountId: 'MA1', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } },
      },
      media: { event: 'media', sequenceNumber: 3, streamId: 'plivo-stream-1', media: { track: 'inbound', timestamp: '1705312200000', chunk: 41, payload: PAYLOAD } },
      mark: (name) => ({ event: 'playedStream', sequenceNumber: 4, streamId: 'plivo-stream-1', name }),
      stop: { event: 'stop', sequenceNumber: 5, streamId: 'plivo-stream-1' },
    },
    out: {
      audio: { event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: PAYLOAD } },
      clear: { event: 'clearAudio', streamId: 'plivo-stream-1' },
      mark: (name) => ({ event: 'checkpoint', streamId: 'plivo-stream-1', name }),
    },
  },
];

describe.each(fixtures)('$provider media stream', (fixture) => {
  test('start → media → reply → barge-in clear → mark → stop', async () => {
    const callId = registerCall(fixture.provider, fixture.callId);
    const ws = socket();
    const st = openMediaStream(fixture.provider, mintMediaStreamToken(fixture.callId));
    if (!st) throw new Error('stream refused');
    if (fixture.frames.connected) await handleMediaFrame(ws, st, JSON.stringify(fixture.frames.connected));
    await handleMediaFrame(ws, st, JSON.stringify(fixture.frames.start));
    const [call] = media.calls;
    expect(call.started).toBe(true);
    expect(getCallManager().get(callId)).toMatchObject({ status: 'active', metadata: { streaming: true } });

    await handleMediaFrame(ws, st, JSON.stringify(fixture.frames.media));
    expect(call.pushed).toEqual([PAYLOAD]);

    // The reply goes out in the carrier's format; the caller talks over it.
    call.transport.audio(Buffer.from(PAYLOAD, 'base64'));
    call.transport.mark('reply-1');
    call.transport.clear();
    expect(ws.sent).toEqual([fixture.out.audio, fixture.out.mark('reply-1'), fixture.out.clear]);

    await handleMediaFrame(ws, st, JSON.stringify(fixture.frames.mark('reply-1')));
    expect(call.reached).toEqual(['reply-1']);

    await handleMediaFrame(ws, st, JSON.stringify(fixture.frames.stop));
    expect(call.closed).toBe(true);
    expect(getCallManager().get(callId)?.status).toBe('ended');
    // The carrier stopped the stream: the call is ending on its side already.
    expect(carrier.ended).toEqual([]);
  });

  test('a stream for another call than its token is closed and starts nothing', async () => {
    const ws = socket();
    const st = openMediaStream(fixture.provider, mintMediaStreamToken('some-other-call'));
    if (!st) throw new Error('stream refused');
    await handleMediaFrame(ws, st, JSON.stringify(fixture.frames.start));
    expect(ws.closed).toEqual([4003]);
    expect(media.calls).toEqual([]);
  });
});

describe('the end of a stream', () => {
  test('a stream that ends while the call is being set up leaves the call ended, not active', async () => {
    const callId = registerCall('twilio', 'CA-race');
    const ws = socket();
    const st = openMediaStream('twilio', mintMediaStreamToken('CA-race'));
    if (!st) throw new Error('stream refused');
    let release = () => {};
    config.gate = new Promise<void>((resolve) => { release = resolve; });
    const starting = handleMediaFrame(ws, st, JSON.stringify({ event: 'start', start: { callSid: 'CA-race', streamSid: 'MZ-race' } }));
    // The carrier stops the stream before the setup has read its settings.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handleMediaFrame(ws, st, JSON.stringify({ event: 'stop', streamSid: 'MZ-race' }));
    release();
    await starting;
    expect(getCallManager().get(callId)?.status).toBe('ended');
    expect(media.calls.every((c) => !c.started)).toBe(true);
  });

  test('a stream that ends at once, before the call has even been looked up, leaves the call ended', async () => {
    const callId = registerCall('plivo', 'plivo-race');
    const ws = socket();
    const st = openMediaStream('plivo', mintMediaStreamToken('plivo-race'));
    if (!st) throw new Error('stream refused');
    const starting = handleMediaFrame(ws, st, JSON.stringify({ event: 'start', start: { callId: 'plivo-race', streamId: 'ps' } }));
    const stopping = handleMediaFrame(ws, st, JSON.stringify({ event: 'stop' }));
    await Promise.all([starting, stopping]);
    expect(getCallManager().get(callId)?.status).toBe('ended');
    expect(media.calls).toEqual([]);
  });

  test('a socket that goes away without the carrier stopping it hangs the call up at the carrier', async () => {
    const callId = registerCall('telnyx', 'v3:dropped');
    const ws = socket();
    const st = openMediaStream('telnyx', mintMediaStreamToken('v3:dropped'));
    if (!st) throw new Error('stream refused');
    await handleMediaFrame(ws, st, JSON.stringify({ event: 'start', stream_id: 's', start: { call_control_id: 'v3:dropped' } }));
    await endMediaStream(st);
    expect(getCallManager().get(callId)?.status).toBe('ended');
    expect(carrier.ended).toEqual(['v3:dropped']);
  });
});
