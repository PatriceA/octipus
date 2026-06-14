/**
 * Memory-redesign Phase D — judge: decides ADD / UPDATE / DELETE /
 * NOOP for each candidate fact emitted by the extractor.
 *
 * For each candidate:
 *   1. Embed the candidate's content (re-using the embedding model
 *      mapped to topic='embedding').
 *   2. Vector-search the user's existing active memories of the same
 *      `fact_type`, top-k=5.
 *   3. Ask an LLM to pick exactly one action against the closest
 *      match (or against the empty list when none exist).
 *   4. Apply the action via MemoryRepository.
 *
 * The LLM judge call is small and structured. We keep the prompt
 * surface minimal so a cheap model bound to topic='memory_extraction'
 * is enough.
 */

import { buildEmbeddingVersion, EmbeddingService } from '@/core/rag/embeddings';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { filterPII } from '@/core/orchestrator/pii-filter';
import { SECURITY_PREAMBLE } from '@/core/orchestrator/roles';
import type { Memory } from '@/db/schema/memories';
import type { CandidateFact } from './extractor';
import { getMemoryRepository } from './repository';

export type JudgeAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export interface JudgeContext {
  userId: string;
  workspaceId?: string | null;
  agentScope?: string | null;
  sourceMessageId?: string | null;
}

export interface JudgeOutcome {
  action: JudgeAction;
  candidate: CandidateFact;
  /** ID of the row affected (for UPDATE/DELETE) or the newly created row (ADD). */
  memoryId?: string;
  /** Closest existing fact at the time of the decision. */
  matchedAgainst?: { id: string; content: string; similarity: number };
}

const JUDGE_SYSTEM_PROMPT = `${SECURITY_PREAMBLE}

You are a memory judge. Given a NEW candidate fact about a user and the
single CLOSEST existing fact already stored, choose exactly one action:

  ADD    — the candidate is genuinely new information, not redundant with
           the existing fact. Use when the existing fact is unrelated or
           the list is empty.
  UPDATE — the candidate refines, contradicts, or replaces the existing
           fact (e.g. they used to prefer X, now prefer Y; corrected
           location; revised relationship).
  DELETE — the candidate explicitly negates the existing fact and the
           user wants it forgotten (e.g. "actually, I don't work at Acme
           anymore" with no replacement fact).
  NOOP   — the candidate restates the existing fact with no new
           information.

Output ONLY valid JSON, no prose, no markdown fences:

{ "action": "ADD" | "UPDATE" | "DELETE" | "NOOP" }`;

/** Pure parser — broken out for testing. */
export function parseJudgeAction(raw: string): JudgeAction | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const obj = JSON.parse(cleaned) as { action?: unknown };
    if (obj && typeof obj.action === 'string') {
      const a = obj.action.toUpperCase();
      if (a === 'ADD' || a === 'UPDATE' || a === 'DELETE' || a === 'NOOP') return a;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function decide(candidate: CandidateFact, closest: Memory | null, userId: string): Promise<JudgeAction> {
  // Empty list shortcut — no LLM call needed.
  if (!closest) return 'ADD';

  const model = await getModelRegistry().getModelForTopic('memory_extraction');
  if (!model) {
    // No judge model configured — be conservative and skip.
    coreLogger.debug('memory.judge: no model bound to topic="memory_extraction" — defaulting to NOOP');
    return 'NOOP';
  }

  const userMsg =
    `CANDIDATE (fact_type=${candidate.factType}, confidence=${candidate.confidence}):\n${candidate.content}\n\n` +
    `CLOSEST EXISTING (fact_type=${closest.factType}, confidence=${closest.confidence}):\n${closest.content}`;

  try {
    const result = await getLiteLLMClient().complete({
      model: model.modelId,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT, timestamp: new Date() },
        { role: 'user', content: userMsg, timestamp: new Date() },
      ],
      temperature: 0,
      maxTokens: 50,
      // Strict-JSON prompt; request JSON mode for reliable parsing on small
      // local models (falls back to NOOP if the model ignores it).
      responseFormat: { type: 'json_object' },
      userId,
    });
    return parseJudgeAction(result.content ?? '') ?? 'NOOP';
  } catch (err) {
    coreLogger.warn({ err }, 'memory.judge: LLM call failed — defaulting to NOOP');
    return 'NOOP';
  }
}

