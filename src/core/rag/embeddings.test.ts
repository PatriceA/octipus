import { describe, test, expect, mock } from 'bun:test';
import { EmbeddingService } from './embeddings';

/**
 * Unit tests for the loudest new fail-loud path: when the embedding provider
 * fails, `indexText` must throw with a clear message (previously it returned
 * 0 silently, causing uploads to appear successful with nothing written).
 */

describe('EmbeddingService — fail-loud indexing', () => {
  test('indexText throws when every chunk fails (provider unavailable)', async () => {
    const service = new EmbeddingService('test-embed-model');

    // Force generateEmbedding to always fail, simulating an unreachable
    // embedding provider (Ollama down, API key missing, etc.)
    const providerError = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    (service as unknown as { generateEmbedding: (t: string) => Promise<number[]> })
      .generateEmbedding = mock(async () => { throw providerError; });

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
    (service as unknown as { generateEmbedding: (t: string) => Promise<number[]> })
      .generateEmbedding = mock(async () => { throw providerError; });

    const content = 'chunk content '.repeat(30);

    let thrown: unknown = null;
    try {
      await service.indexText('agent_output', 'agent:abc123', content);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('agent_output');
    expect(msg).toContain('agent:abc123');
    expect(msg).toContain('401 Unauthorized');
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
    client.embed = mock(async () => [[]]) as typeof client.embed;

    // Also bypass resolveModel
    (service as unknown as { resolveModel: () => Promise<string> }).resolveModel = mock(
      async () => 'test-embed-model',
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
