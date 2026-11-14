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

const { audioExtensionFor, speechDirectionOf, speechRowAvailable, useSpeechEngine } = await import('./speech-rows');

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
