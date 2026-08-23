import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';
import { SwarmSpawner } from './spawner';

/**
 * W9 planner→executor split: a swarm child spawned for a topic with an
 * `executorModel` configured binds to that model instead of the topic's primary
 * — but ONLY when the parent supplied an explicit `plan` (hasPlan). A plan-less
 * child is a recon/judgment delegation and stays on the topic primary.
 * Empty executor ⇒ topic primary binding regardless of plan.
 *
 * DB-backed: run via `bun run test:integration -- src/core/swarm/spawner-executor.test.ts`.
 */
describe.skipIf(!isIntegration)('SwarmSpawner — executor model resolution (W9)', () => {
  // resolveChildModelAndExpert is private; cast to reach it in the test.
  let resolve: (parentModel: string, childRole: string, msg: string, hasPlan?: boolean) => Promise<{ model: string }>;
  /** Same, but pins a specific expert so the match is deterministic. */
  let resolveWithExpert: (
    parentModel: string, childRole: string, msg: string, expertId: string, hasPlan?: boolean,
  ) => Promise<{ model: string }>;

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['topics_config', 'model_config', 'presets']);

    const { getModelRegistry } = await import('@/models/model-registry');
    const reg = getModelRegistry();
    // Topic primary for 'coding' (→ agents lane) = primary-model; executor candidate = exec-model.
    await reg.registerModel({
      name: 'primary-model', provider: 'ollama', modelId: 'primary-id', isEnabled: true,
      topicRoles: { agents: 'primary' },
    } as never);
    await reg.registerModel({ name: 'exec-model', provider: 'ollama', modelId: 'exec-id', isEnabled: true } as never);

    const spawner = new SwarmSpawner({} as never);
    resolve = (parentModel, childRole, msg, hasPlan = false) =>
      (spawner as unknown as {
        resolveChildModelAndExpert: (
          a: string, b: string, c: string, d?: string, e?: string, f?: boolean, g?: boolean,
        ) => Promise<{ model: string }>;
      }).resolveChildModelAndExpert(parentModel, childRole, msg, undefined, undefined, false, hasPlan);
    resolveWithExpert = (parentModel, childRole, msg, expertId, hasPlan = false) =>
      (spawner as unknown as {
        resolveChildModelAndExpert: (
          a: string, b: string, c: string, d?: string, e?: string, f?: boolean, g?: boolean,
        ) => Promise<{ model: string }>;
      }).resolveChildModelAndExpert(parentModel, childRole, msg, expertId, undefined, false, hasPlan);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('no executorModel ⇒ resolves the topic primary (with or without plan)', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('agents', { executorModel: null, temperature: null, maxTokens: null });
    expect((await resolve('parent-id', 'coding', 'do coding', false)).model).toBe('primary-id');
    expect((await resolve('parent-id', 'coding', 'do coding', true)).model).toBe('primary-id');
  });

  test('executorModel set + plan ⇒ child resolves to the executor model', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('agents', { executorModel: 'exec-model', temperature: null, maxTokens: null });
    const r = await resolve('parent-id', 'coding', 'do coding', true);
    expect(r.model).toBe('exec-id');
  });

  test('executorModel set but NO plan ⇒ stays on the topic primary (recon path)', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('agents', { executorModel: 'exec-model', temperature: null, maxTokens: null });
    const r = await resolve('parent-id', 'coding', 'do coding', false);
    expect(r.model).toBe('primary-id');
  });

  test('executorModel pointing at a missing model fails loud only when a plan needs it', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('agents', { executorModel: 'ghost-model', temperature: null, maxTokens: null });
    // With a plan, the executor branch runs and the missing model throws.
    await expect(resolve('parent-id', 'coding', 'do coding', true)).rejects.toThrow(/executorModel/);
    // Without a plan, the branch is skipped — a misconfigured executor must not
    // block a recon spawn; it falls through to the primary.
    expect((await resolve('parent-id', 'coding', 'do coding', false)).model).toBe('primary-id');
  });
  test('planned child: the lane executor overrides an expert modelPreference', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    const { getDb } = await import('@/db/postgres');
    const { experts } = await import('@/db/schema/experts');
    await setTopicConfig('agents', { executorModel: 'exec-model', temperature: null, maxTokens: null });

    // A specialist that names its own (full-price) model — the shape 9 of the
    // 16 shipped experts have, all of them on the `agents` lane that every
    // hands-on role aliases to.
    const [expert] = await getDb()
      .insert(experts)
      .values({
        name: 'Pricey Specialist',
        role: 'coding',
        topic: 'agents',
        modelPreference: 'expert-choice-id',
        isSystem: true,
      } as never)
      .returning();

    // Planned ⇒ the judgment is already done, so the checklist runs on the
    // cheap executor even though the expert names a model. Without this the
    // executor was unreachable for the whole agents lane.
    const planned = await resolveWithExpert('parent-id', 'coding', 'do coding', expert.id, true);
    expect(planned.model).toBe('exec-id');

    // Plan-less ⇒ this is a judgment delegation and the expert's choice stands.
    // Note the expert branch passes `modelPreference` through verbatim, where
    // the executor branch resolves a model NAME to its modelId — a pre-existing
    // asymmetry this test pins rather than changes.
    const recon = await resolveWithExpert('parent-id', 'coding', 'do coding', expert.id, false);
    expect(recon.model).toBe('expert-choice-id');
  });
});
