/**
 * Skill embedding backfill — Phase 2 of skill discovery. The work is
 * `ensureSkillEmbeddings` (src/skills/embedding-backfill.ts), which dedup and
 * the daily consolidation call too; this runs it once over every row.
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
 * No-embedding-model path: the capability is off, or the FIRST row's
 * resolveModel() error says so; exits 0 with a loud error log + remediation
 * message.
 * Subsequent transient row failures are logged at error level and the
 * batch continues.
 *
 * Idempotent — re-running after a successful run is a no-op (rows where
 * embedding non-null AND hash matches current content are skipped).
 *
 * Usage: npx tsx scripts/backfill-skill-embeddings.ts
 */
import { initializeDb, closeDb } from '../src/db/postgres';
import { initializeStorage, closeStorage } from '../src/db/storage';
import { initializeVault } from '../src/security/vault';
import { ensureSkillEmbeddings } from '../src/skills/embedding-backfill';
import { coreLogger } from '../src/utils/logger';

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

  coreLogger.info({ component: 'backfill-skills' }, 'Skill embedding backfill: starting');
  const result = await ensureSkillEmbeddings({
    onBatch: ({ batch, of, embedded, failed }) => coreLogger.info(
      { batch, of, succeeded: embedded, failed, component: 'backfill-skills' },
      `[batch ${batch}/${of}] succeeded=${embedded} failed=${failed}`,
    ),
  });

  if (result.noModel) {
    coreLogger.error(
      { component: 'backfill-skills' },
      'Skill embedding backfill aborted: no embedding model configured. ' +
      'Configure an embedding model: assign one to topic="embedding" in the Models page.',
    );
  } else if (result.stale === 0) {
    coreLogger.info({ succeeded: 0, failed: 0, component: 'backfill-skills' }, 'Skill embedding backfill: nothing to do');
  } else {
    coreLogger.info(
      { candidates: result.stale, succeeded: result.embedded, failed: result.failed, component: 'backfill-skills' },
      'Skill embedding backfill: complete',
    );
  }

  await closeDb();
  if (mode === 'embedded') await closeStorage();
  process.exit(0);
}

main().catch((err) => {
  coreLogger.error({ err, component: 'backfill-skills' }, 'Skill embedding backfill: fatal error');
  process.exit(1);
});
