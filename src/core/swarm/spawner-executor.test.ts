import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';
import { SwarmSpawner } from './spawner';

/**
 * W9 planner→executor split: a swarm child spawned for a topic with an
 * `executorModel` configured binds to that model instead of the topic's primary.
 * Empty executor ⇒ today's behaviour (topic primary binding).
 *
 * DB-backed: run via `bun run test:integration -- src/core/swarm/spawner-executor.test.ts`.
 */
describe.skipIf(!isIntegration)('SwarmSpawner — executor model resolution (W9)', () => {
  // resolveChildModelAndExpert is private; cast to reach it in the test.
  let resolve: (parentModel: string, childRole: string, msg: string) => Promise<{ model: string }>;

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['topics_config', 'model_config', 'presets']);

    const { getModelRegistry } = await import('@/models/model-registry');
    const reg = getModelRegistry();
    // Topic primary for 'research' = primary-model; executor candidate = exec-model.
    await reg.registerModel({
      name: 'primary-model', provider: 'ollama', modelId: 'primary-id', isEnabled: true,
      topicRoles: { agents: 'primary' },
    } as never);
    await reg.registerModel({ name: 'exec-model', provider: 'ollama', modelId: 'exec-id', isEnabled: true } as never);

    const spawner = new SwarmSpawner({} as never);
    resolve = (parentModel, childRole, msg) =>
      (spawner as unknown as {
        resolveChildModelAndExpert: (a: string, b: string, c: string) => Promise<{ model: string }>;
      }).resolveChildModelAndExpert(parentModel, childRole, msg);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('no executorModel ⇒ resolves the topic primary (unchanged behaviour)', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('agents', { executorModel: null, temperature: null, maxTokens: null });
    const r = await resolve('parent-id', 'research', 'do research');
    expect(r.model).toBe('primary-id');
  });

  test('executorModel set ⇒ child resolves to the executor model', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('agents', { executorModel: 'exec-model', temperature: null, maxTokens: null });
    const r = await resolve('parent-id', 'research', 'do research');
    expect(r.model).toBe('exec-id');
  });

  test('executorModel pointing at a missing model fails loud', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('agents', { executorModel: 'ghost-model', temperature: null, maxTokens: null });
    await expect(resolve('parent-id', 'research', 'do research')).rejects.toThrow(/executorModel/);
  });
});
