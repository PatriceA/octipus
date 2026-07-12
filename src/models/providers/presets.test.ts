import { describe, expect, test } from 'bun:test';
import {
  buildModelConfigFromPreset,
  discoverModels,
  type FetchLike,
  getPreset,
  LOCAL_RUNTIME_PRESETS,
  listPresets,
  normalizeEndpoint,
  parseModelList,
  probeHealth,
} from './presets';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('preset registry', () => {
  test('exposes the expected runtimes with /v1 endpoints', () => {
    const ids = listPresets().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['lmstudio', 'llamacpp', 'vllm', 'sglang']));
    for (const p of LOCAL_RUNTIME_PRESETS) {
      expect(p.defaultEndpoint).toMatch(/\/v1$/);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  test('getPreset resolves by id; unknown → undefined', () => {
    expect(getPreset('vllm')?.label).toBe('vLLM');
    expect(getPreset('nope')).toBeUndefined();
  });
});

describe('normalizeEndpoint', () => {
  test('trims trailing slashes and whitespace', () => {
    expect(normalizeEndpoint('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1');
    expect(normalizeEndpoint('  http://x/v1//  ')).toBe('http://x/v1');
  });
});

describe('parseModelList', () => {
  test('OpenAI shape { data: [{ id }] }', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
  });
  test('bare array of rows', () => {
    expect(parseModelList([{ id: 'x' }])).toEqual(['x']);
  });
  test('filters non-string / empty ids and tolerates junk', () => {
    expect(parseModelList({ data: [{ id: 'ok' }, { id: 42 }, { id: '' }, {}] })).toEqual(['ok']);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ nope: 1 })).toEqual([]);
  });
});

describe('discoverModels', () => {
  test('returns ids from a healthy endpoint and hits <endpoint>/models', async () => {
    let calledUrl = '';
    const fetch: FetchLike = async (url) => {
      calledUrl = url;
      return json({ data: [{ id: 'llama-3-8b' }, { id: 'qwen2' }] });
    };
    const models = await discoverModels('http://localhost:1234/v1/', { fetch });
    expect(models).toEqual(['llama-3-8b', 'qwen2']);
    expect(calledUrl).toBe('http://localhost:1234/v1/models');
  });

  test('sends a Bearer header when apiKey is provided', async () => {
    let auth: string | undefined;
    const fetch: FetchLike = async (_url, init) => {
      auth = (init?.headers as Record<string, string>)?.authorization;
      return json({ data: [] });
    };
    await discoverModels('http://x/v1', { fetch, apiKey: 'secret' });
    expect(auth).toBe('Bearer secret');
  });

  test('non-2xx → []', async () => {
    const fetch: FetchLike = async () => json({ error: 'nope' }, 500);
    expect(await discoverModels('http://x/v1', { fetch })).toEqual([]);
  });

  test('network error → [] (no throw)', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await discoverModels('http://x/v1', { fetch })).toEqual([]);
  });
});

describe('probeHealth', () => {
  test('2xx → true, 5xx → false, throw → false', async () => {
    expect(await probeHealth('http://x/v1', { fetch: async () => json({ data: [] }) })).toBe(true);
    expect(await probeHealth('http://x/v1', { fetch: async () => json({}, 503) })).toBe(false);
    expect(
      await probeHealth('http://x/v1', {
        fetch: async () => {
          throw new Error('down');
        },
      }),
    ).toBe(false);
  });
});

describe('buildModelConfigFromPreset', () => {
  test('maps to a custom-openai config using the preset endpoint by default', () => {
    const preset = getPreset('lmstudio')!;
    const cfg = buildModelConfigFromPreset(preset, 'my-model');
    expect(cfg).toEqual({
      provider: 'custom-openai',
      modelId: 'my-model',
      endpoint: 'http://localhost:1234/v1',
      customProvider: { auth: { type: 'bearer' } },
    });
  });

  test('honors an explicit endpoint (normalized)', () => {
    const preset = getPreset('vllm')!;
    const cfg = buildModelConfigFromPreset(preset, 'm', 'http://gpu-box:8000/v1/');
    expect(cfg.endpoint).toBe('http://gpu-box:8000/v1');
  });
});
