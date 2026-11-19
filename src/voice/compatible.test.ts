/**
 * Speech on an OpenAI-compatible server (src/voice/compatible.ts), against a
 * real HTTP server on a loopback port: the requests it gets are what a
 * Speaches / vLLM-Omni / NeMo-Speech server would get.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';
import { CompatibleSTTEngine, CompatibleTTSEngine, speechEndpointOf, speechRequestBody } from './compatible';
import { speechConfigOf, speechHintsFor } from './speech-hints';
import { engineKindOf, speechDirectionOf, speechFormats } from './speech-rows';
import { pcmToWav } from './wav';

vi.mock('@/services/provider-service', () => ({
  resolveCustomApiKey: async (ref: string) => (ref === 'missing' ? null : `key-of-${ref}`),
}));

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
const seen: Seen[] = [];
let respond: (req: Seen) => { status?: number; type?: string; body: Buffer | string | Array<Buffer | string> } = () => ({ body: '{}' });
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const got: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(got);
      const out = respond(got);
      res.writeHead(out.status ?? 200, { 'Content-Type': out.type ?? 'application/json' });
      for (const part of Array.isArray(out.body) ? out.body : [out.body]) res.write(part);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { seen.length = 0; respond = () => ({ body: '{}' }); });

const row = (modelId: string, extra: Partial<ModelConfigEntry> = {}) =>
  ({ name: modelId, provider: 'custom-openai', modelId, endpoint: base, apiKeyRef: null, metadata: {}, ...extra }) as unknown as ModelConfigEntry;

describe('which rows are speech engines', () => {
  test('a row with its own endpoint is an OpenAI-compatible speech server; its direction is declared or known from the model', () => {
    expect(engineKindOf(row('openai/whisper-large-v3-turbo'))).toBe('compatible');
    expect(engineKindOf({ provider: 'openai', modelId: 'whisper-1', endpoint: 'https://my.proxy' })).toBe('compatible');
    expect(engineKindOf({ provider: 'openai', modelId: 'gpt-4o-transcribe' })).toBe('openai');
    expect(engineKindOf({ provider: 'anthropic', modelId: 'claude', endpoint: 'https://x' })).toBeUndefined();

    expect(speechDirectionOf(row('openai/whisper-large-v3-turbo'))).toBe('stt');
    expect(speechDirectionOf(row('nvidia/nemotron-3.5-asr-streaming-0.6b'))).toBe('stt');
    expect(speechDirectionOf(row('openbmb/VoxCPM2'))).toBe('tts');
    expect(speechDirectionOf(row('BreezeBlue/Breeze-TTS-2'))).toBe('tts');
    // A chat model on the same server is not a speech engine, unless the row says so.
    expect(speechDirectionOf(row('meta/llama-3.3-70b'))).toBeUndefined();
    expect(speechDirectionOf(row('my-finetune', { metadata: { speech: { direction: 'tts' } } }))).toBe('tts');
  });

  test('what a model is known for is the default; the row overrides it', () => {
    expect(speechHintsFor('openbmb/VoxCPM2')).toMatchObject({ instructions: 'prefix', cloning: true, sampleRate: 48000, streams: true });
    expect(speechHintsFor('BreezeBlue/Breeze-TTS-2')).toMatchObject({ instructions: 'field', sampleRate: 24000 });
    expect(speechHintsFor('nvidia/nemotron-3.5-asr-streaming-0.6b')).toMatchObject({ upload: 'wav', realtime: { protocol: 'nemo' } });
    expect(speechHintsFor('something-else')).toEqual({});
    expect(speechConfigOf(row('openbmb/VoxCPM2', { metadata: { speech: { sampleRate: 24000, streams: false } } }))).toMatchObject({ instructions: 'prefix', sampleRate: 24000, streams: false });
    expect(speechFormats(row('openbmb/VoxCPM2'))).toEqual(['wav', 'pcm']);
    expect(speechFormats(row('some/tts'))[0]).toBe('wav');
  });
});

describe('the endpoint of a row', () => {
  test('/v1 is added when the URL has none; the key and its scheme come from the row; a named key that is not set fails loud', async () => {
    await expect(speechEndpointOf(row('m', { endpoint: 'http://host:8000/' }))).resolves.toEqual({ baseUrl: 'http://host:8000/v1', headers: {}, query: {} });
    await expect(speechEndpointOf(row('m', { endpoint: 'https://api.groq.com/openai/v1', apiKeyRef: 'groq' }))).resolves.toEqual({
      baseUrl: 'https://api.groq.com/openai/v1', headers: { Authorization: 'Bearer key-of-groq' }, query: {},
    });
    const header = row('m', { apiKeyRef: 'k', metadata: { customProvider: { auth: { type: 'header', headerName: 'x-api-key' }, extraHeaders: { 'x-team': 'a' } } } });
    await expect(speechEndpointOf(header)).resolves.toMatchObject({ headers: { 'x-api-key': 'key-of-k', 'x-team': 'a' } });
    await expect(speechEndpointOf(row('m', { apiKeyRef: 'missing' }))).rejects.toThrow(/key "missing" of model "m" is not set/);
    await expect(speechEndpointOf(row('m', { endpoint: null }))).rejects.toThrow(/no endpoint URL/);
  });
});

describe('speech to text', () => {
  test('a clip is posted as multipart with the model and language; segment times come back', async () => {
    respond = () => ({ body: JSON.stringify({ text: ' Hello there. ', language: 'en', segments: [{ start: 0, end: 1.2, text: ' Hello there.' }] }) });
    const r = row('openai/whisper-large-v3-turbo', { apiKeyRef: 'k' });
    const engine = new CompatibleSTTEngine(await speechEndpointOf(r), r.modelId, speechConfigOf(r), { language: 'en' });
    await expect(engine.transcribe(Buffer.from('not really audio'))).resolves.toMatchObject({
      text: 'Hello there.', language: 'en', segments: [{ start: 0, end: 1.2, text: 'Hello there.' }],
    });
    expect(seen[0].url).toBe('/v1/audio/transcriptions');
    expect(seen[0].headers.authorization).toBe('Bearer key-of-k');
    expect(seen[0].headers['content-type']).toMatch(/^multipart\/form-data/);
    const form = seen[0].body.toString('latin1');
    expect(form).toContain('openai/whisper-large-v3-turbo');
    expect(form).toContain('verbose_json');
    expect(form).toMatch(/name="language"\r\n\r\nen/);
  });

  test('a server without verbose_json is asked again for json; any other refusal is the error', async () => {
    respond = (req) => (req.body.includes('verbose_json')
      ? { status: 400, body: '{"error":"response_format verbose_json is not supported"}' }
      : { body: '{"text":"plain"}' });
    const r = row('some/asr-model');
    const engine = new CompatibleSTTEngine(await speechEndpointOf(r), r.modelId, speechConfigOf(r), { language: 'auto' });
    await expect(engine.transcribe(Buffer.from('x'))).resolves.toMatchObject({ text: 'plain' });
    expect(seen).toHaveLength(2);
    // "auto" means the model detects the language: no language field is sent.
    expect(seen[1].body.toString('latin1')).not.toContain('name="language"');

    respond = () => ({ status: 400, body: '{"error":"unknown_model"}' });
    await expect(engine.transcribe(Buffer.from('x'))).rejects.toThrow(/Transcription failed \(400\).*unknown_model/);
  });

  test('live audio without a realtime socket is sent in windows, each a 16 kHz WAV', async () => {
    let n = 0;
    respond = () => ({ body: JSON.stringify({ text: `window ${++n}` }) });
    const r = row('openai/whisper-large-v3-turbo');
    const engine = new CompatibleSTTEngine(await speechEndpointOf(r), r.modelId, speechConfigOf(r), { streamWindowSeconds: 1 });
    expect(engine.live).toBe(false);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(32000)); c.enqueue(new Uint8Array(16000)); c.close(); },
    });
    const out: string[] = [];
    for await (const text of engine.streamTranscribe(stream)) out.push(text);
    expect(out).toEqual(['window 1', 'window 2']);
    expect(seen[0].body.includes(Buffer.from('RIFF'))).toBe(true);
  });
});

describe('text to speech', () => {
  test('the request carries what the model takes: a description as a field or a prefix, a reference clip, speed, the row\'s extra fields', () => {
    const clip = { data: Buffer.from('clip'), mimeType: 'audio/wav' };
    // VoxCPM: the description is a parenthesised prefix; no speed.
    expect(speechRequestBody('openbmb/VoxCPM2', { ...speechHintsFor('openbmb/VoxCPM2'), extraBody: { cfg_value: 2 } },
      { instructions: 'A young woman (gentle)', refAudio: clip, refText: 'said this', speed: 1.5 }, 'Hello.', 'wav')).toEqual({
      model: 'openbmb/VoxCPM2', input: '(A young woman  gentle)Hello.', voice: 'default', response_format: 'wav', cfg_value: 2,
      ref_audio: `data:audio/wav;base64,${clip.data.toString('base64')}`, ref_text: 'said this',
    });
    // Breeze-TTS: `instructions` is a field, the voice a speaker tag.
    expect(speechRequestBody('BreezeBlue/Breeze-TTS-2', speechHintsFor('BreezeBlue/Breeze-TTS-2'), { voice: 'S3', instructions: 'warm, slow' }, 'Hi', 'pcm')).toEqual({
      model: 'BreezeBlue/Breeze-TTS-2', input: 'Hi', voice: 'S3', response_format: 'pcm', instructions: 'warm, slow',
    });
    // An unknown model: the plain OpenAI request, with speed.
    expect(speechRequestBody('some/tts', {}, { voice: 'nova', speed: 1.25 }, 'Hi', 'mp3')).toEqual({ model: 'some/tts', input: 'Hi', voice: 'nova', response_format: 'mp3', speed: 1.25 });
  });

  test('a clip is the response body; a server error is the error', async () => {
    respond = () => ({ type: 'audio/wav', body: pcmToWav(new Uint8Array(4), 48000) });
    const r = row('openbmb/VoxCPM2');
    const engine = new CompatibleTTSEngine(await speechEndpointOf(r), r.modelId, speechConfigOf(r), { outputFormat: 'wav', instructions: 'a pirate' });
    expect((await engine.synthesize('Ahoy.')).subarray(0, 4).toString()).toBe('RIFF');
    expect(JSON.parse(seen[0].body.toString())).toMatchObject({ model: 'openbmb/VoxCPM2', input: '(a pirate)Ahoy.', response_format: 'wav' });
    expect(seen[0].url).toBe('/v1/audio/speech');

    respond = () => ({ status: 503, body: 'model is loading' });
    await expect(engine.synthesize('x')).rejects.toThrow(/Speech synthesis failed \(503\): model is loading/);
  });

  test('a streaming server is read as it generates: raw PCM, or server-sent audio deltas; a split sample is never played', async () => {
    const r = row('openbmb/VoxCPM2');
    const engine = new CompatibleTTSEngine(await speechEndpointOf(r), r.modelId, speechConfigOf(r), {});
    expect(engine.pcmSampleRate).toBe(48000);
    const collect = async () => { const parts: Buffer[] = []; for await (const c of engine.streamPcm!('hi')) parts.push(c); return Buffer.concat(parts); };

    respond = () => ({ type: 'audio/pcm', body: [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])] });
    expect([...await collect()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.parse(seen[0].body.toString())).toMatchObject({ stream: true, response_format: 'pcm' });

    const delta = (bytes: number[]) => `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: Buffer.from(bytes).toString('base64') })}\n\n`;
    respond = () => ({ type: 'text/event-stream', body: [delta([7, 8]), ': keep-alive\n\n', delta([9, 10]), 'data: [DONE]\n\n'] });
    expect([...await collect()]).toEqual([7, 8, 9, 10]);

    respond = () => ({ type: 'text/event-stream', body: `data: ${JSON.stringify({ error: { message: 'out of memory' } })}\n\n` });
    await expect(collect()).rejects.toThrow(/out of memory/);

    // A model that does not stream has no PCM stream: the caller reads its WAV instead.
    const plain = row('some/tts');
    expect(new CompatibleTTSEngine(await speechEndpointOf(plain), plain.modelId, speechConfigOf(plain), {}).streamPcm).toBeUndefined();
  });

  test('a server that is not there is named, with the reason', async () => {
    // A port nothing listens on: taken, then released.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const gone = row('some/tts', { endpoint: `http://127.0.0.1:${port}` });
    const engine = new CompatibleTTSEngine(await speechEndpointOf(gone), gone.modelId, speechConfigOf(gone), {});
    await expect(engine.synthesize('hi')).rejects.toThrow(new RegExp(`speech server at 127\\.0\\.0\\.1:${port} could not be reached: ECONNREFUSED`));
  });

  test('voices: the row\'s list, else what the server lists, else none', async () => {
    const breeze = row('BreezeBlue/Breeze-TTS-2');
    expect(await new CompatibleTTSEngine(await speechEndpointOf(breeze), breeze.modelId, speechConfigOf(breeze), {}).getVoices()).toContain('S0');
    const other = row('some/tts');
    const engine = new CompatibleTTSEngine(await speechEndpointOf(other), other.modelId, speechConfigOf(other), {});
    respond = () => ({ body: JSON.stringify({ voices: [{ id: 'anna' }, 'ben'] }) });
    expect(await engine.getVoices()).toEqual(['anna', 'ben']);
    respond = () => ({ status: 404, body: 'not found' });
    expect(await engine.getVoices()).toEqual([]);
  });
});
