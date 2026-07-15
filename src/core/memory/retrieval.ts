/**
 * Memory-redesign Phase D — turn-start retrieval.
 *
 * `retrieveForContext(scope)` — top-N active memories ordered by
 * access_count + recency. The orchestrator and every specialist
 * inject these into their system context every turn, no LLM call.
 * Bumps access_count + last_accessed_at on the rows actually
 * returned (fire-and-forget), so the LFU signal grows organically.
 *
 * `retrieveSemantic` was removed in the post-implementation cleanup
 * — exported but never called, and the silent factType default
 * violated the fail-loud rule. Reintroduce only with an explicit
 * call site and a required factType.
 */

import type { Memory } from '@/db/schema/memories';
import { coreLogger } from '@/utils/logger';
import { estimateTokens } from '@/utils/token-count';
import { type MemoryAccessScope, getMemoryRepository } from './repository';

// Default token budget for the injected memory block (Phase 5). Sized to
// roughly the PRIOR footprint (the old flat 8–12 short rows ≈ 150–250 tok) so
// the token cap TRIMS large rows without silently injecting MORE than before —
// the win is bounding oversized rows, not admitting more of them.
export const DEFAULT_MEMORY_TOKEN_BUDGET = 250;

export async function retrieveForContext(scope: MemoryAccessScope & { limit?: number }): Promise<Memory[]> {
  const repo = getMemoryRepository();
  const rows = await repo.retrieveTop(scope);
  repo.recordAccess(rows.map((r) => r.id));
  return rows;
}

/**
 * Format a list of memories as a compact system-prompt block, bounded by a
 * TOKEN budget rather than a flat row count (Phase 5). Rows arrive pre-ranked
 * by value (access_count + recency); this greedily keeps the highest-value rows
 * that fit and skips a row too large for the remaining budget while still
 * scanning cheaper high-value rows after it (value-per-token, not first-fit).
 * Returns the empty string when there's nothing to surface so the caller can do
 * `system += renderMemoriesBlock(rows)` without conditional logic. Confidence
 * is rendered next to inferred facts (< 0.9) so the LLM treats hedged memories
 * as soft signal rather than gospel.
 */
export function renderMemoriesBlock(
  rows: Memory[],
  tokenBudget: number = DEFAULT_MEMORY_TOKEN_BUDGET,
): string {
  if (rows.length === 0) return '';
  const HEADER = '\n\nKnown about the user (long-term memory):\n';
  let used = estimateTokens(HEADER);
  const lines: string[] = [];
  let dropped = 0;
  for (const m of rows) {
    const conf = typeof m.confidence === 'number' ? m.confidence : 1;
    const tag = conf < 0.9 ? `${m.factType}, p≈${conf.toFixed(2)}` : m.factType;
    const line = `- (${tag}) ${m.content}`;
    const cost = estimateTokens(line) + 1; // +1 for the joining newline
    if (used + cost > tokenBudget) {
      dropped++;
      continue; // skip; a cheaper later row may fit
    }
    lines.push(line);
    used += cost;
  }
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
