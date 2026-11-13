/**
 * What was not indexed because no embedding model was configured, and the
 * catch-up that indexes it once one is (docs/MODULES.md → Capability gates).
 *
 * Without an embedding model nothing is chunked or embedded — not even
 * tried. The entry points that would have indexed something (the document
 * pipeline, notes, repositories, plugin documents) call `recordSkipped`
 * instead. When the `embedding` capability turns on, `runIndexBacklog`
 * indexes exactly the recorded items and deletes each row it finishes. It
 * never re-embeds content that already has vectors.
 */
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { isCapabilityOn, onCapabilitiesChanged } from '@/core/capabilities/gates';
import { getDb } from '@/db/postgres';
import { indexBacklog, type IndexBacklogRow } from '@/db/schema/index-backlog';
import { coreLogger } from '@/utils/logger';

export type BacklogKind = IndexBacklogRow['kind'];

export interface SkippedItem {
  kind: BacklogKind;
  sourceId: string;
  ownerUserId: string;
  workspaceId?: string | null;
  purpose?: string | null;
  metadata?: Record<string, unknown>;
}

/** A row is given up on after this many failed attempts (it stays, with its error, for a person to see). */
export const MAX_BACKLOG_ATTEMPTS = 5;

/**
 * Record an item that was not indexed because no embedding model is
 * configured. Re-recording the same item refreshes it (a note saved twice
 * while off is one row, with the latest purpose).
 */
export async function recordSkipped(item: SkippedItem): Promise<void> {
  await getDb()
    .insert(indexBacklog)
    .values({
      kind: item.kind,
      sourceId: item.sourceId,
      ownerUserId: item.ownerUserId,
      workspaceId: item.workspaceId ?? null,
      purpose: item.purpose ?? null,
      metadata: item.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [indexBacklog.kind, indexBacklog.sourceId],
      set: {
        ownerUserId: item.ownerUserId,
        workspaceId: item.workspaceId ?? null,
        purpose: item.purpose ?? null,
        metadata: item.metadata ?? {},
        attempts: 0,
        lastError: null,
      },
    });
  coreLogger.debug({ kind: item.kind, sourceId: item.sourceId }, 'Not indexed: no embedding model — recorded for catch-up');
}

/** Drop a recorded item (its source was deleted, or it was indexed another way). */
export async function forgetSkipped(kind: BacklogKind, sourceId: string): Promise<void> {
  await getDb().delete(indexBacklog).where(and(eq(indexBacklog.kind, kind), eq(indexBacklog.sourceId, sourceId)));
}

export async function countBacklog(): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(indexBacklog);
  return row?.n ?? 0;
}

/** Index one recorded item. Returns false when its source no longer exists (the row is then dropped). */
export type BacklogIndexer = (row: IndexBacklogRow) => Promise<boolean>;

const indexers: Record<BacklogKind, BacklogIndexer> = {
  async document(row) {
    const { documentRepository } = await import('@/db/repositories/document-repository');
    const doc = await documentRepository.findByIdSystem(row.sourceId);
    if (!doc?.ocrText?.trim()) return false;
    const { getEmbeddingService } = await import('./embeddings');
    const service = getEmbeddingService();
    const owner = { ownerUserId: row.ownerUserId, workspaceId: row.workspaceId };
    const purpose = (row.purpose ?? 'document') as Parameters<typeof service.indexText>[1];
    await service.deleteBySource(owner, purpose, `doc:${doc.id}`);
    const filePath = typeof row.metadata.filePath === 'string' ? row.metadata.filePath : doc.originalName;
    await service.indexText(owner, purpose, `doc:${doc.id}`, doc.ocrText, { filePath }, doc.id);
    return true;
  },
  async note(row) {
    const { getNoteService } = await import('@/core/knowledge/notes');
    return getNoteService().reindexById(row.sourceId);
  },
  async repo(row) {
    const { repoRegistryRepository } = await import('@/db/repositories/repo-registry-repository');
    const repo = await repoRegistryRepository.getById(row.ownerUserId, row.sourceId);
    if (!repo) return false;
    const { indexRepoKnowledge } = await import('@/core/repos/registry-service');
    await indexRepoKnowledge(repo, row.ownerUserId);
    return true;
  },
};

/** Tests: replace how a kind is indexed. */
export function setBacklogIndexerForTest(kind: BacklogKind, indexer: BacklogIndexer): void {
  indexers[kind] = indexer;
}

let running: Promise<{ indexed: number; dropped: number; failed: number }> | null = null;

/**
 * Index everything recorded, oldest first, in batches. Does nothing while no
 * embedding model is configured. One run at a time; a second call joins it.
 */
export function runIndexBacklog(batchSize = 25): Promise<{ indexed: number; dropped: number; failed: number }> {
  if (running) return running;
  running = (async () => {
    const totals = { indexed: 0, dropped: 0, failed: 0 };
    if (!isCapabilityOn('embedding')) return totals;
    const db = getDb();
    // Rows that fail are skipped for the rest of this run (their attempt count
    // rises), so a failing row cannot keep the loop from reaching the others.
    const failedThisRun = new Set<string>();
    for (;;) {
      if (!isCapabilityOn('embedding')) break;
      const rows = await db
        .select()
        .from(indexBacklog)
        .where(lt(indexBacklog.attempts, MAX_BACKLOG_ATTEMPTS))
        .orderBy(asc(indexBacklog.createdAt))
        .limit(batchSize + failedThisRun.size);
      const todo = rows.filter((r) => !failedThisRun.has(`${r.kind}:${r.sourceId}`)).slice(0, batchSize);
      if (todo.length === 0) break;
      for (const row of todo) {
        try {
          const exists = await indexers[row.kind](row);
          await forgetSkipped(row.kind, row.sourceId);
          if (exists) totals.indexed++;
          else totals.dropped++;
        } catch (err) {
          totals.failed++;
          failedThisRun.add(`${row.kind}:${row.sourceId}`);
          const message = err instanceof Error ? err.message : String(err);
          await db.update(indexBacklog)
            .set({ attempts: sql`${indexBacklog.attempts} + 1`, lastError: message.slice(0, 1000) })
            .where(and(eq(indexBacklog.kind, row.kind), eq(indexBacklog.sourceId, row.sourceId)));
          coreLogger.warn({ err, kind: row.kind, sourceId: row.sourceId }, 'Catch-up indexing failed for one item; will retry on the next run');
        }
      }
    }
    if (totals.indexed + totals.dropped + totals.failed > 0) {
      coreLogger.info(totals, 'Catch-up indexing finished (content saved while no embedding model was configured)');
    }
    return totals;
  })().finally(() => { running = null; });
  return running;
}

let started = false;

/**
 * Boot: run the catch-up when an embedding model is configured now, and every
 * time one becomes configured later. Idempotent.
 */
export function startIndexBacklogCatchUp(): void {
  if (started) return;
  started = true;
  const kick = () => runIndexBacklog().catch((err: unknown) => coreLogger.error({ err }, 'Catch-up indexing run failed'));
  if (isCapabilityOn('embedding')) void kick();
  onCapabilitiesChanged((next, previous) => {
    if (next.embedding.on && !previous.embedding.on) void kick();
  });
}
