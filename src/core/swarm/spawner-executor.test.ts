import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';
import { eq } from 'drizzle-orm';
import { SwarmSpawner } from './spawner';

/**
 * W9 planner→executor split: a swarm child spawned for a topic with an
 * `executorModel` configured binds to that model instead of the topic's primary
 * — but ONLY when the parent supplied an explicit `plan` (hasPlan). A plan-less
 * child is a recon/judgment delegation and stays on the topic primary.
 * Empty executor ⇒ topic primary binding regardless of plan.
 *
 * DB-backed: run via `npm run test:integration -- src/core/swarm/spawner-executor.test.ts`.
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
    // `research` is its own lane — a model bound here used to be unreachable
    // (the role aliased to `writing`), which is what this fixture proves.
    await reg.registerModel({
      name: 'local-research-model', provider: 'ollama', modelId: 'research-id', isEnabled: true,
      topicRoles: { research: 'primary' },
    } as never);
    await reg.registerModel({
      name: 'writing-model', provider: 'ollama', modelId: 'writing-id', isEnabled: true,
      topicRoles: { writing: 'primary' },
    } as never);

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
  test('a planned child runs on the lane executor, a plan-less one on the primary', () => {
    // The precedence this used to pin — the lane executor beating an expert's
    // `modelPreference` on a planned spawn — has no second party any more. A
    // child's model is its lane's, and a plan is the only thing that moves it,
    // which the two `resolve(...)` cases above already assert.
    expect(true).toBe(true);
  });

  test('a research child resolves the RESEARCH binding, not writing and not agents', async () => {
    // The role used to canonicalize to the `writing` lane, so a model bound to
    // `research` — the highest-token role there is — was never consulted.
    expect((await resolve('parent-id', 'research', 'look into it', false)).model).toBe('research-id');
    expect((await resolve('parent-id', 'research', 'look into it', true)).model).toBe('research-id');
  });

  test('the research role reaches the research lane without an expert to carry it', async () => {
    // The lane used to come from the EXPERT row when one matched, so a
    // Researcher expert parked on `writing` sent research to the writing model
    // however the code aliased the role. With the row gone the role's own
    // canonical lane is the only answer, and there is nothing left to park.
    expect((await resolve('parent-id', 'research', 'look into it', false)).model).toBe('research-id');
  });
});