/**
 * Redact PII from a candidate fact before it reaches the vector store.
 *
 * Policy: redact-not-drop. If the extractor said "the user's email
 * is alice@example.com", we want to keep the fact ("the user has a
 * known email") but never store the email itself. The redacted form
 * is `"the user's email is [EMAIL]"`, which the judge can still
 * cluster with other email-related facts but never leaks the
 * literal address.
 *
 * If any redactions happened the candidate's confidence is knocked
 * down by 0.2 (floor 0.5 — extractor already dropped anything below)
 * because the surviving fact is less specific and more easily
 * confused with a future genuine email mention.
 */
function redactPII(candidate: CandidateFact): CandidateFact {
  const result = filterPII(candidate.content);
  if (!result.hasRedactions) return candidate;
  return {
    factType: candidate.factType,
    content: result.filtered,
    confidence: Math.max(0.5, candidate.confidence - 0.2),
  };
}

export async function judgeAndApply(
  candidates: CandidateFact[],
  ctx: JudgeContext,
): Promise<JudgeOutcome[]> {
  if (candidates.length === 0) return [];

  const repo = getMemoryRepository();
  const embeddings = new EmbeddingService();
  const outcomes: JudgeOutcome[] = [];

  // PII pre-pass: redact emails, phone numbers, SSNs, API keys, etc.
  // before any fact lands in the vector store. The redacted form
  // preserves the fact's semantic shape (same fact_type, same
  // ADD/UPDATE clustering target) while never persisting the literal
  // PII. Caller-side filterPII happens at the conversation surface;
  // this is the last-mile defence for the memory store.
  const safeCandidates = candidates.map(redactPII);

  // Resolve the embedding model once per batch (was previously
  // re-looked-up inside both ADD and UPDATE branches per candidate).
  // Stored as `<model>/<dim>` via the canonical buildEmbeddingVersion
  // helper so memories rows stay in sync with the embeddings table's
  // versioning scheme.
  const embeddingModel = await getModelRegistry().getModelForTopic('embedding');
  const embeddingModelId = embeddingModel?.modelId ?? 'unknown';

  for (const candidate of safeCandidates) {
    let queryVec: number[];
    try {
      queryVec = await embeddings.generateEmbedding(candidate.content);
    } catch (err) {
      coreLogger.warn({ err, fact: candidate.content.slice(0, 60) }, 'memory.judge: embed failed — skipping');
      continue;
    }
    const similar = await repo.searchSimilar(queryVec, {
      userId: ctx.userId,
      agentScope: ctx.agentScope ?? null,
      factType: candidate.factType,
      limit: 1,
    });
    const closest = similar[0] ?? null;
    const action = await decide(candidate, closest, ctx.userId);
    const matchedAgainst = closest
      ? { id: closest.id, content: closest.content, similarity: closest.similarity }
      : undefined;

    const embeddingVersion = buildEmbeddingVersion(embeddingModelId, queryVec.length);

    try {
      if (action === 'ADD') {
        const created = await repo.addNew({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId ?? null,
          agentScope: ctx.agentScope ?? null,
          factType: candidate.factType,
          content: candidate.content,
          embedding: queryVec,
          embeddingVersion,
          sourceMessageId: ctx.sourceMessageId ?? null,
          confidence: candidate.confidence,
        });
        outcomes.push({ action, candidate, memoryId: created.id, matchedAgainst });
      } else if (action === 'UPDATE' && closest) {
        const created = await repo.supersede(closest.id, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId ?? null,
          agentScope: ctx.agentScope ?? null,
          factType: candidate.factType,
          content: candidate.content,
          embedding: queryVec,
          embeddingVersion,
          sourceMessageId: ctx.sourceMessageId ?? null,
          confidence: candidate.confidence,
        });
        outcomes.push({ action, candidate, memoryId: created.id, matchedAgainst });
      } else if (action === 'DELETE' && closest) {
        await repo.softDelete(closest.id);
        outcomes.push({ action, candidate, memoryId: closest.id, matchedAgainst });
      } else {
        outcomes.push({ action: 'NOOP', candidate, matchedAgainst });
      }
    } catch (err) {
      coreLogger.warn({ err, action, fact: candidate.content.slice(0, 60) }, 'memory.judge: apply failed');
    }
  }

  return outcomes;
}
