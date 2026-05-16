/**
 * Memory-redesign Phase D — public entry points.
 *
 * The orchestrator hook lands in a follow-up PR: this module ships
 * the pieces but does NOT auto-fire on every turn. The reason: the
 * extractor + judge each cost one LLM call per turn, and the operator
 * must first map a model to topic='memory_extraction'. Wiring this
 * before the operator opts in would silently spend tokens.
 *
 * Recommended call sites once enabled:
 *
 *   // Turn-start (before LLM call):
 *   const ctx = await retrieveForContext({ userId, agentScope: role });
 *   systemPrompt += renderMemoriesBlock(ctx);
 *
 *   // Turn-end (after the user's reply is persisted):
 *   updateMemoriesAfterTurn({ userId, agentScope: role, sourceMessageId: m.id,
 *     userMessage: m.content }).catch(noop);   // fire-and-forget
 */

import { extractFacts } from './extractor';
import { judgeAndApply, type JudgeContext, type JudgeOutcome } from './judge';

export { extractFacts, looksWorthExtracting, parseExtractorResponse, type CandidateFact, type ExtractorInput } from './extractor';
export { judgeAndApply, parseJudgeAction, type JudgeAction, type JudgeContext, type JudgeOutcome } from './judge';
export { retrieveForContext, retrieveSemantic, renderMemoriesBlock } from './retrieval';
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
