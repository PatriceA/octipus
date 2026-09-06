/**
 * Memory-aware eval setup (roadmap: "Now" + wave 3).
 *
 * The harness could assert on what a reply says, never on what the system
 * REMEMBERED. Neither mode could pre-seed the `memories` table, so the Phase D
 * extractor → judge → retrieval pipeline had coverage on its data layer only:
 * every test of "does a known fact reach the answer" had to be run by hand.
 *
 * `memorySetup` on a test seeds facts for its user before the request and
 * removes them afterwards; `recalls_memory` asserts the reply used them.
 *
 * Two deliberate refusals, both so a green run means what it says:
 *
 *  - Facts are embedded through the real embedding service, exactly as
 *    `memory/judge.ts` does. A placeholder vector would insert a row of a
 *    dimension nothing else in the table has, and the HNSW pinning in
 *    migration 0055 keys off that homogeneity.
 *  - A seeded test only runs in INTEGRATION mode. Unit mode never reads the
 *    memories table, so the assertion could only ever fail there, and a
 *    permanently-red test teaches nothing.
 */

import { eq, inArray } from 'drizzle-orm';

/** One fact to seed. Mirrors the columns a real extracted memory carries. */
export interface MemorySeed {
  /** preference | profile | relationship | skill_observation | workflow_note */
  factType: string;
  /** One atomic fact, one sentence — the same contract the extractor honours. */
  content: string;
  /** Role scope. Absent ⇒ visible to every role, which is the usual case. */
  agentScope?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a seeded test cannot run, or null when it can. Pure, so the loader and
 * the runner can both ask without touching a DB.
 */
export function memorySetupBlocker(
  seeds: MemorySeed[] | undefined,
  opts: { integration?: boolean; userId?: string },
): string | null {
  if (!seeds?.length) return null;
  if (!opts.integration) {
    return 'memorySetup requires --integration: unit mode never reads the memories table, ' +
      'so a recalls_memory assertion could only ever fail.';
  }
  if (!opts.userId || !UUID_RE.test(opts.userId)) {
    return `memorySetup requires context.userId to be a real user UUID (got "${opts.userId ?? 'unset'}") — ` +
      'memories.user_id is a uuid column and the fact has to be seeded for the user the request runs as.';
  }
  return null;
}

/**
 * Insert the seeds and return their row ids. Throws when embedding is
 * unavailable — a seeded test that silently ran without its facts would report
 * a recall failure as a model problem.
 */
export async function seedMemories(userId: string, seeds: MemorySeed[]): Promise<string[]> {
  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  const { getMemoryRepository } = await import('@/core/memory/repository');
  const embeddings = getEmbeddingService();
  const repo = getMemoryRepository();

  const ids: string[] = [];
  for (const seed of seeds) {
    let vector: number[];
    try {
      vector = await embeddings.generateEmbedding(seed.content);
    } catch (err) {
      throw new Error(
        `memorySetup could not embed "${seed.content.slice(0, 60)}": ${(err as Error).message}. ` +
          'Bind a model to the `embedding` topic before running memory-aware evals.',
      );
    }
    try {
      const row = await repo.addNew({
        userId,
        workspaceId: null,
        agentScope: seed.agentScope ?? null,
        factType: seed.factType,
        content: seed.content,
        embedding: vector,
        embeddingVersion: `eval/${vector.length}`,
        sourceMessageId: null,
        confidence: 1,
        validUntil: null,
      });
      ids.push(row.id);
    } catch (err) {
      // `memories.user_id` is a foreign key. A well-formed UUID that belongs to
      // nobody passes `memorySetupBlocker` and then fails here, and the raw
      // constraint error does not tell the operator what to change.
      const message = (err as Error).message;
      throw new Error(
        /foreign key|user_id/i.test(message)
          ? `memorySetup could not seed for user ${userId}: no such user in the target install. ` +
            'context.userId must be a user that exists there, not just a valid UUID.'
          : `memorySetup could not seed "${seed.content.slice(0, 60)}": ${message}`,
      );
    }
  }
  return ids;
}

/**
 * Remove seeded rows. A HARD delete, unlike `softDelete`: these are fixtures,
 * not history, and leaving them behind would change what the NEXT test recalls.
 */
export async function clearMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { getDb } = await import('@/db/postgres');
  const { memories } = await import('@/db/schema/memories');
  const db = getDb();
  await db.delete(memories).where(ids.length === 1 ? eq(memories.id, ids[0]) : inArray(memories.id, ids));
}
