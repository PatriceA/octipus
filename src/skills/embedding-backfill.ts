/**
 * Keep the stored embeddings that skill dedup compares by up to date.
 *
 * `ensureSkillEmbeddings` embeds DB skills whose `description_embedding` is
 * NULL or whose `description_hash` no longer matches sha256(name + '\n' +
 * description) (a direct DB edit that missed the invalidation).
 * `ensureProposalEmbeddings` embeds a user's open (pending, candidate) and
 * still-suppressed rejected non-patch proposals whose `embedding` is NULL: a
 * merge recomputes it whenever it changes the text, so NULL is the only stale
 * state there.
 *
 * Both do nothing when the embedding capability is off. A missing embedding
 * model is logged once per process and counted as `noModel`; one row the
 * provider fails on is logged and counted as `failed`, and the rest go on.
 * Database errors throw.
 *
 * Called before every dedup comparison (limit 20), by the daily
 * consolidation, and by scripts/backfill-skill-embeddings.ts (no limit).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { capabilityConfigured } from '@/core/capabilities/gates';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getDb } from '@/db/postgres';
import { skillProposals } from '@/db/schema/skill-proposals';
import { skills } from '@/db/schema/skills';
import { coreLogger } from '@/utils/logger';

/** Rows embedded concurrently; keeps the embedding provider from being hammered. */
const BATCH_SIZE = 20;

export interface EmbeddingBackfillResult {
  /** Rows that needed an embedding (at most `limit`). */
  stale: number;
  embedded: number;
  failed: number;
  /** No embedding model is configured: nothing was attempted (or the first attempt said so). */
  noModel: boolean;
}

export interface EmbeddingBackfillOptions {
  /** Most rows embedded in this call. Omitted: all of them. */
  limit?: number;
  /** Progress after each batch (the backfill script logs it). */
  onBatch?: (progress: { batch: number; of: number; embedded: number; failed: number }) => void;
}

/** sha256 of `name\ndescription`: what `skills.description_hash` records. */
export function skillDescriptionHash(name: string, description: string): string {
  return createHash('sha256').update(`${name}\n${description}`).digest('hex');
}

/** The text a skill or proposal is embedded by (the same as `similarityText`). */
function embeddingText(row: { name: string; description: string }): string {
  return `${row.name}\n${row.description}`;
}

let warnedNoModel = false;

function isNoEmbeddingModel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('No model mapped to topic "embedding"')
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'capability_not_configured');
}

function warnNoModelOnce(component: string): void {
  if (warnedNoModel) return;
  warnedNoModel = true;
  coreLogger.warn({ component }, 'No embedding model configured: skill and proposal embeddings are not computed, dedup compares names only. Assign a model to the embedding topic on the Models page.');
}

interface Row { id: string; name: string; description: string }

/**
 * Embed `rows` in batches and store each vector with `store`. The first row
 * goes alone, so a missing model stops the run after one attempt.
 */
async function embedRows(
  rows: Row[],
  store: (row: Row, embedding: number[]) => Promise<void>,
  component: string,
  onBatch: EmbeddingBackfillOptions['onBatch'],
): Promise<EmbeddingBackfillResult> {
  const result: EmbeddingBackfillResult = { stale: rows.length, embedded: 0, failed: 0, noModel: false };
  if (rows.length === 0) return result;
  const service = getEmbeddingService();
  const embedOne = async (row: Row) => store(row, await service.generateEmbedding(embeddingText(row), 'document'));

  try {
    await embedOne(rows[0]);
    result.embedded++;
  } catch (err) {
    if (isNoEmbeddingModel(err)) {
      warnNoModelOnce(component);
      result.noModel = true;
      return result;
    }
    coreLogger.error({ err, id: rows[0].id, name: rows[0].name, component }, 'Embedding backfill: row failed (continuing)');
    result.failed++;
  }

  const rest = rows.slice(1);
  const of = Math.ceil(rest.length / BATCH_SIZE);
  for (let start = 0, batch = 1; start < rest.length; start += BATCH_SIZE, batch++) {
    const slice = rest.slice(start, start + BATCH_SIZE);
    const settled = await Promise.allSettled(slice.map(embedOne));
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled') { result.embedded++; return; }
      result.failed++;
      coreLogger.error({ err: res.reason, id: slice[i].id, name: slice[i].name, component }, 'Embedding backfill: row failed (continuing)');
    });
    onBatch?.({ batch, of, embedded: result.embedded, failed: result.failed });
  }
  return result;
}

/** DB skills (system and every user's) whose embedding is missing or stale. */
export async function ensureSkillEmbeddings(opts: EmbeddingBackfillOptions = {}): Promise<EmbeddingBackfillResult> {
  if (!(await capabilityConfigured('embedding'))) return { stale: 0, embedded: 0, failed: 0, noModel: true };
  const db = getDb();
  // The vector itself is not read: whether it is there is enough. The hash
  // check is in TS (sha256 in SQL differs across Postgres and PGlite builds).
  const all = await db.select({
    id: skills.id,
    name: skills.name,
    description: skills.description,
    descriptionHash: skills.descriptionHash,
    missing: sql<boolean>`${skills.descriptionEmbedding} is null`,
  }).from(skills);
  const stale = all.filter((row) => !row.id.startsWith('external:')
    && (row.missing || row.descriptionHash !== skillDescriptionHash(row.name, row.description)));
  const rows = opts.limit === undefined ? stale : stale.slice(0, opts.limit);
  return embedRows(rows, async (row, embedding) => {
    await db.update(skills).set({
      descriptionEmbedding: embedding,
      descriptionHash: skillDescriptionHash(row.name, row.description),
      updatedAt: new Date(),
    }).where(eq(skills.id, row.id));
  }, 'skill-embeddings', opts.onBatch);
}

/**
 * `userId`'s non-patch proposals that dedup compares against (open, or
 * rejected and still suppressed) and that have no embedding yet, newest first.
 */
export async function ensureProposalEmbeddings(userId: string, opts: EmbeddingBackfillOptions = {}): Promise<EmbeddingBackfillResult> {
  if (!(await capabilityConfigured('embedding'))) return { stale: 0, embedded: 0, failed: 0, noModel: true };
  const db = getDb();
  const query = db.select({ id: skillProposals.id, name: skillProposals.name, description: skillProposals.description })
    .from(skillProposals)
    .where(and(
      eq(skillProposals.userId, userId),
      ne(skillProposals.kind, 'patch'),
      isNull(skillProposals.embedding),
      or(
        inArray(skillProposals.status, ['pending', 'candidate']),
        and(eq(skillProposals.status, 'rejected'), gt(skillProposals.rejectedUntil, new Date())),
      ),
    ))
    .orderBy(desc(skillProposals.createdAt));
  const rows = opts.limit === undefined ? await query : await query.limit(opts.limit);
  return embedRows(rows, async (row, embedding) => {
    // Only while the text is the one embedded: a merge in between has stored its own.
    await db.update(skillProposals).set({ embedding })
      .where(and(eq(skillProposals.id, row.id), eq(skillProposals.name, row.name), eq(skillProposals.description, row.description)));
  }, 'proposal-embeddings', opts.onBatch);
}
