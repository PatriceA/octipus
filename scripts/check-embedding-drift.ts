/**
 * Embedding drift check — surface heterogeneous `embedding_version`
 * values in the `embeddings` and `memories` tables.
 *
 * A drift means the deployment changed embedding model without
 * re-indexing: rows produced by the old model live alongside rows
 * from the new model in the same vector space, and cosine similarity
 * between them is meaningless. The fix is to delete the old rows and
 * re-index (or backfill the new model's embeddings).
 *
 * Usage:
 *   bun run scripts/check-embedding-drift.ts
 *
 * Exits 0 with a "no drift" message when both tables are
 * homogeneous, exits 1 with a breakdown otherwise so a CI gate can
 * notice.
 */
import { sql } from 'drizzle-orm';
import { initializeDb, getDb, closeDb } from '../src/db/postgres';
import { initializeStorage, closeStorage } from '../src/db/storage';
import { initializeVault } from '../src/security/vault';

interface VersionRow {
  embedding_version: string;
  count: number;
}

function rows<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object' && Array.isArray((r as { rows?: unknown }).rows)) {
    return (r as { rows: T[] }).rows;
  }
  return [];
}

async function checkTable(table: 'embeddings' | 'memories'): Promise<VersionRow[]> {
  const db = getDb();
  const res = await db.execute(sql`
    SELECT embedding_version, count(*)::int AS count
    FROM ${sql.raw(table)}
    GROUP BY embedding_version
    ORDER BY count DESC
  `);
  return rows<VersionRow>(res);
}

async function main(): Promise<number> {
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeVault();

  let drifted = false;

  for (const table of ['embeddings', 'memories'] as const) {
    const versions = await checkTable(table);
    if (versions.length === 0) {
      console.log(`[${table}] empty — nothing to check.`);
      continue;
    }
    if (versions.length === 1) {
      console.log(`[${table}] OK — single version: ${versions[0].embedding_version} (${versions[0].count} rows).`);
      continue;
    }
    drifted = true;
    console.log(`[${table}] DRIFT — ${versions.length} distinct embedding_version values:`);
    for (const v of versions) {
      console.log(`  - ${v.embedding_version}  ${v.count} rows`);
    }
    console.log(`[${table}] Remediation: pick the canonical version, delete the rest, and re-index the affected source rows. Different vector spaces don't cross-compare.`);
  }

  await closeDb();
  await closeStorage();
  return drifted ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Embedding drift check failed:', err);
    process.exit(2);
  });
