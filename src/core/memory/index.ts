/**
 * Memory-redesign Phase D — public entry points.
 *
 * Auto-fires from the root agent and every specialist on every
 * turn. The extractor short-circuits unless the operator has bound
 * a model to topic='memory_extraction' so this costs nothing until
 * opt-in. See `src/core/agent/service.ts` (top-of-turn
 * retrieval + post-turn fire-and-forget update) and
 * `src/core/agent/worker-spawner.ts` (per-specialist
 * injection).
 */

import { extractFacts } from './extractor';
import { judgeAndApply, type JudgeContext, type JudgeOutcome } from './judge';

export { extractFacts, looksWorthExtracting, parseExtractorResponse, type CandidateFact, type ExtractorInput } from './extractor';
export { judgeAndApply, JUDGE_RELEVANCE_FLOOR, parseJudgeAction, relevantClosest, type JudgeAction, type JudgeContext, type JudgeOutcome } from './judge';
export { retrieveForContext, renderMemoriesBlock } from './retrieval';
export { getMemoryRepository, MemoryRepository, type MemoryAccessScope } from './repository';

export interface UpdateMemoriesInput extends JudgeContext {
  userMessage: string;
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * One-shot extract-then-judge-then-apply for a user turn. Returns
 * the outcome list so callers can log / surface what changed. Throws
 * only on unexpected failures — the extractor and judge both swallow
 * their own LLM errors and return empty/NOOP, so the typical failure
 * mode is "nothing happens" rather than a thrown error.
 */
export async function updateMemoriesAfterTurn(input: UpdateMemoriesInput): Promise<JudgeOutcome[]> {
  const candidates = await extractFacts({
    userMessage: input.userMessage,
    recentTurns: input.recentTurns,
    userId: input.userId,
  });
  if (candidates.length === 0) return [];
  return judgeAndApply(candidates, {
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    agentScope: input.agentScope ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
  });
}
