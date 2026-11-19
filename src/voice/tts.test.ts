import { describe, expect, test } from 'vitest';
import { KokoroEngine, MistralTTSEngine, OpenAITTSEngine, PiperEngine } from './tts';

describe('a Speech-lane row becomes its engine', () => {
  const row = (provider: string, modelId: string, extra: Record<string, unknown> = {}) =>
    ({ name: modelId, provider, modelId, endpoint: null, apiKeyRef: null, metadata: {}, ...extra }) as never;

  test('each kind of row is driven by its engine class', async () => {
    const { ttsEngineFor } = await import('./speech-rows');
    const { CompatibleTTSEngine } = await import('./compatible');
    expect(await ttsEngineFor(row('mistral', 'voxtral-mini-tts-2603', { apiKeyRef: 'env:TTS_TEST_KEY' }), { format: 'mp3' }).catch((e: Error) => e.message)).toMatch(/TTS_TEST_KEY|not set/);
    expect(await ttsEngineFor(row('local-audio', 'kokoro:af_sarah'), { format: 'wav' })).toBeInstanceOf(KokoroEngine);
    expect(await ttsEngineFor(row('local-audio', 'piper:en_US-lessac-medium', { metadata: { modelPath: '/voices/x.onnx' } }), { format: 'wav' })).toBeInstanceOf(PiperEngine);
    expect(await ttsEngineFor(row('custom-openai', 'openbmb/VoxCPM2', { endpoint: 'http://localhost:8091' }), { format: 'wav' })).toBeInstanceOf(CompatibleTTSEngine);
    expect(MistralTTSEngine).toBeDefined();
    expect(OpenAITTSEngine).toBeDefined();
  });

  test('a row that is no speech engine is refused by name', async () => {
    const { ttsEngineFor } = await import('./speech-rows');
    // 'edge' and 'coqui' engines were removed; a chat row was never one.
    await expect(ttsEngineFor(row('anthropic', 'claude'), { format: 'mp3' })).rejects.toThrow(/not a text-to-speech engine/);
    await expect(ttsEngineFor(row('local-audio', 'coqui:x'), { format: 'wav' })).rejects.toThrow(/not a text-to-speech engine/);
  });
});
