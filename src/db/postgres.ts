import { getConfig } from '@/config';
import { dbLogger } from '@/utils/logger';
import * as schema from './schema';

type DrizzleDB = ReturnType<typeof import('drizzle-orm/postgres-js').drizzle<typeof schema>>;

let db: DrizzleDB | null = null;
let closeHandle: (() => Promise<void>) | null = null;
let rawExec: ((query: string, params?: unknown[]) => Promise<unknown>) | null = null;
let rawQuery: ((query: string, params?: unknown[]) => Promise<{ rows: any[] }>) | null = null;
let healthCheck: (() => Promise<void>) | null = null;
/**
 * Fingerprint of the (storage_mode, target) the cached `db` is bound
 * to. Used by `initializeDb()` to detect when a caller wants a
 * different DB than the one already cached — happens in tests where
 * one file binds embedded PGlite at `dataDir=A` and a subsequent file
 * binds embedded at `dataDir=B`. Without this check the second file
 * silently shares the first file's PGlite (and its truncate/seed
 * decisions), which leads to FK violations like
 * "user_id is not present in users" because seed went to one store
 * and the FK check runs against another.
 */
let cachedDbKey: string | null = null;

function buildDbKey(): string {
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') {
    const config = getConfig();
    const dataDir = process.env.DATA_DIR || config.database?.dataDir || '~/.octipus/data';
    return `embedded:${dataDir}`;
  }
  // External: keyed by URL so a test pointing at a different
  // Postgres instance also gets a fresh connection.
  const config = getConfig();
  return `external:${config.database?.url ?? ''}`;
}

/**
 * Initialize PostgreSQL connection (external mode via postgres-js)
 */
async function initExternal(config: { url: string; poolSize: number; idleTimeout: number; connectionTimeout: number }): Promise<DrizzleDB> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');

  const sql = postgres(config.url, {
    max: config.poolSize,
    idle_timeout: config.idleTimeout / 1000,
    // Recycle every pooled socket after 30 minutes — avoids zombie slots
    // when Bun + postgres-js drops a connection silently.
    max_lifetime: 30 * 60,
    connect_timeout: config.connectionTimeout / 1000,
    // Disable prepared statements. With Bun + postgres-js, a connection
    // that fails its initial startup handshake (DB log: "incomplete startup
    // packet") can stick around in the pool with cached prepares and keep
    // returning CONNECTION_ENDED for every subsequent query that maps to
    // the same slot. Disabling prepares forces a fresh exec each time and
    // lets the pool drop bad slots immediately on first failure.
    prepare: false,
    onnotice: (notice) => dbLogger.debug({ notice }, 'PostgreSQL notice'),
  });

  closeHandle = async () => { await sql.end(); };
  rawExec = async (query, params) => sql.unsafe(query, params as any);
  rawQuery = async (query, params) => { const r = await sql.unsafe(query, params as any); return { rows: r }; };
  healthCheck = async () => { await sql`SELECT 1`; };

  dbLogger.info('PostgreSQL connection established (external)');
  return drizzle(sql, { schema });
}

/**
 * Initialize PGlite connection (embedded mode)
 */
async function initEmbedded(dataDir: string): Promise<DrizzleDB> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');
  const { drizzle } = await import('drizzle-orm/pglite');

  // Expand ~ to home directory (HOME may be unset on Windows)
  const resolvedDir = dataDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '/tmp');

  // Ensure data directory exists
  const { mkdirSync } = await import('fs');
  mkdirSync(resolvedDir, { recursive: true });

  const client = await PGlite.create({
    dataDir: resolvedDir,
    extensions: { vector },
  });

  closeHandle = async () => { await client.close(); };
  rawExec = async (query) => { await client.exec(query); return []; };
  rawQuery = async (query, params) => client.query(query, params as any);
  healthCheck = async () => { await client.query('SELECT 1'); };

  dbLogger.info({ dataDir: resolvedDir }, 'PGlite connection established (embedded)');
  return (drizzle as any)(client, { schema }) as DrizzleDB;
}

