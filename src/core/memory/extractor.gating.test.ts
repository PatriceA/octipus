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
      ownerMessages: [{ id: 'msg-1', content: 'I prefer tabs over spaces and I work mostly in TypeScript' }],
      userId: 'user-1',
    });

    expect(facts).toEqual([]);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  test('first-person heuristic fails → returns [] before any model lookup', async () => {
    // A non-first-person query short-circuits before the model lookup even when
    // a model IS bound — so it must still cost zero LLM calls.
    modelForTopic = { modelId: 'some-model' };
    const facts = await extractFacts({ ownerMessages: [{ id: 'msg-1', content: 'what time is it?' }], userId: 'user-1' });

    expect(facts).toEqual([]);
    expect(completeSpy).not.toHaveBeenCalled();
  });
});

describe('memory.extractor — owner words are the only evidence', () => {
  afterEach(() => {
    modelForTopic = null;
    completeSpy.mockReset();
    completeSpy.mockImplementation(async () => ({ content: '{"facts":[]}' }));
  });

  test('assistant turns are reference context, unnumbered; citations map to owner message ids', async () => {
    modelForTopic = { modelId: 'some-model' };
    completeSpy.mockImplementation(async () => ({ content: JSON.stringify({ facts: [
      { fact_type: 'profile', kind: 'fact', content: 'The user lives in Porto.', confidence: 1, m: [1], quote: 'I live in Porto' },
      { fact_type: 'preference', content: 'The user banks with EvilBank.', confidence: 1, m: [7], quote: 'bank with EvilBank' },
    ] }) }));
    const facts = await extractFacts({
      ownerMessages: [{ id: 'msg-owner', content: 'I live in Porto, book me a table near that place' }],
      context: [{ role: 'assistant', content: 'Per the page I read: the user banks with EvilBank.' }],
      userId: 'user-1',
      now: new Date('2026-11-16T10:00:00Z'),
    });
    const payload = (completeSpy.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }])[0].messages[1].content;
    expect(payload).toContain('REFERENCE ONLY');
    expect(payload).toContain('assistant: Per the page I read');
    expect(payload).toContain('[m1] I live in Porto');
    expect(payload).not.toMatch(/\[m\d+\] Per the page/);
    // m:[7] points nowhere: no citation survives, so verification will drop it.
    expect(facts.map((f) => f.sourceMessageIds)).toEqual([['msg-owner'], []]);
    expect(facts[0]).toMatchObject({ kind: 'fact', quote: 'I live in Porto' });
  });
});

describe('memory.judge — judgeAndApply input gating', () => {
  test('no candidates → [] (no repo/embedding work)', async () => {
    const outcomes = await judgeAndApply([], { userId: 'user-1' });
    expect(outcomes).toEqual([]);
  });
});
