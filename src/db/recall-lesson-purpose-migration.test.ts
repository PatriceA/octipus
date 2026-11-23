/**
 * Migration 0202 against embedded PGlite: a recall hook config stored with
 * its own `purposes` before lessons were a purpose keeps recalling the
 * learning notes it recalled as notes, the built-in recall's stored change
 * included. The database is migrated to head, configs are inserted the way the
 * old code stored them, and 0202 is applied again (as an upgrade does), twice.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const userId = randomUUID();

// biome-ignore lint/suspicious/noExplicitAny: raw rows
async function rows(text: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(text, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-0202-'));
  process.env.LOG_LEVEL ??= 'error';
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'recall-0202' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

test('appends lesson to every stored recall list with note and without lesson, once', async () => {
  const hook = async (fields: { builtin?: string; kind: string; config: Record<string, unknown> }) => {
    const [row] = await rows(`INSERT INTO context_hooks (user_id, builtin, name, kind, events, config) VALUES ($1, $2, 'h', $3, ARRAY['turn_start'], $4::jsonb) RETURNING id`,
      [userId, fields.builtin ?? null, fields.kind, JSON.stringify(fields.config)]);
    return row.id as string;
  };
  const own = await hook({ kind: 'recall', config: { purposes: ['note', 'document'], minSimilarity: 0.5 } });
  const builtin = await hook({ builtin: 'knowledge-recall', kind: 'recall', config: { purposes: ['note'] } });
  const documentsOnly = await hook({ kind: 'recall', config: { purposes: ['document'] } });
  const already = await hook({ kind: 'recall', config: { purposes: ['lesson', 'note'] } });
  const defaults = await hook({ kind: 'recall', config: { minSimilarity: 0.4 } });
  const index = await hook({ builtin: 'notes-index', kind: 'notes_index', config: { limit: 10 } });

  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0202_recall_lesson_purpose.sql'), 'utf8');
  for (let run = 0; run < 2; run++) await rows(sql);

  const config = async (id: string) => (await rows('SELECT config FROM context_hooks WHERE id = $1', [id]))[0].config;
  expect(await config(own)).toEqual({ purposes: ['note', 'document', 'lesson'], minSimilarity: 0.5 });
  expect(await config(builtin)).toEqual({ purposes: ['note', 'lesson'] });
  expect(await config(documentsOnly)).toEqual({ purposes: ['document'] });
  expect(await config(already)).toEqual({ purposes: ['lesson', 'note'] });
  expect(await config(defaults)).toEqual({ minSimilarity: 0.4 });
  expect(await config(index)).toEqual({ limit: 10 });
});
