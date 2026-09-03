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

import { buildEmbeddingVersion, embedPrefixTag, EmbeddingService } from '@/core/rag/embeddings';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { filterPII } from '@/core/agent/pii-filter';
import { SECURITY_PREAMBLE } from '@/core/agent/roles';
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

/**
 * Cosine similarity below which the nearest stored memory is treated as
 * unrelated to the candidate — the judge is not asked, and the candidate is
 * ADDed. Deliberately low: the cost of being wrong above it is one redundant
 * judge call, and the cost of being wrong below it is a fact the user told us
 * and we threw away.
 */
export const JUDGE_RELEVANCE_FLOOR = 0.5;

/**
 * The nearest stored memory, or null when it is too far away to be about the
 * same thing. Pure, so the branch that decides whether a fact survives has a
 * check that does not need an embedding model and a database behind it.
 */
export function relevantClosest<T extends { similarity: number }>(nearest: T | null | undefined): T | null {
  if (!nearest) return null;
  return nearest.similarity >= JUDGE_RELEVANCE_FLOOR ? nearest : null;
}

async function decide(candidate: CandidateFact, closest: Memory | null, userId: string): Promise<JudgeAction> {
  // Empty list shortcut — no LLM call needed.
  if (!closest) return 'ADD';

  const model = await getModelRegistry().getModelForTopic('background');
  if (!model) {
    // No judge model configured — be conservative and skip.
    coreLogger.debug('memory.judge: no model bound to the "background" topic — defaulting to NOOP');
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
  // Same prefix tag the embeddings table stamps, so memory rows and KB rows
  // agree on what "written under this vector space" means.
  const embeddingPrefixTag = embedPrefixTag(embeddingModel?.metadata?.embedPrefixes);

  for (const candidate of safeCandidates) {
    let queryVec: number[];
    try {
      // Document side on purpose: this vector is BOTH the dedup probe and the
      // vector persisted for the memory row, and every memory goes through this
      // one path — so the corpus stays self-consistent. Switching it to 'query'
      // would compare a query-prefixed vector against document-prefixed rows.
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
    // `searchSimilar` returns the nearest neighbour with no floor, so on a
    // sparse corpus "closest" can be an unrelated fact. Handing that pair to
    // the judge asks it to compare two things that have nothing to do with
    // each other, and `decide` fails CLOSED (NOOP) — so a genuinely new fact
    // was being silently dropped because the user happened to have one
    // unrelated memory already. Below the floor there is nothing to restate,
    // refine or negate, which is the definition of ADD.
    //
    // This is the mirror of the verbatim guard below, and the reason the
    // threshold argument there does not apply in this direction: a
    // contradiction ("prefers spaces" vs stored "prefers tabs") embeds CLOSE
    // to the fact it negates, so it stays above the floor and still reaches
    // the judge.
    const nearest = similar[0] ?? null;
    const closest = relevantClosest(nearest);
    // Deterministic duplicate guard: NOOP without the (small, lenient) LLM judge
    // ONLY when the candidate is a VERBATIM restatement of the closest memory.
    // Identical text cannot be a contradiction, so short-circuiting it is safe
    // (and skips the judge call).
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const action = closest && norm(closest.content) === norm(candidate.content)
      ? 'NOOP'
      : await decide(candidate, closest, ctx.userId);
    const matchedAgainst = closest
      ? { id: closest.id, content: closest.content, similarity: closest.similarity }
      : undefined;

    const embeddingVersion = buildEmbeddingVersion(embeddingModelId, queryVec.length, embeddingPrefixTag);

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
