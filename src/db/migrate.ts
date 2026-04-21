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

      logger.info({ tag: entry.tag }, 'Applying migration');
      await executeRaw(patchedSql);
      // Use parameterized-safe values: hash is a hex SHA-256 (safe chars only),
      // entry.when is a number from the journal. Validate both defensively.
      const safeHash = hash.replace(/[^a-f0-9]/g, '');
      const safeWhen = Number(entry.when);
      if (!safeHash || isNaN(safeWhen)) {
        throw new Error(`Invalid migration metadata: hash=${hash}, when=${entry.when}`);
      }
      await executeRaw(
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('${safeHash}', ${safeWhen})`
      );
    }

    logger.info('Migrations completed successfully (PGlite)');
  } catch (error) {
    logger.error({ error, message: (error as Error).message, stack: (error as Error).stack }, 'Migration failed (PGlite)');
    throw error;
  }
}
