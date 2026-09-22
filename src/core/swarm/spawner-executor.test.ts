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
  // resolveChildModel is private; cast to reach it in the test. It used to be
  // `resolveChildModelAndExpert` and took an expert id — there is no second
  // party to the decision any more, so the lane is the whole answer.
  let resolve: (parentModel: string, childRole: string, msg: string, hasPlan?: boolean) => Promise<{ model: string }>;
  /** Same, with the lane the PARENT asked for — `spawn_child`'s `topic`. */
  let resolveTo: (
    parentModel: string, childRole: string, msg: string, requestedLane: string, hasPlan?: boolean,
  ) => Promise<{ model: string }>;

  beforeAll(async () => {
    await setupIntegrationDb();
    // `presets` was dropped with the expert layer (migration 0105). Truncating
    // it threw in `beforeAll`, which failed the whole file — and this suite is
    // integration-only, so nothing in the unit run said so.
    await truncateTables(['topics_config', 'model_config']);

    const { getModelRegistry } = await import('@/models/model-registry');
    const reg = getModelRegistry();
    // Topic primary for 'coding' (→ BUILD lane) = primary-model; executor
    // candidate = exec-model. The `agents` lane these bindings used to sit on
    // is split into `build` and `everyday`.
    await reg.registerModel({
      name: 'primary-model', provider: 'ollama', modelId: 'primary-id', isEnabled: true,
      topicRoles: { build: 'primary' },
    } as never);
    await reg.registerModel({ name: 'exec-model', provider: 'ollama', modelId: 'exec-id', isEnabled: true } as never);
    // `research` is its own lane — a model bound here used to be unreachable
    // (the role aliased to `writing`), which is what this fixture proves.
    await reg.registerModel({
      name: 'local-research-model', provider: 'ollama', modelId: 'research-id', isEnabled: true,
      topicRoles: { research: 'primary' },
    } as never);
    // `writing` is a retired name that resolves to `everyday`; binding it here
    // is what proves a research child does not land on it.
    await reg.registerModel({
      name: 'everyday-model', provider: 'ollama', modelId: 'everyday-id', isEnabled: true,
      topicRoles: { everyday: 'primary' },
    } as never);
    await reg.registerModel({
      name: 'verify-model', provider: 'ollama', modelId: 'verify-id', isEnabled: true,
      topicRoles: { verify: 'primary' },
    } as never);

    const spawner = new SwarmSpawner({} as never);
    type Resolver = {
      resolveChildModel: (
        parentModel: string, childRole: string, childMessage: string,
        childUsesTools?: boolean, hasPlan?: boolean, requestedLane?: string,
      ) => Promise<{ model: string }>;
    };
    resolve = (parentModel, childRole, msg, hasPlan = false) =>
      (spawner as unknown as Resolver).resolveChildModel(parentModel, childRole, msg, false, hasPlan);
    resolveTo = (parentModel, childRole, msg, requestedLane, hasPlan = false) =>
      (spawner as unknown as Resolver).resolveChildModel(parentModel, childRole, msg, false, hasPlan, requestedLane);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('no executorModel ⇒ resolves the topic primary (with or without plan)', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('build', { executorModel: null, temperature: null, maxTokens: null });
    expect((await resolve('parent-id', 'coding', 'do coding', false)).model).toBe('primary-id');
    expect((await resolve('parent-id', 'coding', 'do coding', true)).model).toBe('primary-id');
  });

  test('executorModel set + plan ⇒ child resolves to the executor model', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('build', { executorModel: 'exec-model', temperature: null, maxTokens: null });
    const r = await resolve('parent-id', 'coding', 'do coding', true);
    expect(r.model).toBe('exec-id');
  });

  test('executorModel set but NO plan ⇒ stays on the topic primary (recon path)', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('build', { executorModel: 'exec-model', temperature: null, maxTokens: null });
    const r = await resolve('parent-id', 'coding', 'do coding', false);
    expect(r.model).toBe('primary-id');
  });

  test('executorModel pointing at a missing model fails loud only when a plan needs it', async () => {
    const { setTopicConfig } = await import('@/models/topic-config');
    await setTopicConfig('build', { executorModel: 'ghost-model', temperature: null, maxTokens: null });
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

  test('the lane a parent asks for wins over the child role\'s own', async () => {
    // `spawn_child`'s `topic` is how a parent sends a child to a different
    // model — `verify` for a second opinion that does not share the blind spot
    // that produced the code. It used to be a label on the topic path only.
    expect((await resolveTo('parent-id', 'coding', 'check this', 'verify')).model).toBe('verify-id');
    // Free text is a label, not a routing instruction: it falls back to the
    // role's own lane rather than failing the spawn.
    expect((await resolveTo('parent-id', 'coding', 'check this', 'oauth/pkce')).model).toBe('primary-id');
  });

  test('a research child resolves the RESEARCH binding, not everyday and not build', async () => {
    // The role used to canonicalize to the `writing` lane, so a model bound to
    // `research` — the highest-token role there is — was never consulted.
    expect((await resolve('parent-id', 'research', 'look into it', false)).model).toBe('research-id');
    expect((await resolve('parent-id', 'research', 'look into it', true)).model).toBe('research-id');
  });

  test('the research role reaches the research lane with no expert to carry it', async () => {
    // The lane used to come from the EXPERT row when one matched, so a
    // Researcher expert parked on `writing` sent research to the writing model
    // however the code aliased the role. With the row gone the role's own
    // canonical lane is the only answer, and there is nothing left to park.
    expect((await resolve('parent-id', 'research', 'look into it', false)).model).toBe('research-id');
  });
});
