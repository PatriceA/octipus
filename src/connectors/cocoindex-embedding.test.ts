import { beforeEach, expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ model: vi.fn(), embed: vi.fn(), token: vi.fn() }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: mock.model }) }));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ embed: mock.embed }) }));
vi.mock('@/security/mcp-token-bootstrap', () => ({ getMcpTokenPath: () => '/test/token' }));
vi.mock('node:fs/promises', () => ({ readFile: mock.token }));
vi.mock('@/config', () => ({ getConfig: () => ({ api: { port: 3005 } }) }));
import { cocoIndexEmbeddingSettings, embedCocoIndex } from './cocoindex-embedding';
beforeEach(() => {
  vi.resetAllMocks();
  mock.model.mockResolvedValue({ name: 'embed', provider: 'ollama', modelId: 'embed-v1', endpoint: 'http://embed', metadata: { embedPrefixes: { query: 'query: ', document: 'passage: ' } } });
  mock.token.mockResolvedValue('test-api-token');
  mock.embed.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
});
test('routes through the configured model with prefixes and serial batches of eight', async () => {
  const config = await cocoIndexEmbeddingSettings();
  expect(config.settings.envs.OPENAI_API_BASE).toBe('http://127.0.0.1:3005/api/connectors/cocoindex/document');
  expect(config.settings.embedding.indexing_params).toEqual({ input_type: 'document' });
  expect(config.settings.embedding.query_params).toEqual({ input_type: 'query' });
  const result = await embedCocoIndex(Array(17).fill('text'), config.model, 'query', 'admin');
  expect(mock.embed.mock.calls.map(call => call[0].length)).toEqual([8, 8, 1]);
  expect(mock.embed.mock.calls[0]).toEqual([Array(8).fill('query: text'), 'embed-v1', { userId: 'admin', modelConfigName: 'embed' }]);
  expect(result?.data).toHaveLength(17);
});
test('rejects changed embedding configuration before indexing into an incompatible space', async () => {
  const config = await cocoIndexEmbeddingSettings();
  mock.model.mockResolvedValue({ name: 'embed', modelId: 'new-model' });
  await expect(embedCocoIndex(['text'], config.model, 'document', 'admin')).rejects.toThrow('configuration changed');
  expect(mock.embed).not.toHaveBeenCalled();
});
test('releases the concurrency slot on provider failure', async () => {
  const config = await cocoIndexEmbeddingSettings();
  mock.embed.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(embedCocoIndex(['text'], config.model, 'document', 'admin')).rejects.toThrow('provider unavailable');
  expect(await embedCocoIndex(['text'], config.model, 'document', 'admin')).not.toBeNull();
});

test('admits only one embedding request at a time', async () => {
  const config = await cocoIndexEmbeddingSettings();
  let release!: (vectors: number[][]) => void;
  mock.embed.mockImplementationOnce(() => new Promise<number[][]>(resolve => { release = resolve; }));
  const first = embedCocoIndex(['first'], config.model, 'document', 'admin');
  await vi.waitFor(() => expect(release).toBeDefined());
  try { expect(await embedCocoIndex(['second'], config.model, 'query', 'admin')).toBeNull(); }
  finally { release([[1, 2]]); await first; }
});