/**
 * Get database connection. Must call initializeDb() first during startup.
 * For backward compat in external mode, synchronously initializes if not yet done.
 */
export function getDb(): DrizzleDB {
  if (db) return db;

  // Backward compat: synchronous init for external mode only
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'external') {
    const config = getConfig();
    const postgresMod = require('postgres');
    const postgres = postgresMod.default || postgresMod;
    const drizzleMod = require('drizzle-orm/postgres-js');
    const drizzle = drizzleMod.drizzle || drizzleMod.default?.drizzle;

    const sql = postgres(config.database.url, {
      max: config.database.poolSize,
      idle_timeout: config.database.idleTimeout / 1000,
      // Parity with initExternal(): recycle sockets after 30 min and disable
      // prepared statements so a bad slot can't keep returning CONNECTION_ENDED.
      max_lifetime: 30 * 60,
      prepare: false,
      connect_timeout: config.database.connectionTimeout / 1000,
      onnotice: (notice: any) => dbLogger.debug({ notice }, 'PostgreSQL notice'),
    });

    closeHandle = async () => { await sql.end(); };
    rawExec = async (query, params) => sql.unsafe(query, params as any);
    rawQuery = async (query, params) => { const r = await sql.unsafe(query, params as any); return { rows: r }; };
    healthCheck = async () => { await sql`SELECT 1`; };

    db = drizzle(sql, { schema });
    dbLogger.info('PostgreSQL connection established (external, sync fallback)');
    return db!;
  }

  throw new Error('Database not initialized — call initializeDb() first');
}

/**
 * Initialize database based on storage mode. Called during gateway startup.
 */
export async function initializeDb(): Promise<DrizzleDB> {
  const wantedKey = buildDbKey();
  if (db && cachedDbKey === wantedKey) return db;

  // Caller wants a different DB than the one we have cached. Close
  // the old one before reopening — otherwise the embedded PGlite
  // file handle leaks and we keep stacking connections in the
  // process. See `cachedDbKey` doc for the test-ordering scenario.
  if (db) {
    await closeDb();
  }

  const config = getConfig();
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';

  if (mode === 'embedded') {
    const dataDir = process.env.DATA_DIR || config.database?.dataDir || '~/.octipus/data';
    db = await initEmbedded(dataDir);
  } else {
    db = await initExternal(config.database);
  }

  cachedDbKey = wantedKey;
  return db;
}

/**
 * Close database connection
 */
export async function closeDb() {
  if (closeHandle) {
    await closeHandle();
    closeHandle = null;
    rawExec = null;
    rawQuery = null;
    healthCheck = null;
    db = null;
    cachedDbKey = null;
    dbLogger.info('Database connection closed');
  }
}

/**
 * Execute raw SQL (no result returned, supports multi-statement for PGlite)
 */
export async function executeRaw(query: string, params?: unknown[]) {
  if (!rawExec) throw new Error('Database not initialized');
  return rawExec(query, params);
}

/**
 * Execute raw SQL query with result rows
 */
export async function queryRaw(query: string, params?: unknown[]): Promise<{ rows: any[] }> {
  if (!rawQuery) throw new Error('Database not initialized');
  return rawQuery(query, params);
}

/**
 * Check database connection health
 */
export async function checkDbHealth(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
  const start = Date.now();
  try {
    if (!healthCheck) throw new Error('Database not initialized');
    await healthCheck();
    return { healthy: true, latency: Date.now() - start };
  } catch (error) {
    return { healthy: false, error: (error as Error).message };
  }
}

/**
 * Initialize database extensions
 */
export async function initializeExtensions() {
  if (!rawExec) throw new Error('Database not initialized');

  try {
    await rawExec('CREATE EXTENSION IF NOT EXISTS vector');
    dbLogger.info('pgvector extension enabled');
  } catch (_error) {
    dbLogger.warn('pgvector extension not available - embeddings will be disabled');
  }

  try {
    await rawExec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    dbLogger.info('uuid-ossp extension enabled');
  } catch (_error) {
    dbLogger.warn('uuid-ossp extension not available - using fallback UUID generation');
  }
}

export { schema };
export type Database = DrizzleDB;
