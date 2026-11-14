/**
 * Speech through the lanes (src/voice/resolve.ts): primary then backup, old
 * engine names as aliases, local-only for accounts without the install's
 * keys, protection levels, usage recorded per call.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';

const state = vi.hoisted(() => ({
  primary: null as unknown,
  backup: null as unknown,
  named: {} as Record<string, unknown>,
  available: {} as Record<string, boolean>,
  transcribe: {} as Record<string, () => Promise<unknown>>,
  synthesize: vi.fn(async () => Buffer.from('audio')),
  usage: vi.fn(async () => {}),
  mayLeave: vi.fn(async () => {}),
  voices: [] as Array<string | undefined>,
}));

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getModelForTopic: async () => state.primary,
    getBackupModelForTopic: async () => state.backup,
    getModel: async (name: string) => state.named[name] ?? null,
  }),
}));
vi.mock('@/models/providers/instrumented', () => ({ recordProviderUsage: state.usage }));
vi.mock('@/core/protection/routing', () => {
  class ProtectionRoutingError extends Error {}
  return { assertMayLeave: state.mayLeave, ProtectionRoutingError, runsLocally: async (r: { provider: string }) => r.provider === 'local-audio' };
});
vi.mock('@/config', () => ({ getConfig: () => ({ voice: { ttsVoice: 'configured-voice' } }) }));
// The clip's length (ffprobe), never the engine's processing time.
vi.mock('./ffmpeg', () => ({ probeBufferSeconds: async () => 42 }));
vi.mock('./speech-rows', async (orig) => {
  const real = await orig<typeof import('./speech-rows')>();
  return {
    ...real,
    speechRowAvailable: async (row: { name: string }) => (state.available[row.name] === false ? { ok: false, reason: 'not installed' } : { ok: true }),
    sttEngineFor: async (row: { name: string }) => ({
      transcribe: async () => state.transcribe[row.name](),
      streamTranscribe: async function* () {},
      dispose: async () => {},
    }),
    ttsEngineFor: async (_row: unknown, opts: { voice?: string }) => (state.voices.push(opts.voice), { synthesize: state.synthesize, streamSynthesize: async function* () {}, getVoices: async () => [], dispose: async () => {} }),
  };
});

const resolve = await import('./resolve');

const row = (name: string, provider: string, modelId: string, lane: string, role: 'primary' | 'backup' = 'primary') =>
  ({ id: name, name, provider, modelId, topicRoles: { [lane]: role }, metadata: {} }) as unknown as ModelConfigEntry;

const ok = (text: string) => async () => ({ text, segments: [], language: 'en', duration: 3 });

beforeEach(() => {
  state.primary = null; state.backup = null; state.named = {}; state.available = {}; state.transcribe = {}; state.voices = [];
  vi.clearAllMocks();
});

describe('speech resolution', () => {
  test('nothing bound: not configured (a typed error), not a crash', async () => {
    await expect(resolve.transcribeWithLane(Buffer.from('x'))).rejects.toMatchObject({ code: 'capability_not_configured', capability: 'hear' });
    await expect(resolve.synthesizeWithLane('hi')).rejects.toMatchObject({ code: 'capability_not_configured', capability: 'speak' });
    await expect(resolve.speechStatus('stt')).resolves.toMatchObject({ available: false });
  });

  test('primary runs; a primary that cannot run or fails falls to the backup; usage is recorded on the row that worked', async () => {
    state.primary = row('local fw', 'local-audio', 'faster-whisper:small', 'transcription');
    state.backup = row('mistral stt', 'mistral', 'voxtral-mini-latest', 'transcription', 'backup');
    state.transcribe = { 'local fw': ok('from local'), 'mistral stt': ok('from cloud') };
    await expect(resolve.transcribeWithLane(Buffer.from('x'))).resolves.toMatchObject({ text: 'from local', model: 'local fw' });

    state.available['local fw'] = false;
    await expect(resolve.transcribeWithLane(Buffer.from('x'))).resolves.toMatchObject({ text: 'from cloud', model: 'mistral stt' });

    state.available['local fw'] = true;
    state.transcribe['local fw'] = async () => { throw new Error('binary crashed'); };
    await expect(resolve.transcribeWithLane(Buffer.from('x'))).resolves.toMatchObject({ model: 'mistral stt' });
    expect(state.usage).toHaveBeenCalledWith(expect.objectContaining({ requestType: 'transcription', modelConfigName: 'mistral stt', accountingMetadata: { seconds: 42 } }), 'mistral', expect.anything(), false);
    expect(state.usage).toHaveBeenCalledWith(expect.objectContaining({ modelConfigName: 'local fw' }), 'local-audio', expect.anything(), true);
  });

  test('a cloud engine passes the protection check; a local one never needs it', async () => {
    state.primary = row('local fw', 'local-audio', 'faster-whisper:small', 'transcription');
    state.transcribe = { 'local fw': ok('x') };
    await resolve.transcribeWithLane(Buffer.from('x'), { sessionId: 's' });
    expect(state.mayLeave).not.toHaveBeenCalled();
    state.primary = row('mistral stt', 'mistral', 'voxtral-mini-latest', 'transcription');
    state.transcribe = { 'mistral stt': ok('x') };
    const { ProtectionRoutingError } = await import('@/core/protection/routing');
    state.mayLeave.mockRejectedValue(new (ProtectionRoutingError as unknown as new (m: string) => Error)('level 4 stays local'));
    await expect(resolve.transcribeWithLane(Buffer.from('x'), { sessionId: 's' })).rejects.toThrow(/stays local/);
    state.mayLeave.mockReset();
  });

  test('a cloud primary the content may not reach falls to the local backup instead of failing', async () => {
    state.primary = row('mistral stt', 'mistral', 'voxtral-mini-latest', 'transcription');
    state.backup = row('local fw', 'local-audio', 'faster-whisper:small', 'transcription', 'backup');
    state.transcribe = { 'mistral stt': ok('cloud'), 'local fw': ok('local') };
    const { ProtectionRoutingError } = await import('@/core/protection/routing');
    state.mayLeave.mockRejectedValue(new (ProtectionRoutingError as unknown as new (m: string) => Error)('level 4 stays local'));
    await expect(resolve.transcribeWithLane(Buffer.from('x'), { sessionId: 's' })).resolves.toMatchObject({ text: 'local', model: 'local fw' });
    await expect(resolve.resolveSttEngine({ sessionId: 's' })).resolves.toMatchObject({ row: expect.objectContaining({ name: 'local fw' }) });
    // Any other error from the check is a bug, not a routing decision: it is not swallowed.
    state.mayLeave.mockRejectedValue(new Error('database down'));
    await expect(resolve.transcribeWithLane(Buffer.from('x'), { sessionId: 's' })).rejects.toThrow(/database down/);
    state.mayLeave.mockReset();
  });

  test('a row named directly must be an install speech engine of that direction', async () => {
    state.named['local kokoro'] = row('local kokoro', 'local-audio', 'kokoro:af_sarah', 'speech');
    state.named['mine'] = { ...row('mine', 'local-audio', 'whisper.cpp:base', 'transcription'), ownerUserId: 'u1' };
    state.named['mistral chat'] = row('mistral chat', 'mistral', 'mistral-large-latest', 'default');
    await expect(resolve.speechCandidates('stt', { override: 'local kokoro' })).rejects.toThrow(/not a speech-to-text engine/);
    await expect(resolve.speechCandidates('stt', { override: 'mine' })).rejects.toThrow(/not a speech-to-text engine/);
    await expect(resolve.speechCandidates('tts', { override: 'mistral chat' })).rejects.toThrow(/not a text-to-speech engine/);
    expect((await resolve.speechCandidates('tts', { override: 'local kokoro' })).map((r) => r.name)).toEqual(['local kokoro']);
  });

  test('the configured voice is the lane primary\'s alone; a voice asked for goes to the engine asked for', async () => {
    // The cloud primary filtered out (local only): Kokoro is tried first but is not the primary.
    state.primary = row('mistral tts', 'mistral', 'voxtral-mini-tts-2603', 'speech');
    state.backup = row('local kokoro', 'local-audio', 'kokoro:af_sarah', 'speech', 'backup');
    await resolve.synthesizeWithLane('hi', { override: 'local' });
    expect(state.voices).toEqual([undefined]);
    state.voices = [];
    await resolve.synthesizeWithLane('hi', { override: 'local', voice: 'af_bella' });
    expect(state.voices).toEqual(['af_bella']);
    state.voices = [];
  });

  test('the configured voice goes to the primary; a backup speaks in its own voice', async () => {
    state.primary = row('mistral tts', 'mistral', 'voxtral-mini-tts-2603', 'speech');
    state.backup = row('local kokoro', 'local-audio', 'kokoro:af_sarah', 'speech', 'backup');
    state.available['mistral tts'] = false;
    await resolve.synthesizeWithLane('hi');
    expect(state.voices).toEqual([undefined]);
    state.available['mistral tts'] = true;
    state.voices = [];
    await resolve.synthesizeWithLane('hi');
    expect(state.voices).toEqual(['configured-voice']);
  });

  test('old engine names pick the bound row of that engine; a row may be named directly', async () => {
    state.primary = row('local fw', 'local-audio', 'faster-whisper:small', 'transcription');
    state.backup = row('openai stt', 'openai', 'gpt-4o-transcribe', 'transcription', 'backup');
    expect((await resolve.speechCandidates('stt', { override: 'openai' })).map((r) => r.name)).toEqual(['openai stt']);
    expect((await resolve.speechCandidates('stt', { override: 'whisper-1' })).map((r) => r.name)).toEqual(['openai stt']);
    expect((await resolve.speechCandidates('stt', { override: 'local' })).map((r) => r.name)).toEqual(['local fw']);
    expect((await resolve.speechCandidates('stt', { override: 'auto' })).map((r) => r.name)).toEqual(['local fw', 'openai stt']);
    await expect(resolve.speechCandidates('stt', { override: 'mistral' })).rejects.toThrow(/No mistral engine is bound/);
    state.named['my whisper'] = row('my whisper', 'local-audio', 'whisper.cpp:base', 'transcription');
    expect((await resolve.speechCandidates('stt', { override: 'my whisper' })).map((r) => r.name)).toEqual(['my whisper']);
    await expect(resolve.speechCandidates('stt', { override: 'gpt-5' })).rejects.toThrow(/not a speech-to-text engine/);
  });

  test('an account that may not use the install\'s hosted keys gets local engines only', async () => {
    state.primary = row('openai stt', 'openai', 'gpt-4o-transcribe', 'transcription');
    state.transcribe = { 'openai stt': ok('x') };
    await expect(resolve.transcribeWithLane(Buffer.from('x'), { allowHosted: false })).rejects.toThrow(/may not use/);
  });

  test('speak: the format must be one the engine writes when the caller insists', async () => {
    state.primary = row('local kokoro', 'local-audio', 'kokoro:af_sarah', 'speech');
    await expect(resolve.synthesizeWithLane('hi', { format: 'mp3' })).resolves.toMatchObject({ format: 'wav', contentType: 'audio/wav', model: 'local kokoro' });
    await expect(resolve.synthesizeWithLane('hi', { format: 'mp3', strictFormat: true })).rejects.toThrow(/writes wav only/);
    expect(state.usage).toHaveBeenCalledWith(expect.objectContaining({ requestType: 'speech', accountingMetadata: { characters: 2 } }), 'local-audio', expect.anything(), false);
  });
});

describe('speech cost', () => {
  test('per minute of audio for transcription and per million characters for speech; local or free costs nothing; unknown is unknown', async () => {
    const cloud = row('openai stt', 'openai', 'gpt-4o-transcribe', 'transcription');
    await expect(resolve.speechCost(cloud, 'transcription', { seconds: 3600 })).resolves.toBeCloseTo(0.36);
    await expect(resolve.speechCost(cloud, 'transcription', {})).resolves.toBeUndefined();
    const priced = { ...row('mine', 'mistral', 'voxtral-mini-tts-2603', 'speech'), metadata: { pricing: { perMillionChars: 20 } } } as never;
    await expect(resolve.speechCost(priced, 'speech', { characters: 500_000 })).resolves.toBeCloseTo(10);
    await expect(resolve.speechCost(row('local fw', 'local-audio', 'faster-whisper:small', 'transcription'), 'transcription', { seconds: 60 })).resolves.toBe(0);
    const free = { ...cloud, metadata: { pricing: { free: true } } } as never;
    await expect(resolve.speechCost(free, 'transcription', { seconds: 60 })).resolves.toBe(0);
  });
});
