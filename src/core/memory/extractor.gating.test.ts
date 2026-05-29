import { describe, test, expect, mock, afterEach } from 'bun:test';
import { extractFacts } from './extractor';
import { judgeAndApply } from './judge';
import { getModelRegistry } from '@/models/model-registry';
import { getLiteLLMClient } from '@/models/litellm-client';

/**
 * Locks the silent short-circuit that left the `memories` table empty in
 * production: when no model is bound to topic "memory_extraction" the
 * extractor returns [] WITHOUT calling the LLM, so the judge (which resolves
 * the SAME topic) never runs and nothing is persisted. This path throws no
 * error — it only logs at debug — so a regression is invisible without an
 * explicit guard. See docs/QA.md §9.13.
 */
describe('memory.extractor — memory_extraction topic gating', () => {
  const registry = getModelRegistry();
  const client = getLiteLLMClient();
  const origGetModelForTopic = registry.getModelForTopic;
  const origComplete = client.complete;

  afterEach(() => {
    registry.getModelForTopic = origGetModelForTopic;
    client.complete = origComplete;
  });

  test('no model bound to memory_extraction → returns [] and never calls the LLM', async () => {
    const completeSpy = mock(async () => ({ content: '{"facts":[]}' }));
    registry.getModelForTopic = mock(async () => null) as unknown as typeof registry.getModelForTopic;
    client.complete = completeSpy as unknown as typeof client.complete;

    const facts = await extractFacts({
      userMessage: 'I prefer tabs over spaces and I work mostly in TypeScript',
      userId: 'user-1',
    });

    expect(facts).toEqual([]);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  test('first-person heuristic fails → returns [] before any model lookup', async () => {
    const topicSpy = mock(async () => null);
    registry.getModelForTopic = topicSpy as unknown as typeof registry.getModelForTopic;

    const facts = await extractFacts({ userMessage: 'what time is it?', userId: 'user-1' });

    expect(facts).toEqual([]);
    // The cheap pronoun heuristic must short-circuit before the registry call
    // so a routine query costs zero model lookups.
    expect(topicSpy).not.toHaveBeenCalled();
  });
});

describe('memory.judge — judgeAndApply input gating', () => {
  test('no candidates → [] (no repo/embedding work)', async () => {
    const outcomes = await judgeAndApply([], { userId: 'user-1' });
    expect(outcomes).toEqual([]);
  });
});
