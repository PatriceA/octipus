/**
 * HNSW for the dimensionless embedding columns, once their rows allow one.
 *
 * Migration 0047 made `embeddings.embedding` and `memories.embedding`
 * dimensionless so any embedding model works, and pgvector cannot build HNSW
 * on a column without a dimension. Migration 0055 pinned the dimension and
 * built the index — but only for a table that had rows when it ran, and a
 * migration runs once: an install whose tables were empty then (every new
 * install) searched by sequential scan for good. This makes the same decision
 * at boot and daily from the cron runner, per column:
 *
 *   - a valid HNSW index already      → nothing to do
 *   - no rows                         → wait for data
 *   - one dimension across the rows   → pin `vector(N)`, build the index
 *   - several dimensions              → drift: warn and leave it
 *                                       (`scripts/check-embedding-drift.ts`)
 *
 * A pinned column refuses a row of another dimension at insert, loudly; a
 * mixed column already failed at query time instead ("different vector
 * dimensions"). Switching embedding model means clearing the rows and
 * unpinning, exactly as after 0055 (docs/RAG.md → Vector indexing).
 *
 * The build is CONCURRENTLY (PGlite accepts it as well), so writes go on
 * while it runs; the pin is a one-time table rewrite under an exclusive lock.
 * One instance runs it at a time, through a storage claim.
 *
 * `skills.description_embedding` is left alone: a few hundred rows, always
 * filtered by visibility, where a sequential scan is exact and cheap.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { rawStore } from '@/db/cache';
import { executeRaw, getDb, queryRaw } from '@/db/postgres';
import { dbLogger } from '@/utils/logger';

/** Fixed identifiers, interpolated into DDL — never user input. */
const TARGETS = [
  { table: 'embeddings', column: 'embedding', index: 'embeddings_vector_idx' },
  { table: 'memories', column: 'embedding', index: 'memories_embedding_idx' },
] as const;

export type VectorIndexOutcome = 'exists' | 'created' | 'empty' | 'drift';

const CLAIM_KEY = 'db:vector-index-ensure';
/** Long enough for a large build; a crashed holder's claim lapses after it. */
const CLAIM_TTL_SECS = 3600;

/**
 * Returns what happened per table, or null when there was nothing to do here:
 * no pgvector, or another instance holds the claim.
 */
export async function ensureVectorIndexes(): Promise<Record<string, VectorIndexOutcome> | null> {
  const { rows: ext } = await queryRaw(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
  if (ext.length === 0) {
    dbLogger.debug('pgvector not installed — no vector indexes to ensure');
    return null;
  }
  const claimant = randomUUID();
  if (!(await rawStore().setIfAbsent(CLAIM_KEY, claimant, CLAIM_TTL_SECS))) {
    dbLogger.debug('Vector index ensure already running on another instance');
    return null;
  }
  try {
    const outcomes: Record<string, VectorIndexOutcome> = {};
    for (const target of TARGETS) outcomes[target.table] = await ensureOne(target);
    return outcomes;
  } finally {
    // Release only our own claim: one that lapsed may have been taken since.
    if ((await rawStore().get(CLAIM_KEY)) === claimant) await rawStore().del(CLAIM_KEY);
  }
}

async function ensureOne(t: (typeof TARGETS)[number]): Promise<VectorIndexOutcome> {
  const { rows: indexes } = await queryRaw(
    `SELECT c.relname AS name, i.indisvalid AS valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_am am ON am.oid = c.relam
      WHERE i.indrelid = $1::regclass AND am.amname = 'hnsw'`,
    [t.table],
  );
  if (indexes.some((r: { valid: boolean }) => r.valid)) return 'exists';
  // An interrupted CONCURRENTLY build leaves an INVALID index behind, which
  // IF NOT EXISTS would then mistake for the real one.
  for (const r of indexes as { name: string }[]) {
    dbLogger.warn({ table: t.table, index: r.name }, 'Dropping an invalid HNSW index left by an interrupted build');
    await executeRaw(`DROP INDEX IF EXISTS "${r.name.replace(/"/g, '""')}"`);
  }

  const { rows: cols } = await queryRaw(
    'SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2',
    [t.table, t.column],
  );
  // atttypmod is the pinned dimension, or -1 for a dimensionless column.
  const pinned = Number(cols[0]?.dim ?? -1);
  if (pinned <= 0) {
    const { rows } = await queryRaw(
      `SELECT count(*)::int AS n,
              count(DISTINCT vector_dims(${t.column}))::int AS dims,
              min(vector_dims(${t.column}))::int AS dim
         FROM ${t.table} WHERE ${t.column} IS NOT NULL`,
    );
    const stats = rows[0] as { n: number; dims: number; dim: number | null };
    if (Number(stats.n) === 0) return 'empty';
    if (Number(stats.dims) > 1) {
      dbLogger.warn(
        { table: t.table, distinctDimensions: Number(stats.dims), rows: Number(stats.n) },
        'Embedding dimension drift — HNSW skipped. Run `npx tsx scripts/check-embedding-drift.ts` for the breakdown',
      );
      return 'drift';
    }
    const dim = Number(stats.dim);
    dbLogger.info({ table: t.table, dim, rows: Number(stats.n) }, 'Pinning the embedding column dimension (one-time table rewrite)');
    await pinDimension(t, dim);
  }

  dbLogger.info({ table: t.table, index: t.index }, 'Building the HNSW index for vector search');
  await executeRaw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${t.index} ON ${t.table} USING hnsw (${t.column} vector_cosine_ops)`);
  return 'created';
}

/**
 * `ALTER COLUMN … TYPE` refuses a column a view reads (`memories_active`,
 * migration 0053), so the views over the column are dropped and recreated
 * from their own definitions around it, in one transaction.
 */
async function pinDimension(t: (typeof TARGETS)[number], dim: number): Promise<void> {
  const { rows: views } = await queryRaw(
    `SELECT DISTINCT v.oid::regclass::text AS name, pg_get_viewdef(v.oid) AS def
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class v ON v.oid = r.ev_class
      WHERE d.classid = 'pg_rewrite'::regclass
        AND d.refobjid = $1::regclass
        AND d.refobjsubid = (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)
        AND v.relkind = 'v'`,
    [t.table, t.column],
  );
  await getDb().transaction(async (tx) => {
    for (const v of views as { name: string }[]) await tx.execute(sql.raw(`DROP VIEW ${v.name}`));
    await tx.execute(sql.raw(`ALTER TABLE ${t.table} ALTER COLUMN ${t.column} TYPE vector(${dim}) USING ${t.column}::vector(${dim})`));
    for (const v of views as { name: string; def: string }[]) await tx.execute(sql.raw(`CREATE VIEW ${v.name} AS ${v.def}`));
  });
}
