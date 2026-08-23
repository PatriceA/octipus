import { describe, expect, test, vi } from 'vitest';
import { buildEmbeddingVersion, embedPrefixTag, EmbeddingService, sha256Hex } from './embeddings';

/**
 * Unit tests for the loudest new fail-loud path: when the embedding provider
 * fails, `indexText` must throw with a clear message (previously it returned
 * 0 silently, causing uploads to appear successful with nothing written).
 *
 * The fail-loud cases construct EmbeddingService which transitively boots
 * LiteLLMClient — which requires a parsed config. Gate behind INTEGRATION
 * so the unit-test suite is green without a running config file.
 */

const isIntegration = process.env.INTEGRATION === '1';

describe.skipIf(!isIntegration)('EmbeddingService — fail-loud indexing', () => {
  test('indexText throws when every chunk fails (provider unavailable)', async () => {
    const service = new EmbeddingService('test-embed-model');

    // Force generateEmbedding to always fail, simulating an unreachable
    // embedding provider (Ollama down, API key missing, etc.)
    const providerError = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    (service as unknown as { embedBatch: (t: string[]) => Promise<Array<number[] | Error>> })
      .embedBatch = vi.fn(async (texts: string[]) => texts.map(() => providerError));

    // Content long enough to become at least one chunk
    const content = 'hello world '.repeat(50);

    let thrown: unknown = null;
    try {
      await service.indexText('document', 'test-src-id', content, { filePath: '/tmp/x.md' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Error must name the resource and include the provider-surfaced cause
    expect(message).toContain('test-src-id');
    expect(message).toContain('ECONNREFUSED');
  });

  test('indexText error message names the source AND the provider cause', async () => {
    // Ensures the thrown error includes enough context for an operator to
    // diagnose from logs alone — no "silent 0 stored" fallback.
    const service = new EmbeddingService('test-embed-model');
    const providerError = new Error('401 Unauthorized: invalid API key');
    (service as unknown as { embedBatch: (t: string[]) => Promise<Array<number[] | Error>> })
      .embedBatch = vi.fn(async (texts: string[]) => texts.map(() => providerError));

    const content = 'chunk content '.repeat(30);

    let thrown: unknown = null;
    try {
      await service.indexText('ephemeral', 'agent:abc123', content);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('ephemeral');
    expect(msg).toContain('agent:abc123');
    expect(msg).toContain('401 Unauthorized');
  });

  test('sha256Hex is stable and matches Node crypto for utf-8 input', () => {
    // SHA-256 of empty string is a well-known constant.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    // Determinism: same input → same hash.
    expect(sha256Hex('repeat-me')).toBe(sha256Hex('repeat-me'));
  });

  test('buildEmbeddingVersion encodes model + dimension', () => {
    expect(buildEmbeddingVersion('nomic-embed-text:v1.5', 768)).toBe('nomic-embed-text:v1.5/768');
    expect(buildEmbeddingVersion('text-embedding-3-large', 3072)).toBe('text-embedding-3-large/3072');
  });

  test('generateEmbedding rejects empty-vector responses loud (not silent)', async () => {
    const service = new EmbeddingService('test-embed-model');

    // Mock the LiteLLM client embed() path to return an empty array.
    // We do this by mocking resolveModel (private) and re-reaching into embed via injection is
    // overkill — instead, verify the public contract: generateEmbedding must not
    // return [] for valid input, so we simulate the provider giving back nothing.
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const originalEmbed = client.embed.bind(client);
    client.embed = vi.fn(async () => [[]]) as typeof client.embed;

    // Also bypass resolveModel
    (service as unknown as { resolveModel: () => Promise<{ modelId: string; prefixes: object }> }).resolveModel = vi.fn(
      async () => ({ modelId: 'test-embed-model', prefixes: {} }),
    );

    let thrown: unknown = null;
    try {
      await service.generateEmbedding('some text');
    } catch (err) {
      thrown = err;
    } finally {
      client.embed = originalEmbed;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/empty vector/i);
  });
});

describe('embedding version identity', () => {
  test('generateEmbedding applies the configured side prefix, and only that side', async () => {
    const service = new EmbeddingService();
    (service as unknown as { resolveModel: () => Promise<{ modelId: string; prefixes: object }> }).resolveModel = vi.fn(
      async () => ({
        modelId: 'some-embedding-model',
        prefixes: { document: 'search_document: ', query: 'search_query: ' },
      }),
    );

    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const originalEmbed = client.embed.bind(client);
    const seen: string[] = [];
    client.embed = vi.fn(async (text: string) => {
      seen.push(text);
      return [[0.1, 0.2]];
    }) as unknown as typeof client.embed;

    try {
      await service.generateEmbedding('a stored chunk');
      await service.generateEmbedding('what is stored?', 'query');
    } finally {
      client.embed = originalEmbed;
    }

    // Default side is 'document'; the query side must NOT get the document prefix
    // (embedding both sides identically is the recall bug this exists to prevent).
    expect(seen).toEqual(['search_document: a stored chunk', 'search_query: what is stored?']);
  });

  test('generateEmbedding passes text through verbatim for a symmetric model', async () => {
    const service = new EmbeddingService();
    (service as unknown as { resolveModel: () => Promise<{ modelId: string; prefixes: object }> }).resolveModel = vi.fn(
      async () => ({ modelId: 'some-embedding-model', prefixes: {} }),
    );

    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const originalEmbed = client.embed.bind(client);
    const seen: string[] = [];
    client.embed = vi.fn(async (text: string) => {
      seen.push(text);
      return [[0.1, 0.2]];
    }) as unknown as typeof client.embed;

    try {
      await service.generateEmbedding('x', 'document');
      await service.generateEmbedding('x', 'query');
    } finally {
      client.embed = originalEmbed;
    }

    expect(seen).toEqual(['x', 'x']);
  });

  test('no configured prefixes leaves the version string unchanged', () => {
    expect(embedPrefixTag()).toBe('');
    expect(embedPrefixTag({})).toBe('');
    expect(buildEmbeddingVersion('m', 768, embedPrefixTag({}))).toBe('m/768');
  });

  test('a prefix change produces a different version (rows are re-indexable)', () => {
    const a = embedPrefixTag({ document: 'search_document: ', query: 'search_query: ' });
    const b = embedPrefixTag({ document: 'passage: ', query: 'query: ' });
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
    // Stable across calls — the version must not churn per process.
    expect(embedPrefixTag({ document: 'search_document: ', query: 'search_query: ' })).toBe(a);
    // Sides are not interchangeable: swapping them is a different space.
    expect(embedPrefixTag({ document: 'q: ', query: 'd: ' })).not.toBe(
      embedPrefixTag({ document: 'd: ', query: 'q: ' }),
    );
  });
});

describe('embedBatch — batching and per-chunk failure accounting', () => {
  const stubModel = (service: EmbeddingService, prefixes: object = {}) => {
    (service as unknown as { resolveModel: () => Promise<{ modelId: string; prefixes: object }> }).resolveModel = vi.fn(
      async () => ({ modelId: 'some-embedding-model', prefixes }),
    );
  };

  test('sends one provider call per batch, not one per chunk, and keeps input order', async () => {
    const service = new EmbeddingService();
    stubModel(service);
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const original = client.embed.bind(client);
    const calls: string[][] = [];
    client.embed = vi.fn(async (text: string | string[]) => {
      const input = Array.isArray(text) ? text : [text];
      calls.push(input);
      // Distinguishable vector per input so misordering is detectable.
      return input.map((t) => [t.length]);
    }) as unknown as typeof client.embed;

    // 150 chunks at a batch size of 64 → 3 calls (64 + 64 + 22).
    const texts = Array.from({ length: 150 }, (_, i) => 'x'.repeat(i + 1));
    let out: Array<number[] | Error>;
    try {
      out = await service.embedBatch(texts);
    } finally {
      client.embed = original;
    }

    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.length)).toEqual([64, 64, 22]);
    expect(out.length).toBe(150);
    expect(out.every((v) => Array.isArray(v))).toBe(true);
    expect(out[0]).toEqual([1]);
    expect(out[149]).toEqual([150]);
  });

  test('a failed batch yields an Error per chunk instead of throwing', async () => {
    const service = new EmbeddingService();
    stubModel(service);
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const original = client.embed.bind(client);
    client.embed = vi.fn(async () => { throw new Error('502 Bad Gateway'); }) as unknown as typeof client.embed;

    let out: Array<number[] | Error>;
    try {
      out = await service.embedBatch(['a', 'b', 'c']);
    } finally {
      client.embed = original;
    }

    expect(out.length).toBe(3);
    expect(out.every((v) => v instanceof Error)).toBe(true);
    expect((out[0] as Error).message).toContain('502');
  });

  test('a short/long provider response fails the batch rather than misattributing vectors', async () => {
    const service = new EmbeddingService();
    stubModel(service);
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const original = client.embed.bind(client);
    // Two inputs in, one vector back — attributing it to either chunk is wrong.
    client.embed = vi.fn(async () => [[0.1, 0.2]]) as unknown as typeof client.embed;

    let out: Array<number[] | Error>;
    try {
      out = await service.embedBatch(['a', 'b']);
    } finally {
      client.embed = original;
    }

    expect(out.every((v) => v instanceof Error)).toBe(true);
    expect((out[0] as Error).message).toMatch(/1 vectors for 2 inputs/);
  });

  test('applies the side prefix to every item in the batch', async () => {
    const service = new EmbeddingService();
    stubModel(service, { document: 'search_document: ', query: 'search_query: ' });
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const client = getLiteLLMClient();
    const original = client.embed.bind(client);
    let seen: string[] = [];
    client.embed = vi.fn(async (text: string | string[]) => {
      seen = Array.isArray(text) ? text : [text];
      return seen.map(() => [0.1]);
    }) as unknown as typeof client.embed;

    try {
      await service.embedBatch(['a', 'b'], 'query');
    } finally {
      client.embed = original;
    }

    expect(seen).toEqual(['search_query: a', 'search_query: b']);
  });
});
