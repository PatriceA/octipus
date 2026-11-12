import { describe, expect, test, vi } from 'vitest';

vi.mock('@/models/resolve-model', () => ({
  resolveModel: async (req: { topic?: string; backup?: boolean; name?: string }) => {
    if (req.name === 'cheap-exec') return { modelId: 'cheap-exec', name: 'cheap-exec', provider: 'ollama' };
    if (req.topic === 'build') return req.backup ? { modelId: 'claude-y', name: 'claude-y', provider: 'anthropic' } : { modelId: 'gpt-x', name: 'gpt-x', provider: 'openai' };
    return null;
  },
}));
vi.mock('@/models/topic-config', () => ({
  getTopicConfig: (lane: string) => ({ executorModel: lane === 'build' ? 'cheap-exec' : null }),
}));

const { createListLanesTool } = await import('./lanes-tool');
const { getCircuitBreakerRegistry, resetCircuitBreakerRegistry } = await import('@/models/circuit-breaker');

describe('list_lanes', () => {
  test('is read-only, discover-only, and takes no arguments', () => {
    const tool = createListLanesTool();
    expect(tool).toMatchObject({ name: 'list_lanes', discoverOnly: true, replaySafety: 'read_only' });
    expect(tool.parameters).toEqual({ type: 'object', properties: {} });
  });

  test("shows every lane's primary, backup and executor with availability", async () => {
    resetCircuitBreakerRegistry();
    for (let i = 0; i < 5; i++) getCircuitBreakerRegistry().recordFailure('openai');
    const out = String(await createListLanesTool().execute({}, { userId: 'u1', space: null } as never));
    expect(out).toMatch(/build:\n {2}primary: gpt-x — unavailable: circuit breaker for 'openai' open since/);
    expect(out).toContain('  backup: claude-y — available');
    expect(out).toContain('  executor (planned children): cheap-exec — available');
    expect(out).toMatch(/verify:\n {2}primary: none\n {2}backup: none\n {2}executor \(planned children\): none/);
    for (const lane of ['everyday', 'research']) expect(out).toContain(`${lane}:`);
    resetCircuitBreakerRegistry();
  });
});
