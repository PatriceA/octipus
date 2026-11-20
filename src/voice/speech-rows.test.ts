/**
 * Speech rows (src/voice/speech-rows.ts): which way a row works, audio file
 * names from MIME types, and binding an engine to its lane.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, { name: string; topicRoles?: Record<string, string>; metadata?: Record<string, unknown> }>,
}));

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getModel: async (name: string) => state.rows[name] ?? null,
    registerModel: async (row: { name: string }) => (state.rows[row.name] = { ...row, topicRoles: {} }),
    updateModel: async (name: string, patch: Record<string, unknown>) => (state.rows[name] = { ...state.rows[name], ...patch } as never),
    getModelForTopic: async (lane: string) => Object.values(state.rows).find((r) => r.topicRoles?.[lane] === 'primary') ?? null,
    getBackupModelForTopic: async (lane: string) => Object.values(state.rows).find((r) => r.topicRoles?.[lane] === 'backup') ?? null,
  }),
}));

vi.mock('./whisper', () => ({ probeWhisper: async () => ({ binaryOk: true, modelOk: true }) }));
vi.mock('@/utils/proc', async (orig) => ({ ...(await orig<typeof import('@/utils/proc')>()), whichSync: () => '/usr/bin/ffmpeg' }));

const { audioExtensionFor, mergeSpeechSettings, realtimeUrlProblem, speechDirectionOf, speechRowAvailable, useSpeechEngine, useSpeechServer } = await import('./speech-rows');
const { liveRealtime, speechConfigOf } = await import('./speech-hints');

beforeEach(() => { state.rows = {}; });

describe('speech rows', () => {
  test('direction: local engines by kind, cloud rows by model id; a chat model is no speech engine', () => {
    expect(speechDirectionOf({ provider: 'local-audio', modelId: 'whisper.cpp:base' })).toBe('stt');
    expect(speechDirectionOf({ provider: 'local-audio', modelId: 'kokoro:af_sarah' })).toBe('tts');
    expect(speechDirectionOf({ provider: 'openai', modelId: 'gpt-4o-transcribe' })).toBe('stt');
    expect(speechDirectionOf({ provider: 'openai', modelId: 'gpt-4o-mini-tts' })).toBe('tts');
    expect(speechDirectionOf({ provider: 'mistral', modelId: 'voxtral-mini-latest' })).toBe('stt');
    expect(speechDirectionOf({ provider: 'mistral', modelId: 'voxtral-mini-tts-2603' })).toBe('tts');
    expect(speechDirectionOf({ provider: 'mistral', modelId: 'mistral-large-latest' })).toBeUndefined();
    expect(speechDirectionOf({ provider: 'anthropic', modelId: 'claude-sonnet-5-5' })).toBeUndefined();
  });

  test('audio extensions: the name a cloud API and ffmpeg read the container from', () => {
    expect(audioExtensionFor('audio/mpeg')).toBe('mp3');
    expect(audioExtensionFor('audio/x-m4a')).toBe('m4a');
    expect(audioExtensionFor('audio/mp4')).toBe('m4a');
    expect(audioExtensionFor('audio/x-wav')).toBe('wav');
    expect(audioExtensionFor('audio/vnd.wave')).toBe('wav');
    expect(audioExtensionFor('audio/ogg; codecs=opus')).toBe('ogg');
    expect(audioExtensionFor('audio/webm')).toBe('webm');
    expect(audioExtensionFor(undefined)).toBe('ogg');
  });

  test('use an engine: bound when the lane is free, never over a choice unless asked; one backup', async () => {
    await expect(useSpeechEngine('kokoro', 'tts')).resolves.toMatchObject({ bound: 'primary', lane: 'speech' });
    await expect(useSpeechEngine('kokoro', 'tts')).resolves.toMatchObject({ bound: 'already-bound' });
    await expect(useSpeechEngine('piper', 'tts')).resolves.toMatchObject({ bound: 'not-bound' });
    // Piper over Kokoro: Kokoro steps down to backup.
    await useSpeechEngine('piper', 'tts', { makePrimary: true });
    expect(state.rows['local piper'].topicRoles).toEqual({ speech: 'primary' });
    expect(state.rows['local kokoro'].topicRoles).toEqual({ speech: 'backup' });
    // OpenAI over Piper: Piper is the backup now and Kokoro is no longer one.
    await useSpeechEngine('openai', 'tts', { makePrimary: true });
    expect(state.rows['local piper'].topicRoles).toEqual({ speech: 'backup' });
    expect(state.rows['local kokoro'].topicRoles).toEqual({});
    // Promoting the backup itself keeps it primary.
    await useSpeechEngine('piper', 'tts', { makePrimary: true });
    expect(state.rows['local piper'].topicRoles).toEqual({ speech: 'primary' });
    expect(state.rows['openai gpt-4o-mini-tts'].topicRoles).toEqual({ speech: 'backup' });
  });

  test('a model path given for an engine that has a row already updates that row', async () => {
    await useSpeechEngine('piper', 'tts', { modelPath: '/voices/a.onnx' });
    await useSpeechEngine('piper', 'tts', { modelPath: '/voices/b.onnx' });
    expect(state.rows['local piper'].metadata?.modelPath).toBe('/voices/b.onnx');
  });
});

describe('availability', () => {
  test('a whisper row whose own model file is gone says which file', async () => {
    await expect(speechRowAvailable({ provider: 'local-audio', modelId: 'whisper.cpp:base', apiKeyRef: null, metadata: { modelPath: '/nowhere/ggml-large.bin' } } as never))
      .resolves.toEqual({ ok: false, reason: 'The whisper model file /nowhere/ggml-large.bin is missing.' });
  });

  test('a row key is resolved like any custom key (env: names work); a missing one says so', async () => {
    process.env.SPEECH_ROW_TEST_KEY = 'sk-test';
    await expect(speechRowAvailable({ provider: 'openai', modelId: 'gpt-4o-mini-tts', apiKeyRef: 'env:SPEECH_ROW_TEST_KEY', metadata: {} } as never)).resolves.toEqual({ ok: true });
    delete process.env.SPEECH_ROW_TEST_KEY;
    await expect(speechRowAvailable({ provider: 'openai', modelId: 'gpt-4o-mini-tts', apiKeyRef: 'env:SPEECH_ROW_TEST_KEY', metadata: {} } as never)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/not set/) });
  });
});

describe('your own speech server: updating the row', () => {
  type Row = { endpoint?: string; modelId?: string; metadata?: Record<string, any> };
  const stored = (name: string) => state.rows[name] as unknown as Row;

  test('a row stores only the settings chosen for it; what its model is known for applies when read', async () => {
    await useSpeechServer({ direction: 'tts', endpoint: 'http://localhost:8091/v1', modelId: 'openbmb/VoxCPM2', name: 'vox', speech: { cloning: false } });
    expect(stored('vox').metadata?.speech).toEqual({ cloning: false, direction: 'tts' });
    expect(speechConfigOf(stored('vox') as never)).toMatchObject({ instructions: 'prefix', sampleRate: 48000, cloning: false });
  });

  test('a new model id starts from what that model is known for: the old model\'s defaults do not follow, choices made for the row do', async () => {
    // A row made before only choices were stored: VoxCPM2's defaults are in it, and one real choice (extra fields).
    state.rows.vox = {
      name: 'vox', provider: 'custom-openai', modelId: 'openbmb/VoxCPM2', endpoint: 'http://localhost:8091', topicRoles: {},
      metadata: { speech: { direction: 'tts', instructions: 'prefix', cloning: true, streams: true, speed: false, sampleRate: 48000, formats: ['wav', 'pcm'], extraBody: { seed: 7 } } },
    } as never;
    await useSpeechServer({ direction: 'tts', endpoint: 'http://localhost:8091', modelId: 'BreezeBlue/Breeze-TTS-2', name: 'vox' });
    // Breeze writes 24 kHz and takes a description as a field: VoxCPM's 48 kHz and prefix would play it at double speed and read the description aloud.
    expect(speechConfigOf(stored('vox') as never)).toMatchObject({ sampleRate: 24000, instructions: 'field', voice: 'S0', extraBody: { seed: 7 } });
    expect(stored('vox').metadata?.speech).toEqual({ extraBody: { seed: 7 }, direction: 'tts' });
  });

  test('a setting sent as null is cleared; one not sent stays', async () => {
    await useSpeechServer({ direction: 'tts', endpoint: 'http://localhost:8091', modelId: 'openbmb/VoxCPM2', name: 'vox', speech: { sampleRate: 44100, speed: true } });
    await useSpeechServer({ direction: 'tts', endpoint: 'http://localhost:8091', modelId: 'openbmb/VoxCPM2', name: 'vox', speech: { sampleRate: null } });
    expect(stored('vox').metadata?.speech).toEqual({ speed: true, direction: 'tts' });
  });

  test('turning the live socket off keeps the stored URL and rate; the engine then streams nothing live', async () => {
    const nemo = 'nvidia/nemotron-3.5-asr-streaming-0.6b';
    await useSpeechServer({ direction: 'stt', endpoint: 'http://10.0.0.5:8080', modelId: nemo, name: 'nemo', speech: { realtime: { protocol: 'nemo', url: 'ws://10.0.0.5:9000/rt', sampleRate: 16000 } } });
    await useSpeechServer({ direction: 'stt', endpoint: 'http://10.0.0.5:8080', modelId: nemo, name: 'nemo', speech: { realtime: { protocol: 'off' } } });
    expect(stored('nemo').metadata?.speech?.realtime).toEqual({ protocol: 'off', url: 'ws://10.0.0.5:9000/rt', sampleRate: 16000 });
    expect(liveRealtime(speechConfigOf(stored('nemo') as never))).toBeUndefined();
    expect(mergeSpeechSettings({ realtime: { protocol: 'off', url: 'ws://h/rt' } }, { realtime: { protocol: 'nemo' } }).realtime).toEqual({ protocol: 'nemo', url: 'ws://h/rt' });
  });

  test('a server moved from a private address to a public one no longer counts as local', async () => {
    await useSpeechServer({ direction: 'stt', endpoint: 'http://192.168.1.20:8000', modelId: 'openai/whisper-large-v3-turbo', name: 'turbo' });
    expect(stored('turbo').metadata?.dataPolicy).toMatchObject({ hosting: 'local' });
    await useSpeechServer({ direction: 'stt', endpoint: 'https://speech.example.com', modelId: 'openai/whisper-large-v3-turbo', name: 'turbo' });
    expect(stored('turbo').metadata?.dataPolicy).toBeUndefined();
    // A policy that never said local (set on the Models page) is the owner's statement about that host: it stays.
    state.rows.turbo.metadata = { ...state.rows.turbo.metadata, dataPolicy: { hosting: 'remote', retention: 'none', trainsOnInput: false } };
    await useSpeechServer({ direction: 'stt', endpoint: 'https://speech.example.com', modelId: 'openai/whisper-large-v3-turbo', name: 'turbo' });
    expect(stored('turbo').metadata?.dataPolicy).toMatchObject({ hosting: 'remote' });
  });

  test('a local row may not stream live audio to a public host', async () => {
    const parakeet = { direction: 'stt' as const, modelId: 'nvidia/parakeet-tdt', name: 'parakeet', speech: { realtime: { protocol: 'nemo' as const, url: 'wss://asr.example.com/rt' } } };
    await expect(useSpeechServer({ ...parakeet, endpoint: 'http://localhost:8080' })).rejects.toThrow(/counts as running locally.*asr\.example\.com is a public host/);
    expect(state.rows.parakeet).toBeUndefined();
    // On a public endpoint the row is not local, and its public socket is no surprise.
    await expect(useSpeechServer({ ...parakeet, endpoint: 'https://asr.example.com' })).resolves.toMatchObject({ lane: 'transcription' });
    expect(realtimeUrlProblem({ realtime: { protocol: 'nemo', url: 'ws://10.0.0.5:9000/rt' } }, { hosting: 'local' })).toBeNull();
    expect(realtimeUrlProblem({ realtime: { protocol: 'nemo', url: 'ftp://x' } }, null)).toMatch(/ws:\/\/ or wss:\/\//);
  });
});
