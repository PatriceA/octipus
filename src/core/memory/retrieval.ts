/**
 * Memory-redesign Phase D — turn-start retrieval.
 *
 * `retrieveForContext(scope)` — the memories to put in front of the model this
 * turn. The root agent and every specialist inject these into their system
 * context, no LLM call on the default path.
 *
 * Two orderings, and the reason there are two (daily-driver plan, Phase 6)
 * ───────────────────────────────────────────────────────────────────────
 * `retrieveTop` ranks by access_count + recency. That is the right answer to
 * "what is always worth knowing" and the wrong one to "what bears on THIS
 * question", because it does not look at the question. While the whole corpus
 * fits the token budget the distinction is academic — everything is injected
 * either way — and for a new user it always fits.
 *
 * Once it does not fit, ranking by frequency alone measurably loses facts (see
 * `recall.test.ts`, which runs the numbers): the block becomes the same twenty
 * rows every turn, and because `recordAccess` bumps exactly the rows it just
 * returned, those twenty keep winning. A fact learned last week starts at
 * access_count 0 and can never climb past them. So above the budget we ask the
 * corpus a second question — nearest the turn — and interleave the two answers,
 * which bounds each ordering's share of the block instead of letting either
 * take all of it.
 *
 * Everything about the semantic pass is opt-out-by-default-safe: no query text,
 * no embedding model, or an embedding call that throws, and the result is
 * exactly what this module returned before Phase 6.
 *
 * `retrieveSemantic` was removed in the post-implementation cleanup
 * — exported but never called, and the silent factType default
 * violated the fail-loud rule. `retrieveRelevant` is its replacement, with the
 * call site the old one lacked.
 */

import type { Memory } from '@/db/schema/memories';
import { coreLogger } from '@/utils/logger';
import { estimateTokens } from '@/utils/token-count';
import { getMemoryRepository, type MemoryAccessScope } from './repository';

// Default token budget for the injected memory block (Phase 5). Sized to
// roughly the PRIOR footprint (the old flat 8–12 short rows ≈ 150–250 tok) so
// the token cap TRIMS large rows without silently injecting MORE than before —
// the win is bounding oversized rows, not admitting more of them.
export const DEFAULT_MEMORY_TOKEN_BUDGET = 250;

/**
 * How many relevance-ranked candidates to consider. Roughly half the default
 * row limit: the interleave alternates between the two lists, so this is the
 * most relevance can claim, and the rest of the block stays the standing facts.
 */
export const RELEVANT_CANDIDATE_LIMIT = 8;

const HEADER = '\n\nKnown about the user (long-term memory):\n';

function renderLine(m: Memory): string {
  const conf = typeof m.confidence === 'number' ? m.confidence : 1;
  const tag = conf < 0.9 ? `${m.factType}, p≈${conf.toFixed(2)}` : m.factType;
  return `- (${tag}) ${m.content}`;
}

/**
 * Greedily keep the highest-value rows that fit `tokenBudget`, skipping a row
 * too large for the remaining budget while still scanning cheaper high-value
 * rows after it (value-per-token, not first-fit).
 *
 * Shared by the renderer and by `retrieveForContext`, which needs the same
 * arithmetic to answer a different question: did anything get dropped? If not,
 * every fact the user has is already in the block and ranking it would be
 * effort spent to reorder a list nobody will see truncated.
 */
function fitToBudget(rows: Memory[], tokenBudget: number): { lines: string[]; used: number; dropped: number } {
  let used = estimateTokens(HEADER);
  const lines: string[] = [];
  let dropped = 0;
  for (const m of rows) {
    const line = renderLine(m);
    const cost = estimateTokens(line) + 1; // +1 for the joining newline
    if (used + cost > tokenBudget) {
      dropped++;
      continue; // skip; a cheaper later row may fit
    }
    lines.push(line);
    used += cost;
  }
  return { lines, used, dropped };
}

/**
 * Alternate between two ranked lists, `a` first, dropping rows already taken.
 *
 * Alternating rather than concatenating is the guarantee: neither ordering can
 * fill the block on its own, so the most relevant fact is always present AND
 * the standing facts are never all evicted by one topical question.
 */
function interleave(a: Memory[], b: Memory[], limit: number): Memory[] {
  const seen = new Set<string>();
  const out: Memory[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < limit; i++) {
    for (const row of [a[i], b[i]]) {
      if (!row || seen.has(row.id) || out.length >= limit) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

export interface MemoryContextScope extends MemoryAccessScope {
  /** Candidate rows to fetch per ordering. Trimmed to the token budget after. */
  limit?: number;
  /**
   * What the turn is about — the user's message, or a worker's task. Present:
   * memories are also ranked against it once the corpus outgrows the budget.
   * Absent: frequency + recency only, exactly as before Phase 6.
   */
  query?: string;
  /** Budget the caller will render with. Only affects whether ranking runs. */
  tokenBudget?: number;
}

export async function retrieveForContext(scope: MemoryContextScope): Promise<Memory[]> {
  const repo = getMemoryRepository();
  const limit = scope.limit ?? 20;
  const budget = scope.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET;

  // One row past the limit, so "the corpus fits" is a fact rather than a guess:
  // a full page could always have had a 21st row behind it.
  const standing = await repo.retrieveTop({ ...scope, limit: limit + 1 });
  const overflows = standing.length > limit || fitToBudget(standing, budget).dropped > 0;

  let rows = standing.slice(0, limit);
  if (overflows && scope.query?.trim()) {
    const relevant = await rankAgainstTurn(scope, limit);
    if (relevant.length > 0) rows = interleave(relevant, rows, limit);
  }

  repo.recordAccess(rows.map((r) => r.id));
  return rows;
}

/**
 * The memories nearest this turn, or an empty list if we cannot ask.
 *
 * Never throws: an embedding provider that is down, unbound or slow must cost
 * the turn its ranking, not its memory. The caller keeps the frequency-ordered
 * block, which is what it would have had anyway.
 */
async function rankAgainstTurn(scope: MemoryContextScope, limit: number): Promise<Memory[]> {
  try {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const vector = await getEmbeddingService().generateEmbedding(scope.query as string);
    return await getMemoryRepository().retrieveRelevant(vector, {
      ...scope,
      limit: Math.min(RELEVANT_CANDIDATE_LIMIT, limit),
    });
  } catch (err) {
    coreLogger.debug({ err }, 'memory relevance ranking skipped — falling back to access + recency');
    return [];
  }
}

/**
 * Format a list of memories as a compact system-prompt block, bounded by a
 * TOKEN budget rather than a flat row count (Phase 5). Rows arrive pre-ranked;
 * this keeps the highest-value ones that fit. Returns the empty string when
 * there's nothing to surface so the caller can do
 * `system += renderMemoriesBlock(rows)` without conditional logic. Confidence
 * is rendered next to inferred facts (< 0.9) so the LLM treats hedged memories
 * as soft signal rather than gospel.
 */
export function renderMemoriesBlock(
  rows: Memory[],
  tokenBudget: number = DEFAULT_MEMORY_TOKEN_BUDGET,
): string {
  if (rows.length === 0) return '';
  const { lines, used, dropped } = fitToBudget(rows, tokenBudget);
  // Fail loud: an operator debugging "agent forgot a known fact" needs to see
  // that memory was budget-trimmed, not silently absent.
  if (dropped > 0) {
    coreLogger.debug(
      { rendered: lines.length, dropped, tokenBudget, usedTokens: used },
      'memory block trimmed to token budget',
    );
  }
  if (lines.length === 0) return '';
  return `${HEADER}${lines.join('\n')}\n`;
}
