import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';

// biome-ignore lint/suspicious/noExplicitAny: test harness over Elysia's opaque app type
type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const aliceId = randomUUID();
const bobId = randomUUID();
let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
/** Alice in a second workspace of hers. */
let aliceSideApp: ElysiaLike;
let aliceNoteId: string;
let aliceDefaultWs: string;
let aliceSideWs: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-notes-api-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);

  const { noteRoutes } = await import('./notes');
  const { graphRoutes } = await import('./graph');
  const { principalFromUser } = await import('@/security/principal');
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const mgr = getOrgWorkspaceManager();
  aliceDefaultWs = (await mgr.ensureDefaultWorkspace(aliceId)).id;
  aliceSideWs = (await mgr.createWorkspace(aliceId, { slug: 'side', name: 'Side' })).id;
  const bobDefaultWs = (await mgr.ensureDefaultWorkspace(bobId)).id;
  // The server derive resolves the request's workspace onto the principal.
  const buildApp = (uid: string, username: string, workspaceId: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username, isAdmin: false };
        return { user: u, session: null, principal: { ...principalFromUser(u), workspaceId } };
      })
      .group('/api', (a) => a.use(noteRoutes).use(graphRoutes)) as unknown as ElysiaLike;
  aliceApp = buildApp(aliceId, 'alice', aliceDefaultWs);
  aliceSideApp = buildApp(aliceId, 'alice', aliceSideWs);
  bobApp = buildApp(bobId, 'bob', bobDefaultWs);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function post(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: (await res.json()) as any };
}
async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: (await res.json()) as any };
}
async function del(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: (await res.json()) as any };
}
async function patch(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: (await res.json()) as any };
}

describe('Notes API', () => {
  test('create + read + list', async () => {
    const created = await post(aliceApp, '/api/notes', { title: 'Alpha', body: 'links [[Beta]] #x' });
    expect(created.status).toBe(200);
    aliceNoteId = created.body.note.id;
    expect(created.body.created).toBe(true);
    expect(created.body.links.added).toBe(2);

    const read = await get(aliceApp, `/api/notes/${aliceNoteId}`);
    expect(read.body.title).toBe('Alpha');
    // `#x` is a tag (surfaced via the tag list), so only [[Beta]] is an
    // outgoing *link*. Beta doesn't exist yet → a ghost edge carrying the ref.
    expect(read.body.outgoing.length).toBe(1);
    expect(read.body.outgoing[0].endpoint).toMatchObject({ ref: 'beta', resolved: false });

    const list = await get(aliceApp, '/api/notes');
    expect(list.body.notes.some((n: any) => n.id === aliceNoteId)).toBe(true);
  });

  test('cross-tenant read is 404, not 403', async () => {
    const cross = await get(bobApp, `/api/notes/${aliceNoteId}`);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: 'Note not found' });
  });

  test("list only returns the caller's notes", async () => {
    const r = await get(bobApp, '/api/notes');
    expect(r.body.notes.find((n: any) => n.id === aliceNoteId)).toBeUndefined();
  });

  test('graph returns the user’s nodes + edges, scoped', async () => {
    const g = await get(aliceApp, '/api/graph');
    expect(g.body.nodes.some((n: any) => n.id === aliceNoteId)).toBe(true);
    const bobGraph = await get(bobApp, '/api/graph');
    expect(bobGraph.body.nodes.find((n: any) => n.id === aliceNoteId)).toBeUndefined();
  });

  test('capture creates a daily note', async () => {
    const r = await post(aliceApp, '/api/notes/capture', { text: 'a thought', date: '2026-06-09' });
    expect(r.body.slug).toBe('daily/2026-06-09');
  });

  test('archive (soft delete) hides from listing', async () => {
    const created = await post(aliceApp, '/api/notes', { title: 'Throwaway' });
    const id = created.body.note.id;
    const d = await del(aliceApp, `/api/notes/${id}`);
    expect(d.body).toEqual({ deleted: true, hard: false });
    const list = await get(aliceApp, '/api/notes');
    expect(list.body.notes.find((n: any) => n.id === id)).toBeUndefined();
  });
});

