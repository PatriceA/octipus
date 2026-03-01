import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { logger } from '@/utils/logger';

/**
 * Run database migrations.
 * Skipped when SKIP_MIGRATIONS=true (useful for production rolling deploys).
 */
export async function runMigrations(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS === 'true') {
    logger.info('Skipping migrations (SKIP_MIGRATIONS=true)');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL || 'postgresql://assistant:assistant@localhost:5432/assistant';

  logger.info({ url: databaseUrl.replace(/:[^:@]*@/, ':***@') }, 'Running migrations');

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    // Enable extensions first
    // Extensions require superuser — skip gracefully if already installed or user lacks privileges
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

    // Run migrations
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    logger.info('Migrations completed successfully');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    throw error;
  } finally {
    await sql.end();
  }
}
