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
 *
 * Memory learns only from the owner's own words: the extractor sees the
 * owner's messages as the only citable evidence, and every candidate is
 * checked against the stored messages it cites before the judge may write it
 * (`quote-basis.ts`, `owner-messages.ts`).
 */

import { capabilityConfigured } from '@/core/capabilities/gates';
import { coreLogger } from '@/utils/logger';
import { extractFacts, looksWorthExtracting, MAX_OWNER_MESSAGE_CHARS, type OwnerTurn } from './extractor';
import { judgeAndApply, type JudgeContext, type JudgeOutcome } from './judge';
import { verifyOwnerQuotes } from './owner-messages';

export { extractFacts, looksWorthExtracting, parseExtractorResponse, type CandidateFact, type ExtractorInput, type OwnerTurn } from './extractor';
export { judgeAndApply, JUDGE_RELEVANCE_FLOOR, parseJudgeAction, relevantClosest, type JudgeAction, type JudgeContext, type JudgeOutcome } from './judge';
export { retrieveForContext, renderMemoriesBlock, DEFAULT_MEMORY_TOKEN_BUDGET, RELEVANT_CANDIDATE_LIMIT, type MemoryContextScope } from './retrieval';
export { getMemoryRepository, MemoryRepository, type MemoryAccessScope } from './repository';
export { checkQuoteBasis, normalizeQuoteText, verifyQuotes, type QuoteBasis, type VerifiedFact } from './quote-basis';

export interface UpdateMemoriesInput extends Omit<JudgeContext, 'failOnError'> {
  /** The owner's own stored messages (role='user'), oldest first: the only evidence a memory may cite. */
  ownerMessages: OwnerTurn[];
  /** Earlier turns, oldest first, shown to the extractor to resolve references. Never citable. */
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** Owner messages per extractor call, and the characters they may take together. */
export const EXTRACTION_BATCH_MESSAGES = 8;
export const EXTRACTION_BATCH_CHARS = 6000;
/** Extractor calls per update: a long compacted prefix is read newest first, up to this many. */
export const MAX_EXTRACTION_BATCHES = 3;

/**
 * Group the messages worth reading into batches, oldest first. When they need
 * more than `MAX_EXTRACTION_BATCHES`, the newest are kept. Pure.
 */
export function ownerBatches(messages: readonly OwnerTurn[]): { batches: OwnerTurn[][]; skipped: number } {
  const worth = messages.filter((m) => looksWorthExtracting(m.content));
  const batches: OwnerTurn[][] = [];
  let current: OwnerTurn[] = [];
  let chars = 0;
  for (const message of [...worth].reverse()) {
    const size = Math.min(message.content.length, MAX_OWNER_MESSAGE_CHARS);
    if (current.length > 0 && (current.length >= EXTRACTION_BATCH_MESSAGES || chars + size > EXTRACTION_BATCH_CHARS)) {
      batches.push(current.reverse());
      current = [];
      chars = 0;
    }
    current.push(message);
    chars += size;
  }
  if (current.length > 0) batches.push(current.reverse());
  const kept = batches.slice(0, MAX_EXTRACTION_BATCHES);
  const skipped = batches.slice(MAX_EXTRACTION_BATCHES).reduce((n, b) => n + b.length, 0);
  return { batches: kept.reverse(), skipped };
}

/**
 * Extract-then-verify-then-judge-then-apply over the owner's messages. Returns
 * the outcome list so callers can log / surface what changed. Throws only on
 * unexpected failures — the extractor and judge both swallow their own LLM
 * errors and return empty/NOOP, so the typical failure mode is "nothing
 * happens" rather than a thrown error.
 */
export async function updateMemoriesAfterTurn(input: UpdateMemoriesInput): Promise<JudgeOutcome[]> {
  // A memory row carries its embedding: without an embedding model nothing is
  // extracted, so no background model call is spent on facts that cannot be kept.
  if (!(await capabilityConfigured('embedding'))) return [];
  const { batches, skipped } = ownerBatches(input.ownerMessages);
  if (skipped > 0) coreLogger.info({ skipped, read: batches.flat().length }, 'memory: older owner messages not read for extraction this pass');
  const outcomes: JudgeOutcome[] = [];
  for (const batch of batches) {
    const candidates = await extractFacts({ ownerMessages: batch, context: input.context, userId: input.userId });
    if (candidates.length === 0) continue;
    const { accepted } = await verifyOwnerQuotes(input.userId, candidates);
    if (accepted.length === 0) continue;
    outcomes.push(...await judgeAndApply(accepted, {
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      agentScope: input.agentScope ?? null,
    }));
  }
  return outcomes;
}
