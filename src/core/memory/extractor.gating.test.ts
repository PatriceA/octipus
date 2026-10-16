import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * Locks the silent short-circuit that left the `memories` table empty in
 * production: when no model is bound to topic "memory_extraction" the
 * extractor returns [] WITHOUT calling the LLM, so the judge (which resolves
 * the SAME topic) never runs and nothing is persisted. This path throws no
 * error — it only logs at debug — so a regression is invisible without an
 * explicit guard. See docs/QA.md §9.13.
 *
 * This suite owns the model-registry and LiteLLM-client bindings through
 * file-scoped module mocks (the runner isolates each test file).
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
