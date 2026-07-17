import { executeRaw, queryRaw } from '@/db/postgres';
import { logger } from '@/utils/logger';

/**
 * Run database migrations.
 * Skipped when SKIP_MIGRATIONS=true (useful for production rolling deploys).
 * Must be called AFTER initializeDb() so the connection is available.
 */
export async function runMigrations(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS === 'true') {
    logger.info('Skipping migrations (SKIP_MIGRATIONS=true)');
    return;
  }

  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';

  if (mode === 'embedded') {
    await runEmbeddedMigrations();
  } else {
    await runExternalMigrations();
  }
}

async function runExternalMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  logger.info({ url: databaseUrl.replace(/:[^:@]*@/, ':***@') }, 'Running migrations (external)');

  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      logger.info('pgvector extension enabled');
    } catch {
      logger.warn('pgvector extension not available — embeddings/vector search will be disabled');
    }

    try {
      await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
      logger.info('uuid-ossp extension enabled');
    } catch {
      logger.warn('uuid-ossp extension not available — ensure it is installed by a superuser');
    }

    await migrate(db, { migrationsFolder: './src/db/migrations' });
    logger.info('Migrations completed successfully');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    throw error;
  } finally {
    await sql.end();
  }
}

async function runEmbeddedMigrations(): Promise<void> {
  logger.info('Running migrations (embedded/PGlite)');

  const { readFileSync } = await import('fs');
  const { createHash } = await import('crypto');

  try {
    // Custom migrator: PGlite's query() can't handle multi-statement SQL,
    // but exec() can. We use executeRaw() (which maps to client.exec() in
    // embedded mode) and queryRaw() for result queries.
    const migrationsFolder = './src/db/migrations';
    const journalPath = `${migrationsFolder}/meta/_journal.json`;
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));

    // Create migration tracking table (same schema as drizzle)
    await executeRaw('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await executeRaw(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    // Get last applied migration
    const { rows } = await queryRaw(
      'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1'
    );
    const lastMigrationTs = rows.length > 0 ? Number(rows[0].created_at) : 0;

    for (const entry of journal.entries) {
      if (entry.when <= lastMigrationTs) continue;

      const sqlPath = `${migrationsFolder}/${entry.tag}.sql`;
      const sqlContent = readFileSync(sqlPath, 'utf8');
      const hash = createHash('sha256').update(sqlContent).digest('hex');

      // PGlite doesn't have uuid-ossp; use built-in gen_random_uuid() instead
      const patchedSql = sqlContent
        .replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";?/gi, '-- uuid-ossp not needed (using gen_random_uuid)')
        .replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');

      // Use parameterized-safe values: hash is a hex SHA-256 (safe chars only),
      // entry.when is a number from the journal. Validate both defensively.
      const safeHash = hash.replace(/[^a-f0-9]/g, '');
      const safeWhen = Number(entry.when);
      if (!safeHash || isNaN(safeWhen)) {
        throw new Error(`Invalid migration metadata: hash=${hash}, when=${entry.when}`);
      }

      logger.info({ tag: entry.tag }, 'Applying migration');
      // Apply the migration and record it atomically. Without the transaction a
      // failure partway through a multi-statement file left earlier statements
      // committed and the tracking row unwritten — so a re-run replayed the
      // whole file and hit duplicate-object errors. None of the migrations use
      // CREATE INDEX CONCURRENTLY, so wrapping in a transaction is safe.
      //
      // Bounded retry: under the full test suite (many throwaway PGlite
      // instances created back-to-back in one process), a heavy migration that
      // rewrites tables — the `timestamp`→`timestamptz` conversion in
      // particular — intermittently faults inside PGlite's WASM VFS with
      // `could not open file "base/…"` (SQLSTATE 58P01) / an `ErrnoError`
      // (errno 44 = ENOENT) when the storage manager opens the freshly written
      // relfilenode. It is transient: the transaction is rolled back cleanly, so
      // replaying the same entry on the next attempt succeeds. This also hardens
      // a real first-boot embedded install against the same hiccup. Only the
      // known-transient VFS class is retried; every other error still fails loud.
      await applyEmbeddedMigrationWithRetry(entry.tag, patchedSql, safeHash, safeWhen);
    }

    logger.info('Migrations completed successfully (PGlite)');
  } catch (error) {
    logger.error({ error, message: (error as Error).message, stack: (error as Error).stack }, 'Migration failed (PGlite)');
    throw error;
  }
}

/**
 * Apply one embedded migration entry inside a transaction, retrying only the
 * transient PGlite WASM-VFS fault described at the call site. Each attempt is
 * fully isolated: a failure rolls the transaction back before the next try, so
 * a replay starts from the same clean pre-migration state (no half-applied
 * DDL, no duplicate-object errors). Non-transient errors throw immediately.
 */
async function applyEmbeddedMigrationWithRetry(
  tag: string,
  patchedSql: string,
  safeHash: string,
  safeWhen: number,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await executeRaw('BEGIN');
    try {
      await executeRaw(patchedSql);
      await executeRaw(
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('${safeHash}', ${safeWhen})`
      );
      await executeRaw('COMMIT');
      return;
    } catch (err) {
      await executeRaw('ROLLBACK').catch(() => { /* connection may be aborted */ });
      if (attempt >= MAX_ATTEMPTS || !isTransientPgliteFault(err)) throw err;
      logger.warn(
        { tag, attempt, error: (err as Error).message },
        'Transient PGlite fault applying migration — retrying',
      );
      // Yield a tick so PGlite's WASM VFS can settle before the replay.
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/**
 * True for the narrow, known-transient PGlite storage fault that a fresh
 * replay recovers from — an `ErrnoError` (errno 44 = ENOENT) or a Postgres
 * `could not open file` / SQLSTATE 58P01 raised while the WASM VFS opens a
 * relfilenode. Everything else (real SQL errors, constraint violations) is
 * NOT transient and must surface.
 */
function isTransientPgliteFault(err: unknown): boolean {
  const e = err as { errno?: number; code?: string; message?: string; name?: string };
  if (e?.errno === 44 || e?.name === 'ErrnoError') return true;
  if (e?.code === '58P01') return true;
  const msg = String(e?.message ?? '');
  return /could not open file|No such file or directory/i.test(msg);
}
