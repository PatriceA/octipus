/**
 * Migration 0125 (knowledge scope): owner backfill for rows written before
 * every write named an owner, and product docs still searchable for a
 * non-admin afterwards.
 *
 * The database is migrated to head, legacy rows are inserted the way the old
 * code wrote them (no user, no workspace), then the 0125 backfill is applied
 * again — it is idempotent, so this replays exactly what an upgrade does.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const alice = randomUUID();
const bob = randomUUID();
const ghost = randomUUID(); // a path names a user that does not exist
let aliceDefaultWs: string;
let aliceOtherWs: string;
let docViaDocId: string;
let docViaSourceId: string;
let textOwnerDoc: string;

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;

async function rows(sql: string): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql)).rows;
}

async function legacyRow(sourceId: string, content: string, extra: { docId?: string; metadata?: Record<string, unknown> } = {}): Promise<string> {
  const id = randomUUID();
  const { queryRaw } = await import('@/db/postgres');
  await queryRaw(
    `INSERT INTO embeddings (id, source_id, content, embedding, model, purpose, content_sha256, embedding_version, metadata, doc_id)
     VALUES ($1, $2, $3, '[0.1,0.2,0.3]', 'm', 'document', $4, 'm/3', $5, $6)`,
    [id, sourceId, content, randomUUID(), JSON.stringify(extra.metadata ?? {}), extra.docId ?? null],
  );
  return id;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-kb-0125-'));
  process.env.LOG_LEVEL ??= 'error';
  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedDocument, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'alice' }, { id: bob, username: 'bob' }]);
  aliceDefaultWs = randomUUID();
  aliceOtherWs = randomUUID();
  await queryRaw(
    `INSERT INTO workspaces (id, user_id, slug, name, is_default) VALUES
       ($1, $3, 'default', 'Default', true),
       ($2, $3, 'side', 'Side', false)`,
    [aliceDefaultWs, aliceOtherWs, alice],
  );
  docViaDocId = (await seedDocument({ userId: alice, originalName: 'a.pdf' })).id;
  docViaSourceId = (await seedDocument({ userId: bob, originalName: 'b.pdf' })).id;
  await queryRaw(`UPDATE documents SET workspace_id = $1 WHERE id = $2`, [aliceOtherWs, docViaDocId]);
  textOwnerDoc = (await seedDocument({ userId: 'local', originalName: 'legacy.pdf' })).id;

  ids.docJoin = await legacyRow(`doc:${docViaDocId}`, 'structural chunk of alice upload', { docId: docViaDocId });
  ids.docSource = await legacyRow(`doc:${docViaSourceId}`, 'flat chunk of bob upload');
  ids.docTextOwner = await legacyRow(`doc:${textOwnerDoc}`, 'chunk of a document owned by a non-uuid id', { docId: textOwnerDoc });
  ids.fileDefault = await legacyRow(`/srv/ws/users/${alice}/workspaces/default/files/notes/plan.md`, 'alice default workspace file');
  ids.fileUuid = await legacyRow(`/srv/ws/users/${alice}/workspaces/${aliceOtherWs}/files/x.md`, 'alice side workspace file');
  ids.fileUnknownSegment = await legacyRow(`/srv/ws/users/${bob}/workspaces/elsewhere/files/y.md`, 'bob file in an unknown workspace');
  ids.fileWindows = await legacyRow(`C:\\ws\\users\\${bob}\\workspaces\\default\\files\\z.md`, 'bob windows path file');
  ids.fileGhost = await legacyRow(`/srv/ws/users/${ghost}/workspaces/default/files/g.md`, 'file of a user that does not exist');
  ids.product = await legacyRow('/app/docs/CHANNELS.md', 'wombat telegram setup from the product manual', { metadata: { source: 'octipus-docs' } });
  ids.orphan = await legacyRow('/somewhere/else.md', 'wombat unattributable legacy row');

  // Replay the 0125 statements (idempotent) over the legacy rows.
  const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0125_knowledge_scope.sql'), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) await executeRaw(statement);
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function owner(id: string): Promise<{ user_id: string | null; workspace_id: string | null }> {
  return (await rows(`SELECT user_id, workspace_id FROM embeddings WHERE id = '${id}'`))[0];
}

describe('0125 owner backfill', () => {
  test('document rows take owner and workspace from their documents row, via doc_id or source id', async () => {
    expect(await owner(ids.docJoin)).toEqual({ user_id: alice, workspace_id: aliceOtherWs });
    expect(await owner(ids.docSource)).toEqual({ user_id: bob, workspace_id: null });
  });

  test('a document owned by a non-uuid id stays an install row', async () => {
    expect(await owner(ids.docTextOwner)).toEqual({ user_id: null, workspace_id: null });
  });

  test('file rows take the user from their path; `default` maps to the default workspace', async () => {
    expect(await owner(ids.fileDefault)).toEqual({ user_id: alice, workspace_id: aliceDefaultWs });
    expect(await owner(ids.fileUuid)).toEqual({ user_id: alice, workspace_id: aliceOtherWs });
    expect(await owner(ids.fileUnknownSegment)).toEqual({ user_id: bob, workspace_id: null });
    expect(await owner(ids.fileWindows)).toEqual({ user_id: bob, workspace_id: null });
  });

  test('a path naming no existing user, an unattributable row and product docs stay owner-less', async () => {
    expect((await owner(ids.fileGhost)).user_id).toBeNull();
    expect((await owner(ids.orphan)).user_id).toBeNull();
    expect((await owner(ids.product)).user_id).toBeNull();
  });

  test('dedup is per owner: two users index the same content at the same path', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const svc = getEmbeddingService();
    const a = await svc.store({ ownerUserId: alice, workspaceId: null }, 'document', '/shared/same.md', 'identical text', [0.1, 0.2, 0.3], {});
    const b = await svc.store({ ownerUserId: bob, workspaceId: null }, 'document', '/shared/same.md', 'identical text', [0.1, 0.2, 0.3], {});
    expect(a).not.toBe(b);
    // Re-indexing by the same owner is still a no-op on the existing row.
    expect(await svc.store({ ownerUserId: alice, workspaceId: null }, 'document', '/shared/same.md', 'identical text', [0.1, 0.2, 0.3], {})).toBe(a);
  });
});

describe('product docs after 0125', () => {
  test('stay searchable for a non-admin, without exposing install rows', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const svc = getEmbeddingService();
    vi.spyOn(svc, 'generateEmbedding').mockRejectedValue(new Error('no embedding model'));
    const hits = await svc.hybridSearch({ kind: 'personal', userId: bob, workspaceId: null }, 'wombat', 10, 'document');
    expect(hits.map((h) => h.id)).toEqual([ids.product]);
    expect((await svc.searchGlobalDocs('wombat', 10)).map((h) => h.id)).toEqual([ids.product]);
  });
});
