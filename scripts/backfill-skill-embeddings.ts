/**
 * Skill embedding backfill — Phase 2 of skill discovery.
 *
 * Iterates DB-stored skills where `description_embedding IS NULL` OR
 * `description_hash != sha256(name + '\n' + description)` (catches
 * direct DB edits where invalidation was missed). For each row:
 *   - compute hash = sha256(name + '\n' + description)
 *   - call getEmbeddingService().generateEmbedding(name + '\n' + description)
 *   - update row: description_embedding, description_hash, updated_at = NOW()
 *
 * Batch size 20 with Promise.allSettled to avoid hammering the embedding
 * provider. External (filesystem) skills are NOT in the DB and therefore
 * naturally skipped.
 *
 * No-embedding-model path: catches the resolveModel() error from the
 * FIRST row and exits 0 with a loud error log + remediation message.
 * Subsequent transient row failures are logged at error level and the
 * batch continues.
 *
 * Idempotent — re-running after a successful run is a no-op (rows where
 * embedding non-null AND hash matches current content are skipped).
 *
 * Usage: bun run scripts/backfill-skill-embeddings.ts
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { initializeDb, getDb, closeDb } from '../src/db/postgres';
import { initializeStorage, closeStorage } from '../src/db/storage';
import { initializeVault } from '../src/security/vault';
import { skills } from '../src/db/schema/skills';
import { getEmbeddingService } from '../src/core/rag/embeddings';
import { coreLogger } from '../src/utils/logger';

const BATCH_SIZE = 20;

function computeHash(name: string, description: string): string {
  return createHash('sha256').update(`${name}\n${description}`).digest('hex');
}

interface CandidateRow {
  id: string;
  name: string;
  description: string;
  descriptionHash: string | null;
  descriptionEmbedding: number[] | null;
}

async function main() {
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  // Vault must be initialized before any provider call — system-scoped
  // credentials (e.g. voyage_api_key) are AES-decrypted with a per-scope DEK
  // derived from the master key, which is loaded by initializeVault().
  // Server bootstrap does this for us at runtime; standalone scripts must
  // do it explicitly. See scripts/rotate-vault-keys.ts for the same pattern.
  await initializeVault();

  const db = getDb();
  const embeddingService = getEmbeddingService();

  // Pull all DB skills, then filter in TS for the staleness check
  // (sha256 in pure SQL is awkward across PG/PGlite — keep portable).
  const allRows = await db.select({
    id: skills.id,
    name: skills.name,
    description: skills.description,
    descriptionHash: skills.descriptionHash,
    descriptionEmbedding: skills.descriptionEmbedding,
  }).from(skills);

  // External skills have ids prefixed `external:` and live in memory only —
  // they are never persisted to the DB, so allRows naturally excludes them.
  // Defensive filter just in case something seeded an external-prefixed row.
  const candidates: CandidateRow[] = [];
  for (const row of allRows) {
    if (row.id.startsWith('external:')) continue;
    const expectedHash = computeHash(row.name, row.description);
    const needsEmbed = row.descriptionEmbedding == null
      || row.descriptionHash !== expectedHash;
    if (needsEmbed) candidates.push(row);
  }

  const total = allRows.length;
  const skipped = total - candidates.length;

  coreLogger.info(
    { total, candidates: candidates.length, skipped, component: 'backfill-skills' },
    'Skill embedding backfill: starting',
  );

  if (candidates.length === 0) {
    coreLogger.info(
      { total, succeeded: 0, failed: 0, skipped, component: 'backfill-skills' },
      'Skill embedding backfill: nothing to do',
    );
    await closeDb();
    if (mode === 'embedded') await closeStorage();
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;
  let firstRow = true;
  let bailed = false;

  const numBatches = Math.ceil(candidates.length / BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
    const batch = candidates.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);

    // Process the very first row of the very first batch in isolation so we
    // can detect the no-model-configured case and exit cleanly without
    // attempting more rows that would all fail identically.
    let workItems = batch;
    if (firstRow) {
      const probe = batch[0];
      const text = `${probe.name}\n${probe.description}`;
      const hash = computeHash(probe.name, probe.description);
      try {
        const embedding = await embeddingService.generateEmbedding(text);
        await db.update(skills)
          .set({
            descriptionEmbedding: embedding,
            descriptionHash: hash,
            updatedAt: new Date(),
          })
          .where(eq(skills.id, probe.id));
        succeeded++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('No model mapped to topic "embedding"')) {
          coreLogger.error(
            { err, component: 'backfill-skills' },
            'Skill embedding backfill aborted: no embedding model configured. ' +
            'Configure an embedding model: assign one to topic="embedding" in the Models page.',
          );
          bailed = true;
          break;
        }
        // Some other transient error on first row — log and continue.
        coreLogger.error(
          { err, skillId: probe.id, name: probe.name, component: 'backfill-skills' },
          'Skill embedding backfill: failed to embed row (continuing)',
        );
        failed++;
      }
      firstRow = false;
      workItems = batch.slice(1);
    }

    if (workItems.length > 0) {
      const results = await Promise.allSettled(workItems.map(async (row) => {
        const text = `${row.name}\n${row.description}`;
        const hash = computeHash(row.name, row.description);
        const embedding = await embeddingService.generateEmbedding(text);
        await db.update(skills)
          .set({
            descriptionEmbedding: embedding,
            descriptionHash: hash,
            updatedAt: new Date(),
          })
          .where(eq(skills.id, row.id));
        return row.id;
      }));

      let batchSucceeded = 0;
      let batchFailed = 0;
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.status === 'fulfilled') {
          batchSucceeded++;
        } else {
          batchFailed++;
          coreLogger.error(
            {
              err: res.reason,
              skillId: workItems[i].id,
              name: workItems[i].name,
              component: 'backfill-skills',
            },
            'Skill embedding backfill: row failed (continuing)',
          );
        }
      }
      succeeded += batchSucceeded;
      failed += batchFailed;
    }

    coreLogger.info(
      {
        batch: batchIdx + 1,
        of: numBatches,
        succeeded,
        failed,
        skipped,
        component: 'backfill-skills',
      },
      `[batch ${batchIdx + 1}/${numBatches}] succeeded=${succeeded} failed=${failed} skipped=${skipped}`,
    );
  }

  coreLogger.info(
    { total, succeeded, failed, skipped, bailed, component: 'backfill-skills' },
    'Skill embedding backfill: complete',
  );

  await closeDb();
  if (mode === 'embedded') await closeStorage();
  process.exit(0);
}

main().catch((err) => {
  coreLogger.error({ err, component: 'backfill-skills' }, 'Skill embedding backfill: fatal error');
  process.exit(1);
});
