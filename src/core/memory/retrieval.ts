/**
 * Memory-redesign Phase D — turn-start retrieval.
 *
 * Two flavours, both scoped to `(userId, agentScope ∈ {NULL, role})`:
 *
 *   - `retrieveForContext(scope)` — top-N active memories, ordered by
 *     access_count + recency. The orchestrator injects these into
 *     the system context every turn, no LLM call.
 *
 *   - `retrieveSemantic(query, scope)` — vector top-N over active
 *     memories. Use when a specific agent wants to recall memories
 *     relevant to the current turn's *content* rather than getting
 *     the same "hot list" every time.
 *
 * Both bump access_count + last_accessed_at on the rows actually
 * returned (fire-and-forget), so the LFU signal grows organically.
 */

import { EmbeddingService } from '@/core/rag/embeddings';
import { type Memory } from '@/db/schema/memories';
import { coreLogger } from '@/utils/logger';
import { type MemoryAccessScope, getMemoryRepository } from './repository';

export async function retrieveForContext(scope: MemoryAccessScope & { limit?: number }): Promise<Memory[]> {
  const repo = getMemoryRepository();
  const rows = await repo.retrieveTop(scope);
  repo.recordAccess(rows.map((r) => r.id));
  return rows;
}

export async function retrieveSemantic(
  query: string,
  scope: MemoryAccessScope & { factType?: string; limit?: number },
): Promise<Array<Memory & { similarity: number }>> {
  const repo = getMemoryRepository();
  const embeddings = new EmbeddingService();
  let vec: number[];
  try {
    vec = await embeddings.generateEmbedding(query);
  } catch (err) {
    coreLogger.warn({ err }, 'memory.retrieveSemantic: embedding failed — returning []');
    return [];
  }
  // searchSimilar requires a factType. When the caller doesn't know,
  // run across the known fact types and merge — for now we accept
  // that the caller has to specify; the orchestrator hook will use
  // `retrieveForContext` instead of this path.
  const factType = scope.factType ?? 'preference';
  const rows = await repo.searchSimilar(vec, {
    userId: scope.userId,
    agentScope: scope.agentScope ?? null,
    factType,
    limit: scope.limit,
  });
  repo.recordAccess(rows.map((r) => r.id));
  return rows;
}

/**
 * Format a list of memories as a compact system-prompt block.
 * Returns the empty string when there's nothing to surface — so the
 * caller can do `system += renderMemoriesBlock(rows)` without
 * conditional logic.
 */
export function renderMemoriesBlock(rows: Memory[]): string {
  if (rows.length === 0) return '';
  const lines = rows.map((m) => `- (${m.factType}) ${m.content}`);
  return `\n\nKnown about the user (long-term memory):\n${lines.join('\n')}\n`;
}
