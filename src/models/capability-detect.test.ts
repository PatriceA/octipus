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

  test('Ollama down: the family table answers instead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(detectInputs({ provider: 'ollama', modelId: 'gemma3:12b', endpoint: 'http://x' })).resolves.toEqual({ image: true });
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
