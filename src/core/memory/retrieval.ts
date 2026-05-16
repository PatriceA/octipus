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
import { type MemoryAccessScope, getMemoryRepository } from './repository';

export async function retrieveForContext(scope: MemoryAccessScope & { limit?: number }): Promise<Memory[]> {
  const repo = getMemoryRepository();
  const rows = await repo.retrieveTop(scope);
  repo.recordAccess(rows.map((r) => r.id));
  return rows;
}

/**
 * Format a list of memories as a compact system-prompt block.
 * Returns the empty string when there's nothing to surface so the
 * caller can do `system += renderMemoriesBlock(rows)` without
 * conditional logic. Confidence is rendered next to inferred facts
 * (< 0.9) so the LLM treats hedged memories as soft signal rather
 * than gospel.
 */
export function renderMemoriesBlock(rows: Memory[]): string {
  if (rows.length === 0) return '';
  const lines = rows.map((m) => {
    const conf = typeof m.confidence === 'number' ? m.confidence : 1;
    const tag = conf < 0.9 ? `${m.factType}, p≈${conf.toFixed(2)}` : m.factType;
    return `- (${tag}) ${m.content}`;
  });
  return `\n\nKnown about the user (long-term memory):\n${lines.join('\n')}\n`;
}
