import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import * as realModelRegistry from '@/models/model-registry';
import * as realLitellmClient from '@/models/litellm-client';

/**
 * Locks the silent short-circuit that left the `memories` table empty in
 * production: when no model is bound to topic "memory_extraction" the
 * extractor returns [] WITHOUT calling the LLM, so the judge (which resolves
 * the SAME topic) never runs and nothing is persisted. This path throws no
 * error — it only logs at debug — so a regression is invisible without an
 * explicit guard. See docs/QA.md §9.13.
 *
 * Leak-immune setup: another suite's `mock.module('@/models/model-registry', …)`
 * is process-global and can leak forward (bun's restore is order-dependent),
 * leaving `getModelRegistry()` a partial stub — which used to make this gate
 * flaky (see the recurring CI failure). Rather than patch a singleton whose
 * identity a leak can swap, this suite OWNS the module bindings for its run
 * (last mock.module wins) and restores the real modules in afterAll.
 */
let modelForTopic: unknown = null;
const completeSpy = mock(async () => ({ content: '{"facts":[]}' }));

mock.module('@/models/model-registry', () => ({
  ...realModelRegistry,
  getModelRegistry: () => ({ getModelForTopic: async () => modelForTopic }),
}));
mock.module('@/models/litellm-client', () => ({
  ...realLitellmClient,
  getLiteLLMClient: () => ({ complete: completeSpy }),
}));

// Import AFTER the mocks so the extractor/judge bind to them.
const { extractFacts } = await import('./extractor');
const { judgeAndApply } = await import('./judge');

afterAll(() => {
  mock.module('@/models/model-registry', () => realModelRegistry);
  mock.module('@/models/litellm-client', () => realLitellmClient);
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
