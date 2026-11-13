import { afterEach, describe, expect, test, vi } from 'vitest';
import { detectInputs, detectOllamaInputs, inferInputsFromFamily, upgradeFlags } from './capability-detect';

afterEach(() => vi.unstubAllGlobals());

describe('capability detection', () => {
  test('Ollama: /api/show capabilities decide image, audio and tool support', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ capabilities: ['completion', 'vision', 'tools'] })));
    vi.stubGlobal('fetch', fetch);
    await expect(detectOllamaInputs('http://gpu:11434/v1', 'qwen3.8:9b')).resolves.toEqual({ image: true, audio: false, tools: true });
    expect(fetch).toHaveBeenCalledWith('http://gpu:11434/api/show', expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'qwen3.8:9b' }) }));
  });

  test('family table: documented input modalities; unknown models are unknown', () => {
    expect(inferInputsFromFamily('openai/gpt-4o')).toEqual({ image: true });
    expect(inferInputsFromFamily('gpt-4o-audio-preview')).toEqual({ audio: true });
    expect(inferInputsFromFamily('gemini-2.5-flash')).toEqual({ image: true, audio: true });
    expect(inferInputsFromFamily('claude-sonnet-5-5')).toEqual({ image: true });
    expect(inferInputsFromFamily('qwen2.5-omni')).toEqual({ image: true, audio: true });
    expect(inferInputsFromFamily('deepseek-ocr:latest')).toEqual({ image: true });
    expect(inferInputsFromFamily('deepseek-chat')).toBeUndefined();
    expect(inferInputsFromFamily('llama3.1:8b')).toBeUndefined();
  });

  test('CLI rows are not detected (they read files themselves)', async () => {
    await expect(detectInputs({ provider: 'cli', modelId: 'claude-code' })).resolves.toBeUndefined();
  });

  test('detection only ever turns a flag on', () => {
    expect(upgradeFlags({ supportsVision: false, supportsAudioInput: false }, { image: true, audio: true })).toEqual({ supportsVision: true, supportsAudioInput: true });
    expect(upgradeFlags({ supportsVision: true, supportsAudioInput: false }, { image: false })).toEqual({});
    expect(upgradeFlags({ supportsVision: false, supportsAudioInput: false }, undefined)).toEqual({});
  });
});

describe('capability detection — never a false "reads images"', () => {
  test('text-only members of image families, and non-chat models, are not marked', () => {
    for (const id of [
      'o3-mini', 'openai/o3-mini', 'o1-mini', 'o1-preview', 'gpt-4-turbo-preview',
      'gemma3:1b', 'gemma3:270m', 'gemma-3-1b-it',
      'gpt-4o-transcribe', 'gpt-4o-mini-tts', 'gpt-4o-realtime-preview', 'gpt-4o-search-preview',
      'gemini-2.5-flash-preview-tts', 'text-embedding-3-small', 'dall-e-3', 'gpt-image-1', 'whisper-1',
      'voxtral-mini-tts-2603',
    ]) {
      expect(inferInputsFromFamily(id), id).toBeUndefined();
    }
  });

  test('the image-reading members still are', () => {
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5', 'o3', 'o4-mini', 'gemma3:4b', 'gemma3:27b', 'gemma4:e4b', 'qwen2.5vl:7b', 'qwen3-vl:8b', 'qwen3.8:9b', 'llava:13b', 'pixtral-12b', 'claude-haiku-4-5']) {
      expect(inferInputsFromFamily(id)?.image, id).toBe(true);
    }
  });

  test('an Ollama without a capabilities field has not answered; neither has a down Ollama', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ details: {} }))));
    await expect(detectInputs({ provider: 'ollama', modelId: 'qwen3.8', endpoint: 'http://x' })).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(detectInputs({ provider: 'ollama', modelId: 'gemma3:12b', endpoint: 'http://x' })).resolves.toBeUndefined();
  });

  test('providers that answer for themselves are not second-guessed', async () => {
    await expect(detectInputs({ provider: 'openrouter', modelId: 'openai/gpt-4o' })).resolves.toBeUndefined();
    await expect(detectInputs({ provider: 'litellm', modelId: 'gpt-4o' })).resolves.toBeUndefined();
  });
});

describe('boot sweep', () => {
  test('stamps only on an answer, re-reads the row, keeps its metadata, only turns flags on', async () => {
    const rows: Record<string, Record<string, unknown>> = {
      a: { name: 'a', provider: 'openai', modelId: 'gpt-4o', supportsVision: false, supportsAudioInput: false, metadata: {} },
      b: { name: 'b', provider: 'ollama', modelId: 'qwen3.8', endpoint: 'http://x', supportsVision: false, supportsAudioInput: false, metadata: {} },
      c: { name: 'c', provider: 'openai', modelId: 'gpt-4o', supportsVision: false, supportsAudioInput: false, metadata: { capabilitiesDetectedAt: 'then' } },
    };
    const updateModel = vi.fn(async () => ({}));
    vi.doMock('./model-registry', () => ({
      getModelRegistry: () => ({
        getAllModelsIncludeDisabled: async () => Object.values(rows),
        // An edit landed while Ollama was being asked: the re-read sees it.
        getModel: async (name: string) => (name === 'a' ? { ...rows.a, metadata: { providerSettings: { edited: true } } } : rows[name]),
        updateModel,
      }),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { detectCapabilitiesForUndetectedRows } = await import('./capability-detect');
    await expect(detectCapabilitiesForUndetectedRows()).resolves.toBe(1);
    expect(updateModel).toHaveBeenCalledTimes(1); // b (Ollama down) is asked again next boot; c is done
    expect(updateModel).toHaveBeenCalledWith('a', {
      supportsVision: true,
      metadata: { providerSettings: { edited: true }, capabilitiesDetectedAt: expect.any(String) },
    });
    vi.doUnmock('./model-registry');
  });
});
