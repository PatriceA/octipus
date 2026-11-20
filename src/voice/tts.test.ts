import { describe, expect, test, vi } from 'vitest';
import { KokoroEngine, MistralTTSEngine, OpenAITTSEngine, PiperEngine } from './tts';

describe('an interrupted sentence stops its request', () => {
  /** A speech server that sends one chunk and then goes on generating. */
  const generating = () => {
    const seen: { signal?: AbortSignal; cancelled: boolean } = { cancelled: false };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(4800)); },
        cancel() { seen.cancelled = true; },
      });
      return new Response(body, { headers: { 'content-type': 'audio/pcm' } });
    });
    return { seen, spy };
  };

  const engines = async () => {
    const { CompatibleTTSEngine } = await import('./compatible');
    return [
      ['OpenAI', new OpenAITTSEngine('alloy', { apiKey: 'k' })],
      ['a speech server', new CompatibleTTSEngine({ baseUrl: 'http://localhost:8091/v1', headers: {}, query: {} }, 'openbmb/VoxCPM2', { streams: true, sampleRate: 48000 })],
    ] as const;
  };

  test('returning the stream early aborts the request and cancels its body', async () => {
    for (const [name, engine] of await engines()) {
      const { seen, spy } = generating();
      try {
        const chunks = engine.streamPcm!('A sentence nobody will hear to the end.');
        expect((await chunks.next()).value, name).toHaveLength(4800);
        expect(seen.signal?.aborted, name).toBe(false);
        await chunks.return(undefined);
        expect(seen.signal?.aborted, name).toBe(true);
        expect(seen.cancelled, name).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }
  });

  test('disposing the engine aborts a request still waiting for its answer', async () => {
    for (const [name, engine] of await engines()) {
      let signal: AbortSignal | undefined;
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      try {
        const pending = engine.synthesize('Hello.');
        await vi.waitFor(() => expect(signal, name).toBeDefined());
        await engine.dispose();
        await expect(pending, name).rejects.toThrow(/abort/i);
      } finally {
        spy.mockRestore();
      }
    }
  });
});

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