describe('Notes workspace endpoints', () => {
  test('GET /notes/index returns the caller’s notes, scoped', async () => {
    const r = await get(aliceApp, '/api/notes/index');
    expect(r.status).toBe(200);
    expect(r.body.notes.some((n: any) => n.id === aliceNoteId)).toBe(true);
    expect(r.body.notes[0]).toHaveProperty('slug');
    expect(r.body.notes[0]).toHaveProperty('title');
    const b = await get(bobApp, '/api/notes/index');
    expect(b.body.notes.find((n: any) => n.id === aliceNoteId)).toBeUndefined();
  });

  test('GET /notes/tags aggregates counts, sorted desc', async () => {
    await post(aliceApp, '/api/notes', { title: 'Tagged one', body: '#alpha #shared' });
    await post(aliceApp, '/api/notes', { title: 'Tagged two', body: '#shared' });
    const r = await get(aliceApp, '/api/notes/tags');
    expect(r.status).toBe(200);
    const shared = r.body.tags.find((t: any) => t.tag === 'shared');
    expect(shared.count).toBeGreaterThanOrEqual(2);
    const counts = r.body.tags.map((t: any) => t.count);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
  });

  test('PATCH /notes/:id/pin toggles, 404 cross-tenant', async () => {
    const pin = await patch(aliceApp, `/api/notes/${aliceNoteId}/pin`, { pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body.pinned).toBe(true);
    const list = await get(aliceApp, '/api/notes');
    expect(list.body.notes.find((n: any) => n.id === aliceNoteId).pinned).toBe(true);
    const cross = await patch(bobApp, `/api/notes/${aliceNoteId}/pin`, { pinned: false });
    expect(cross.status).toBe(404);
  });

  test('backlinks resolve to real titles', async () => {
    const target = await post(aliceApp, '/api/notes', { title: 'Target Note', slug: 'target-note' });
    const targetId = target.body.note.id;
    await post(aliceApp, '/api/notes', { title: 'Source Note', body: 'see [[target-note]]' });
    const read = await get(aliceApp, `/api/notes/${targetId}`);
    expect(read.body.backlinks.length).toBeGreaterThanOrEqual(1);
    const bl = read.body.backlinks.find((b: any) => b.endpoint.title === 'Source Note');
    expect(bl).toBeDefined();
    expect(bl.endpoint.resolved).toBe(true);
  });
});

describe('Notes in workspaces', () => {
  test('a note is created in the request workspace and is invisible from another one', async () => {
    const created = await post(aliceApp, '/api/notes', { title: 'Default only', body: '#wsonly' });
    const id = created.body.note.id;
    expect(created.body.note.workspaceId).toBe(aliceDefaultWs);

    expect((await get(aliceSideApp, `/api/notes/${id}`)).status).toBe(404);
    expect((await get(aliceSideApp, '/api/notes')).body.notes.find((n: any) => n.id === id)).toBeUndefined();
    expect((await get(aliceSideApp, '/api/notes/index')).body.notes.find((n: any) => n.id === id)).toBeUndefined();
    expect((await get(aliceSideApp, '/api/notes/tags')).body.tags.find((t: any) => t.tag === 'wsonly')).toBeUndefined();
    expect((await post(aliceSideApp, '/api/notes/query', { tag: 'wsonly' })).body.notes).toEqual([]);
    expect((await patch(aliceSideApp, `/api/notes/${id}/pin`, { pinned: true })).status).toBe(404);
    expect((await get(aliceSideApp, `/api/notes/${id}/suggestions`)).status).toBe(404);
    expect((await del(aliceSideApp, `/api/notes/${id}`)).status).toBe(404);

    expect((await get(aliceApp, `/api/notes/${id}`)).status).toBe(200);
  });

  test('a user-level note is visible in every workspace', async () => {
    const { getNoteService } = await import('@/core/knowledge/notes');
    const { note } = await getNoteService().save({ userId: aliceId, workspaceId: null, title: 'Everywhere', slug: 'everywhere' });
    expect((await get(aliceApp, `/api/notes/${note.id}`)).status).toBe(200);
    expect((await get(aliceSideApp, `/api/notes/${note.id}`)).status).toBe(200);
    expect((await get(aliceSideApp, '/api/notes/index')).body.notes.some((n: any) => n.id === note.id)).toBe(true);
  });

  test('a workspaceId in the body is ignored', async () => {
    const created = await post(aliceApp, '/api/notes', { title: 'Body says side', workspaceId: aliceSideWs });
    expect(created.body.note.workspaceId).toBe(aliceDefaultWs);
    const captured = await post(aliceApp, '/api/notes/capture', { text: 'x', date: '2026-08-01', workspaceId: aliceSideWs });
    expect((await get(aliceApp, `/api/notes/${captured.body.id}`)).body.workspaceId).toBe(aliceDefaultWs);
  });

  test('daily capture does not duplicate a user-level daily note', async () => {
    const { getNoteService } = await import('@/core/knowledge/notes');
    const userLevel = await getNoteService().getOrCreateDaily(aliceId, null, '2026-07-01');
    expect(userLevel.workspaceId).toBeNull();

    const r = await post(aliceSideApp, '/api/notes/capture', { text: 'from the side workspace', date: '2026-07-01' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(userLevel.id);
    const r2 = await post(aliceApp, '/api/notes/capture', { text: 'from the default workspace', date: '2026-07-01' });
    expect(r2.body.id).toBe(userLevel.id);

    const { queryRaw } = await import('@/db/postgres');
    const rows = (await queryRaw(`SELECT id, workspace_id, body FROM notes WHERE user_id = $1 AND slug = 'daily/2026-07-01'`, [aliceId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBeNull();
    expect(rows[0].body).toContain('from the side workspace');
    expect(rows[0].body).toContain('from the default workspace');
  });

  test('a workspace daily note is preferred over the user-level one', async () => {
    const { getNoteService } = await import('@/core/knowledge/notes');
    const userLevel = await getNoteService().getOrCreateDaily(aliceId, null, '2026-07-02');
    // Both exist (written before the fallback, or by an older build).
    const { queryRaw } = await import('@/db/postgres');
    const [inSide] = (await queryRaw(
      `INSERT INTO notes (user_id, workspace_id, slug, title, body, body_sha256, note_kind, note_date)
       VALUES ($1, $2, 'daily/2026-07-02', '2026-07-02', '', 'sha', 'daily', '2026-07-02') RETURNING id`,
      [aliceId, aliceSideWs],
    )).rows;
    const r = await post(aliceSideApp, '/api/notes/capture', { text: 'side', date: '2026-07-02' });
    expect(r.body.id).toBe(inSide.id);
    const d = await post(aliceApp, '/api/notes/capture', { text: 'default', date: '2026-07-02' });
    expect(d.body.id).toBe(userLevel.id);
  });
});
