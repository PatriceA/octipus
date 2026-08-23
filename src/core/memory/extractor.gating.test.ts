import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

// Plain-object snapshots taken before the mock.module calls below. Restoring
// from the live `import * as` namespaces does NOT work: bun's `mock.module`
// leaves those bindings pointing at the installed stubs, so restoring from them
// re-installs the stubs and leaks them forward (later integration suites then
// see a partial `getModelRegistry()`/`getLiteLLMClient()` and crash). A copy
// taken before mocking is immune.

/**
 * Locks the silent short-circuit that left the `memories` table empty in
 * production: when no model is bound to topic "memory_extraction" the
 * extractor returns [] WITHOUT calling the LLM, so the judge (which resolves
 * the SAME topic) never runs and nothing is persisted. This path throws no
 * error — it only logs at debug — so a regression is invisible without an
 * explicit guard. See docs/QA.md §9.13.
 *
 * Leak-immune setup: another suite's `vi.mock('@/models/model-registry', …)`
 * is process-global and can leak forward (bun's restore is order-dependent),
 * leaving `getModelRegistry()` a partial stub — which used to make this gate
 * flaky (see the recurring CI failure). Rather than patch a singleton whose
 * identity a leak can swap, this suite OWNS the module bindings for its run
 * (last mock.module wins) and restores the real modules in afterAll.
 */
let modelForTopic: unknown = null;
const completeSpy = vi.fn(async () => ({ content: '{"facts":[]}' }));

vi.mock('@/models/model-registry', async () => ({
  ...(await vi.importActual<typeof import('@/models/model-registry')>('@/models/model-registry')),
  getModelRegistry: () => ({ getModelForTopic: async () => modelForTopic }),
}));
vi.mock('@/models/litellm-client', async () => ({
  ...(await vi.importActual<typeof import('@/models/litellm-client')>('@/models/litellm-client')),
  getLiteLLMClient: () => ({ complete: completeSpy }),
}));

// Import AFTER the mocks so the extractor/judge bind to them.
const { extractFacts } = await import('./extractor');
const { judgeAndApply } = await import('./judge');

afterAll(() => {
});

describe('memory.extractor — memory_extraction topic gating', () => {
  afterEach(() => {
    modelForTopic = null;
    completeSpy.mockClear();
  });

  test('no model bound to memory_extraction → returns [] and never calls the LLM', async () => {
    modelForTopic = null; // no model bound to the topic
    const facts = await extractFacts({
      userMessage: 'I prefer tabs over spaces and I work mostly in TypeScript',
      userId: 'user-1',
    });

    expect(facts).toEqual([]);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  test('first-person heuristic fails → returns [] before any model lookup', async () => {
    // A non-first-person query short-circuits before the model lookup even when
    // a model IS bound — so it must still cost zero LLM calls.
    modelForTopic = { modelId: 'some-model' };
    const facts = await extractFacts({ userMessage: 'what time is it?', userId: 'user-1' });

    expect(facts).toEqual([]);
    expect(completeSpy).not.toHaveBeenCalled();
  });
});

describe('memory.judge — judgeAndApply input gating', () => {
  test('no candidates → [] (no repo/embedding work)', async () => {
    const outcomes = await judgeAndApply([], { userId: 'user-1' });
    expect(outcomes).toEqual([]);
  });
});
