/**
 * One-shot reindex of the shipped product docs into the knowledge base.
 *
 * Why this exists: `indexProductDocs` is idempotent — it skips any file whose
 * SHA-256 is unchanged since the last index. That makes boot cheap, but it also
 * means a change to the CHUNKER (not the docs) is invisible to it: the files are
 * byte-for-byte identical, so a restart re-uses the stale chunks. This script
 * force-purges the existing `octipus-docs` rows so the next index re-chunks the
 * whole manual with the current chunker.
 *
 * Use it after a chunker/abstract change (e.g. the 2026-06-18 heading-fold) to
 * drop the old header-only chunks and rebuild clean.
 *
 * Only touches GLOBAL (`user_id IS NULL`) rows tagged `source='octipus-docs'` —
 * user-uploaded KB documents and per-user rows are never affected.
 *
 * Usage:
 *   npx tsx scripts/reindex-product-docs.ts          # purge + reindex
 *   npx tsx scripts/reindex-product-docs.ts --dry-run # report counts only
 */
import { sql } from 'drizzle-orm';
import { getConfig, loadConfig, loadRuntimeConfig } from '../src/config';
import { getSettingsService } from '../src/config/settings-service';
import { runKBSelfCheck } from '../src/core/rag/health';
import { closeDb, getDb, initializeDb } from '../src/db/postgres';
import { indexProductDocs } from '../src/db/seed-docs';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { resetLiteLLMClient } from '../src/models/litellm-client';
import { initializeVault } from '../src/security/vault';

const DRY_RUN = process.argv.includes('--dry-run');

function scalar(r: unknown): number {
  const row = Array.isArray(r)
    ? r[0]
    : r && typeof r === 'object' && Array.isArray((r as { rows?: unknown[] }).rows)
      ? (r as { rows: unknown[] }).rows[0]
      : undefined;
  const n = row && typeof row === 'object' ? Object.values(row as Record<string, unknown>)[0] : undefined;
  return typeof n === 'number' ? n : Number(n ?? 0);
}

// Matches what seed-docs writes: global document rows tagged octipus-docs.
const SCOPE = sql`purpose = 'document' AND metadata->>'source' = 'octipus-docs' AND user_id IS NULL`;

async function main(): Promise<number> {
  // Same init order as boot (gateway.start + src/index.ts) so the embedding
  // provider can resolve vault keys + the topic→model binding: storage → vault
  // → db → settings → runtime config → reset the LiteLLM client it built with
  // the pre-load (empty-key) config.
  loadConfig();
  const bootCfg = getConfig();
  const storageMode = bootCfg.storageMode || 'external';
  await initializeVault();
  await initializeDb();
  initializeStorage({ mode: storageMode });
  await getSettingsService().initialize();
  await loadRuntimeConfig();
  resetLiteLLMClient();

  const db = getDb();
  const before = scalar(await db.execute(sql`SELECT count(*)::int AS c FROM embeddings WHERE ${SCOPE}`));
  console.log(`Existing octipus-docs chunks (global): ${before}`);

  if (DRY_RUN) {
    console.log('--dry-run: no changes made.');
    await closeDb();
    await closeStorage();
    return 0;
  }

  // Live probe (the cached isKBReady flag is only set by the running server's
  // boot self-check, which a standalone script never triggers). This resolves
  // the embedding model from the registry AND round-trips a write to pgvector.
  const kb = await runKBSelfCheck();
  if (!kb.ready) {
    console.error(
      `Knowledge base not ready — ${kb.reason}. ` +
        'Bind an embedding model in the Models page / ensure the provider is reachable, ' +
        'then re-run. Aborting WITHOUT purging.',
    );
    await closeDb();
    await closeStorage();
    return 1;
  }

  const del = await db.execute(sql`DELETE FROM embeddings WHERE ${SCOPE}`);
  // rowCount surfaces differently per driver; fall back to the pre-count.
  const deleted = (del as { rowCount?: number })?.rowCount ?? before;
  console.log(`Purged ${deleted} stale chunk(s). Re-indexing with the current chunker…`);

  const result = await indexProductDocs();
  console.log(
    `Reindex complete — filesIndexed=${result.filesIndexed} filesSkipped=${result.filesSkipped} ` +
      `chunksStored=${result.chunksStored}${result.reason ? ` reason=${result.reason}` : ''}`,
  );

  const after = scalar(await db.execute(sql`SELECT count(*)::int AS c FROM embeddings WHERE ${SCOPE}`));
  console.log(`octipus-docs chunks now: ${after} (was ${before}, delta ${after - before}).`);

  await closeDb();
  await closeStorage();
  return result.chunksStored > 0 || result.reason === 'no-files' ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Reindex failed:', err);
    process.exit(2);
  });
