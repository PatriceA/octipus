import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getConfig } from '@/config';
import { dbLogger } from '@/utils/logger';
import * as schema from './schema';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sql: ReturnType<typeof postgres> | null = null;

/**
 * Get or create PostgreSQL connection
 */
export function getDb() {
  if (db) {
    return db;
  }

  const config = getConfig();

  sql = postgres(config.database.url, {
    max: config.database.poolSize,
    idle_timeout: config.database.idleTimeout / 1000,
    connect_timeout: config.database.connectionTimeout / 1000,
    onnotice: (notice) => {
      dbLogger.debug({ notice }, 'PostgreSQL notice');
    },
  });

  db = drizzle(sql, { schema });

  dbLogger.info('PostgreSQL connection established');

  return db;
}

/**
 * Close PostgreSQL connection
 */
export async function closeDb() {
  if (sql) {
    await sql.end();
    sql = null;
    db = null;
    dbLogger.info('PostgreSQL connection closed');
  }
}

/**
 * Execute raw SQL query
 */
export async function executeRaw(query: string, params?: unknown[]) {
  if (!sql) {
    getDb();
  }
  return sql!.unsafe(query, params as any);
}

/**
 * Check database connection health
 */
export async function checkDbHealth(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
  const start = Date.now();
  try {
    if (!sql) {
      getDb();
    }
    await sql!`SELECT 1`;
    return { healthy: true, latency: Date.now() - start };
  } catch (error) {
    return { healthy: false, error: (error as Error).message };
  }
}

/**
 * Initialize database extensions
 */
export async function initializeExtensions() {
  const database = getDb();

  // Enable pgvector extension (optional - for embeddings)
  try {
    await executeRaw('CREATE EXTENSION IF NOT EXISTS vector');
    dbLogger.info('pgvector extension enabled');
  } catch (error) {
    dbLogger.warn('pgvector extension not available - embeddings will be disabled');
  }

  // Enable uuid-ossp for UUID generation
  try {
    await executeRaw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    dbLogger.info('uuid-ossp extension enabled');
  } catch (error) {
    dbLogger.warn('uuid-ossp extension not available - using fallback UUID generation');
  }
}

export { schema };
export type Database = ReturnType<typeof getDb>;
