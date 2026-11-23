/**
 * The notes index over embedded PGlite: which notes it lists and counts.
 * Lesson notes (written by a learning review, `note_kind = 'lesson'`) reach
 * an agent by recall as their own kind; the index lists and counts only the
 * user's own notes.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ContextHookRunRecord } from '@/db/schema/context-hooks';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '99999999-9999-4999-8999-999999999999';
let queryRaw: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
let executeRaw: (sql: string) => Promise<unknown>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-notes-index-'));
  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  executeRaw = pg.executeRaw as typeof executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'indexer', false) ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  await executeRaw('DELETE FROM context_hooks; DELETE FROM context_turns; DELETE FROM notes;');
  const { resetNotesIndexCache } = await import('@/core/context-hooks/kinds');
  resetNotesIndexCache();
  // Only the notes index here: recall has its own suite.
  const { updateContextHook } = await import('@/core/context-hooks');
  await updateContextHook(userId, 'builtin:knowledge-recall', { enabled: false });
});

async function note(title: string, opts: { kind?: string; pinned?: boolean; tags?: string[] } = {}): Promise<void> {
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${rand(3)}`;
  await queryRaw(
    `INSERT INTO notes (user_id, slug, title, body, body_sha256, note_kind, pinned, tags) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, slug, title, `Body of ${title}.`, rand(32), opts.kind ?? 'note', opts.pinned ?? false, opts.tags ?? []],
  );
}

async function index(): Promise<{ text: string; record: ContextHookRunRecord }> {
  const { runContextHooks } = await import('@/core/context-hooks');
  const { text } = await runContextHooks({ event: 'turn_start', userId, workspaceId: null, sessionId: 'sess-index', query: 'What do we charge for a website?', role: 'general', channel: 'web' });
  const { rows } = await queryRaw('SELECT hooks FROM context_turns ORDER BY created_at DESC LIMIT 1');
  const hooks = rows[0].hooks as ContextHookRunRecord[];
  return { text, record: hooks.find((h) => h.kind === 'notes_index') as ContextHookRunRecord };
}

describe('the notes index and lesson notes', () => {
  test('lists and counts only the user\'s own notes, not lessons', async () => {
    await note('Pricing');
    await note('About me', { pinned: true });
    await note('Quote websites per page', { kind: 'lesson', tags: ['session-learning'] });
    await note('Deploy only on weekdays', { kind: 'lesson', tags: ['session-learning'], pinned: true });
    const { text, record } = await index();
    expect(text).toContain('The user keeps 2 notes in Octipus.');
    expect(text).toContain('Pinned: About me');
    expect(text).toContain('Recently changed: Pricing');
    expect(text).not.toContain('Quote websites per page');
    expect(text).not.toContain('Deploy only on weekdays');
    expect(record.status).toBe('injected');
  });

  test('a user with only lesson notes gets what a user with no notes gets', async () => {
    const none = await index();
    expect(none.text).toBe('');
    expect(none.record).toMatchObject({ status: 'abstained', reason: 'no_notes' });
    await note('Quote websites per page', { kind: 'lesson', tags: ['session-learning'] });
    const lessonsOnly = await index();
    expect(lessonsOnly.text).toBe('');
    expect(lessonsOnly.record).toMatchObject({ status: 'abstained', reason: 'no_notes' });
  });

  test('one note of the user\'s own is counted in the singular, whatever lessons there are', async () => {
    await note('Pricing');
    for (let i = 0; i < 3; i++) await note(`Lesson ${i}`, { kind: 'lesson', tags: ['session-learning'] });
    const { text } = await index();
    expect(text).toContain('The user keeps 1 note in Octipus.');
  });
});
