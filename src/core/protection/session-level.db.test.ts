/**
 * The stored session level (docs/PROTECTION-LEVELS.md, C6b).
 *
 * What must hold: a raised level is written through to the session row and
 * read back by a process that never saw it; the stored level is never
 * lowered; search hits and recalled passages carry their documents' levels,
 * and a document gone since it was indexed counts as unclear.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('@/core/modules/registry', () => ({ isModuleOn: () => true }));

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const alice = '11111111-1111-4111-8111-111111111111';

let executeRaw: (sql: string) => Promise<unknown>;
let queryRaw: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-session-level-db-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  executeRaw = db.executeRaw as typeof executeRaw;
  queryRaw = db.queryRaw as typeof queryRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${alice}', 'alice', false) ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function newSession(): Promise<string> {
  const id = randomUUID();
  await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ('${id}', '${alice}', 'web', 'web-${id}')`);
  return id;
}

async function stored(id: string): Promise<number | null> {
  const { rows } = await queryRaw(`SELECT protection_level FROM sessions WHERE id = '${id}'`);
  return (rows[0]?.protection_level as number | null | undefined) ?? null;
}

async function settle(): Promise<void> {
  // Writes go through in the background, in order per session.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
}

async function newDocument(level: number | null): Promise<string> {
  const id = randomUUID();
  await executeRaw(`INSERT INTO documents (id, user_id, filename, original_name, mime_type, size, storage_path, status, protection_level)
    VALUES ('${id}', '${alice}', 'f.pdf', 'f.pdf', 'application/pdf', 1, '/tmp/f.pdf', 'completed', ${level ?? 'NULL'})`);
  return id;
}

describe('the stored level', () => {
  test('is written through, read back by a fresh process, and never lowered', async () => {
    const { raiseSessionLevel, resetSessionLevels, loadSessionLevel, sessionProtectionLevel } = await import('./session-level');
    const id = await newSession();
    expect(await stored(id)).toBeNull();
    raiseSessionLevel(id, 3);
    await settle();
    expect(await stored(id)).toBe(3);

    // A process that never saw the raise: it raises to 2 first, then loads.
    resetSessionLevels();
    raiseSessionLevel(id, 2);
    await settle();
    expect(await stored(id)).toBe(3);
    await loadSessionLevel(id);
    expect(sessionProtectionLevel(id)).toBe(3);
  });

  test('the routing check loads it: a restarted process still keeps the session local', async () => {
    const { raiseSessionLevel, resetSessionLevels } = await import('./session-level');
    const { localOnlyLevel } = await import('./routing');
    const id = await newSession();
    raiseSessionLevel(id, 4);
    await settle();
    resetSessionLevels();
    expect(await localOnlyLevel(id)).toBe(4);
  });

  test('a level pushed out of the cache by other sessions is read back, never taken as "nothing read"', async () => {
    const { raiseSessionLevel } = await import('./session-level');
    const { localOnlyLevel } = await import('./routing');
    const id = await newSession();
    raiseSessionLevel(id, 4);
    await settle();
    expect(await localOnlyLevel(id)).toBe(4);
    for (let i = 0; i < 2_100; i++) raiseSessionLevel(`busy-${i}`, 2);
    expect(await localOnlyLevel(id)).toBe(4);
  });
});

describe('knowledge hits', () => {
  test('carry the levels of their documents; a vanished document counts as unclear; notes carry none', async () => {
    const { readKnowledge } = await import('./content-read');
    const { sessionProtectionLevel } = await import('./session-level');
    const internal = await newDocument(2);
    const confidential = await newDocument(3);

    const a = await newSession();
    await readKnowledge(a, [{ sourceId: `doc:${internal}` }, { sourceId: 'note:abc' }]);
    expect(sessionProtectionLevel(a)).toBe(2);
    await readKnowledge(a, [{ sourceId: `doc:${confidential}` }]);
    expect(sessionProtectionLevel(a)).toBe(3);

    const b = await newSession();
    await readKnowledge(b, [{ sourceId: `doc:${randomUUID()}` }]);
    expect(sessionProtectionLevel(b)).toBe(4);

    const c = await newSession();
    await readKnowledge(c, [{ sourceId: 'note:abc' }, { sourceId: '/docs/README.md' }]);
    expect(sessionProtectionLevel(c)).toBe(1);
  });
});
