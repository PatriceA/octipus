/**
 * Migration 0127 (workspace integrity, docs/plans/coworking-spec.md §4.3):
 * rows whose workspace_id names a missing workspace or another user's
 * workspace fall back to user-level without breaking note slug uniqueness,
 * and the five tables get `REFERENCES workspaces(id) ON DELETE SET NULL`.
 * `workspaces.files_dir` is backfilled: `default` for each user's default
 * workspace (where its files already are), the id for every other.
 *
 * The database is migrated to head, the foreign keys 0127 adds are dropped
 * so the fixture can hold the rows older code wrote, then 0127 is replayed —
 * it is idempotent, so this is exactly what an upgrade does.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const alice = randomUUID();
const bob = randomUUID();
const aliceWs = randomUUID();
const bobWs = randomUUID();
const aliceSideWs = randomUUID();
const goneWs = randomUUID(); // a workspace id that no longer exists
const TABLES = ['notes', 'tasks', 'knowledge_links', 'workspace_repos', 'background_jobs'];

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

async function note(slug: string, workspaceId: string | null, createdAt: string, userId = alice): Promise<string> {
  const [row] = await q(
    `INSERT INTO notes (user_id, workspace_id, slug, title, body_sha256, created_at) VALUES ($1, $2, $3, $3, 'sha', $4) RETURNING id`,
    [userId, workspaceId, slug, createdAt],
  );
  return row.id;
}

async function replay0127(): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0127_workspace_integrity.sql'), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) await executeRaw(statement);
  }
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-ws-0127-'));
  process.env.LOG_LEVEL ??= 'error';
  process.env.WORKSPACE_PATH = mkdtempSync(join(tmpdir(), 'octipus-ws-0127-files-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'alice' }, { id: bob, username: 'bob' }]);
  // Workspace rows as older code wrote them: no files_dir.
  await executeRaw(`DROP INDEX IF EXISTS workspaces_user_id_files_dir_uq`);
  await executeRaw(`ALTER TABLE workspaces ALTER COLUMN files_dir DROP NOT NULL`);
  await q(
    `INSERT INTO workspaces (id, user_id, slug, name, is_default) VALUES ($1, $2, 'default', 'Default', true), ($3, $4, 'default', 'Default', true), ($5, $2, 'side-old', 'Side', false)`,
    [aliceWs, alice, bobWs, bob, aliceSideWs],
  );
  for (const t of TABLES) await executeRaw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${t}_workspace_id_fkey`);

  // `plan`: a user-level note, plus an OLDER note stamped with a gone
  // workspace and a younger one stamped with bob's workspace. The user-level
  // note keeps the slug; both foreign-stamped ones are renamed.
  ids.planUser = await note('plan', null, '2026-02-01T00:00:00Z');
  ids.planGone = await note('plan', goneWs, '2026-01-01T00:00:00Z');
  ids.planBob = await note('plan', bobWs, '2026-03-01T00:00:00Z');
  // `plan` in alice's own workspace is not touched.
  ids.planOwn = await note('plan', aliceWs, '2025-01-01T00:00:00Z');
  // `idea`: no user-level note; two foreign-stamped notes collide with each
  // other once reset. The oldest keeps the slug.
  ids.ideaOld = await note('idea', goneWs, '2026-01-01T00:00:00Z');
  ids.ideaNew = await note('idea', bobWs, '2026-02-01T00:00:00Z');
  // A foreign-stamped note with no collision keeps its slug.
  ids.solo = await note('solo', goneWs, '2026-01-01T00:00:00Z');
  // Bob's own note in his workspace stays.
  ids.bobOwn = await note('plan', bobWs, '2026-01-01T00:00:00Z', bob);

  const one = async (key: string, sql: string, params: unknown[]) => {
    const [row] = await q(sql, params);
    ids[key] = String(row.id);
  };
  await one('taskForeign', `INSERT INTO tasks (user_id, title, workspace_id) VALUES ($1, 't', $2) RETURNING id`, [alice, bobWs]);
  await one('taskOwn', `INSERT INTO tasks (user_id, title, workspace_id) VALUES ($1, 't', $2) RETURNING id`, [alice, aliceWs]);
  await one('linkForeign', `INSERT INTO knowledge_links (user_id, from_type, from_id, to_ref, link_type, origin, workspace_id) VALUES ($1, 'note', $2, 'x', 'references', 'wikilink', $3) RETURNING id`, [alice, randomUUID(), goneWs]);
  await one('repoForeign', `INSERT INTO workspace_repos (user_id, name, root_path, workspace_id) VALUES ($1, 'r', '/r1', $2) RETURNING id`, [alice, bobWs]);
  await one('jobForeign', `INSERT INTO background_jobs (kind, user_id, title, workspace_id) VALUES ('research', $1, 'j', $2) RETURNING id`, [alice, goneWs]);

  await replay0127();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function noteRow(id: string): Promise<Row> {
  const [row] = await q(`SELECT slug, workspace_id FROM notes WHERE id = $1`, [id]);
  return row;
}

describe('0127 workspace integrity', () => {
  test("files_dir: 'default' for the default workspace, the id for the others, then NOT NULL", async () => {
    const rows = await q(`SELECT id, files_dir FROM workspaces WHERE id = ANY($1::uuid[]) ORDER BY id`, [[aliceWs, bobWs, aliceSideWs]]);
    expect(Object.fromEntries(rows.map((r: Row) => [r.id, r.files_dir]))).toEqual({
      [aliceWs]: 'default', [bobWs]: 'default', [aliceSideWs]: aliceSideWs,
    });
    await expect(q(`INSERT INTO workspaces (user_id, slug, name) VALUES ($1, 'nodir', 'x')`, [alice])).rejects.toThrow();
    await expect(q(`UPDATE workspaces SET files_dir = 'default' WHERE id = $1`, [aliceSideWs])).rejects.toThrow();
  });

  test('foreign-stamped notes become user-level; the user-level note keeps its slug', async () => {
    expect(await noteRow(ids.planUser)).toEqual({ slug: 'plan', workspace_id: null });
    expect(await noteRow(ids.planGone)).toEqual({ slug: `plan-${ids.planGone.slice(0, 8)}`, workspace_id: null });
    expect(await noteRow(ids.planBob)).toEqual({ slug: `plan-${ids.planBob.slice(0, 8)}`, workspace_id: null });
  });

  test('colliding foreign-stamped notes: the oldest keeps the slug', async () => {
    expect(await noteRow(ids.ideaOld)).toEqual({ slug: 'idea', workspace_id: null });
    expect(await noteRow(ids.ideaNew)).toEqual({ slug: `idea-${ids.ideaNew.slice(0, 8)}`, workspace_id: null });
    expect(await noteRow(ids.solo)).toEqual({ slug: 'solo', workspace_id: null });
  });

  test('notes in their owner’s workspace are untouched', async () => {
    expect(await noteRow(ids.planOwn)).toEqual({ slug: 'plan', workspace_id: aliceWs });
    expect(await noteRow(ids.bobOwn)).toEqual({ slug: 'plan', workspace_id: bobWs });
  });

  test('the other four tables are reset the same way', async () => {
    const ws = async (table: string, id: string) => (await q(`SELECT workspace_id FROM ${table} WHERE id::text = $1`, [id]))[0].workspace_id;
    expect(await ws('tasks', ids.taskForeign)).toBeNull();
    expect(await ws('tasks', ids.taskOwn)).toBe(aliceWs);
    expect(await ws('knowledge_links', ids.linkForeign)).toBeNull();
    expect(await ws('workspace_repos', ids.repoForeign)).toBeNull();
    expect(await ws('background_jobs', ids.jobForeign)).toBeNull();
  });

  test('the five tables reference workspaces with ON DELETE SET NULL', async () => {
    for (const t of TABLES) {
      const rows = await q(
        `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
         WHERE rc.constraint_schema = 'public' AND rc.constraint_name = $1`,
        [`${t}_workspace_id_fkey`],
      );
      expect(rows, t).toEqual([{ delete_rule: 'SET NULL' }]);
    }
    await expect(q(`INSERT INTO tasks (user_id, title, workspace_id) VALUES ($1, 't', $2)`, [alice, randomUUID()])).rejects.toThrow();
  });

  test('replaying the migration is a no-op', async () => {
    const before = await q(`SELECT id, slug, workspace_id FROM notes ORDER BY id`);
    await replay0127();
    expect(await q(`SELECT id, slug, workspace_id FROM notes ORDER BY id`)).toEqual(before);
  });

  test('deleting a workspace leaves its notes user-level, renaming a slug the user already uses', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const mgr = getOrgWorkspaceManager();
    const side = await mgr.createWorkspace(alice, { slug: 'side', name: 'Side' });
    const clash = await note('plan', side.id, '2026-04-01T00:00:00Z');
    const fresh = await note('fresh', side.id, '2026-04-01T00:00:00Z');
    expect(await mgr.delete(alice, side.id)).toBe(true);
    expect(await noteRow(clash)).toEqual({ slug: `plan-${clash.slice(0, 8)}`, workspace_id: null });
    expect(await noteRow(fresh)).toEqual({ slug: 'fresh', workspace_id: null });
  });
});
