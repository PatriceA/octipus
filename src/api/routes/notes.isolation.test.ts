import { personalNoteScope } from '@/db/repositories/note-repository';
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

  test('daily opens the day’s note, creating it once', async () => {
    const first = await post(aliceApp, '/api/notes/daily', { date: '2026-11-23' });
    expect(first.status).toBe(200);
    expect(first.body.note).toMatchObject({ slug: 'daily/2026-11-23', noteKind: 'daily', noteDate: '2026-11-23' });
    const again = await post(aliceApp, '/api/notes/daily', { date: '2026-11-23' });
    expect(again.body.note.id).toBe(first.body.note.id);
    expect((await post(aliceApp, '/api/notes/daily', { date: 'today' })).status).toBe(422);
    // A day that does not exist is refused, not rolled into the next month.
    const impossible = await post(aliceApp, '/api/notes/daily', { date: '2026-02-31' });
    expect(impossible.status).toBe(400);
    // An archived day's note comes back when asked for.
    await del(aliceApp, `/api/notes/${first.body.note.id}`);
    const back = await post(aliceApp, '/api/notes/daily', { date: '2026-11-23' });
    expect(back.body).toMatchObject({ restored: true, note: { id: first.body.note.id, archivedAt: null } });
    // Another user's day is their own.
    expect((await post(bobApp, '/api/notes/daily', { date: '2026-11-23' })).body.note.id).not.toBe(first.body.note.id);
  });

  test('move changes the slug, keeps the old one as an alias, and refuses a taken slug', async () => {
    const a = (await post(aliceApp, '/api/notes', { title: 'Move me', body: 'x' })).body.note;
    await post(aliceApp, '/api/notes', { title: 'Taken', body: 'y' });
    const moved = await post(aliceApp, `/api/notes/${a.id}/move`, { slug: 'projects/move-me' });
    expect(moved.status).toBe(200);
    expect(moved.body.note).toMatchObject({ id: a.id, slug: 'projects/move-me', title: 'Move me', frontmatter: { movedFrom: ['move-me'] } });
    const index = await get(aliceApp, '/api/notes/index');
    expect(index.body.notes.find((n: any) => n.id === a.id)).toMatchObject({ slug: 'projects/move-me', movedFrom: ['move-me'] });
    const clash = await post(aliceApp, `/api/notes/${a.id}/move`, { slug: 'taken' });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('exists');
    expect((await post(aliceApp, `/api/notes/${a.id}/move`, { slug: '!!!' })).status).toBe(400);
    // Another user cannot move it (and cannot tell it exists).
    expect((await post(bobApp, `/api/notes/${a.id}/move`, { slug: 'mine' })).status).toBe(404);
  });

  test('preview=true lists a line of each note instead of its body', async () => {
    const created = (await post(aliceApp, '/api/notes', { title: 'Previewed', body: `Previewed\n${'- [ ] a task\n'.repeat(5000)}` })).body.note;
    const list = await get(aliceApp, '/api/notes?preview=true&limit=500');
    const row = list.body.notes.find((n: any) => n.id === created.id);
    expect(row.body).toBeUndefined();
    expect(row.preview.startsWith('a task · a task')).toBe(true);
    expect(row.preview.length).toBeLessThanOrEqual(140);
    // Without it the list is as before (the mobile app reads `body`).
    expect((await get(aliceApp, '/api/notes')).body.notes.find((n: any) => n.id === created.id).body).toContain('a task');
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
    const { note } = await getNoteService().save({ scope: personalNoteScope(aliceId, null), title: 'Everywhere', slug: 'everywhere' });
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
    const userLevel = await getNoteService().getOrCreateDaily(personalNoteScope(aliceId), '2026-07-01');
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
    const userLevel = await getNoteService().getOrCreateDaily(personalNoteScope(aliceId), '2026-07-02');
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

describe('Note search and the archive', () => {
  test('?q= matches every word in the title, tags or body, title matches first, scoped to the caller', async () => {
    const inBody = await post(aliceApp, '/api/notes', { title: 'Groceries', body: 'remember the Sourdough starter for saturday' });
    const inTitle = await post(aliceApp, '/api/notes', { title: 'Sourdough starter log', body: 'feeding notes' });
    await post(aliceApp, '/api/notes', { title: 'Saturday plans', body: 'hiking' });
    await post(bobApp, '/api/notes', { title: 'Bob sourdough', body: 'sourdough starter' });

    const r = await get(aliceApp, `/api/notes?q=${encodeURIComponent('sourdough  STARTER')}`);
    expect(r.status).toBe(200);
    expect(r.body.notes.map((n: any) => n.id)).toEqual([inTitle.body.note.id, inBody.body.note.id]);

    // Every word must match: "saturday" alone finds two, with "hiking" one.
    const one = await get(aliceApp, `/api/notes?q=${encodeURIComponent('saturday hiking')}`);
    expect(one.body.notes.map((n: any) => n.title)).toEqual(['Saturday plans']);

    // Tags are searched too.
    const tagged = await get(aliceApp, '/api/notes?q=alpha');
    expect(tagged.body.notes.map((n: any) => n.title)).toContain('Tagged one');
  });

  test('?q= takes LIKE wildcards literally and leaves archived notes out', async () => {
    await post(aliceApp, '/api/notes', { title: 'Progress', body: 'at 100% now' });
    await post(aliceApp, '/api/notes', { title: 'Other', body: 'at 1000 now' });
    const pct = await get(aliceApp, `/api/notes?q=${encodeURIComponent('100%')}`);
    expect(pct.body.notes.map((n: any) => n.title)).toEqual(['Progress']);
    const underscore = await get(aliceApp, `/api/notes?q=${encodeURIComponent('_')}`);
    expect(underscore.body.notes).toEqual([]);

    const gone = await post(aliceApp, '/api/notes', { title: 'Archived pineapple', body: 'x' });
    await del(aliceApp, `/api/notes/${gone.body.note.id}`);
    const archived = await get(aliceApp, '/api/notes?q=pineapple');
    expect(archived.body.notes).toEqual([]);
  });

  test('?archived=only lists the archived notes alone; restore brings one back; cross-tenant restore is 404', async () => {
    const a = await post(aliceApp, '/api/notes', { title: 'Old idea one', body: 'first' });
    const b = await post(aliceApp, '/api/notes', { title: 'Old idea two', body: 'second' });
    await del(aliceApp, `/api/notes/${a.body.note.id}`);
    await del(aliceApp, `/api/notes/${b.body.note.id}`);

    const archive = await get(aliceApp, '/api/notes?archived=only');
    const ids = archive.body.notes.map((n: any) => n.id);
    expect(ids).toContain(a.body.note.id);
    expect(ids).toContain(b.body.note.id);
    expect(archive.body.notes.every((n: any) => n.archivedAt)).toBe(true);
    expect(ids.indexOf(b.body.note.id)).toBeLessThan(ids.indexOf(a.body.note.id));
    const bobsArchive = await get(bobApp, '/api/notes?archived=only');
    expect(bobsArchive.body.notes.find((n: any) => n.id === a.body.note.id)).toBeUndefined();

    const cross = await post(bobApp, `/api/notes/${a.body.note.id}/restore`, {});
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: 'Note not found' });

    const restored = await post(aliceApp, `/api/notes/${a.body.note.id}/restore`, {});
    expect(restored).toEqual({ status: 200, body: { restored: true } });
    const list = await get(aliceApp, '/api/notes');
    expect(list.body.notes.find((n: any) => n.id === a.body.note.id)?.archivedAt).toBeNull();
    const after = await get(aliceApp, '/api/notes?archived=only');
    expect(after.body.notes.find((n: any) => n.id === a.body.note.id)).toBeUndefined();
    expect(after.body.notes.find((n: any) => n.id === b.body.note.id)).toBeDefined();
    const found = await get(aliceApp, '/api/notes?q=first');
    expect(found.body.notes.map((n: any) => n.id)).toContain(a.body.note.id);
  });
});

describe('POST /notes createOnly', () => {
  test('a create-only save never overwrites a note at the same slug, archived or not', async () => {
    const first = await post(aliceApp, '/api/notes', { title: 'Weekly plan', body: 'original' });
    expect(first.status).toBe(200);
    // Without the flag, a save with no id updates the note at that slug.
    const clash = await post(aliceApp, '/api/notes', { title: 'Weekly plan', body: 'replacement', createOnly: true });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'exists', id: first.body.note.id, slug: first.body.note.slug });
    expect((await get(aliceApp, `/api/notes/${first.body.note.id}`)).body.body).toBe('original');

    await del(aliceApp, `/api/notes/${first.body.note.id}`);
    const overArchived = await post(aliceApp, '/api/notes', { title: 'Weekly plan', body: 'replacement', createOnly: true });
    expect(overArchived.status).toBe(409);
    const archived = await get(aliceApp, '/api/notes?archived=only&q=weekly');
    expect(archived.body.notes.map((n: any) => n.body)).toEqual(['original']);

    const fresh = await post(aliceApp, '/api/notes', { title: 'Weekly plan 2', body: 'new', createOnly: true });
    expect(fresh.status).toBe(200);
    expect(fresh.body.created).toBe(true);
  });
});

describe('POST /notes ifSha256 and deferred indexing', () => {
  test('a personal save made from an older text is 409 stale and writes nothing; the save does not wait for indexing', async () => {
    const created = await post(aliceApp, '/api/notes', { title: 'Phone and desktop', body: 'first' });
    expect(created.body).toMatchObject({ indexed: false, indexQueued: true });
    const base = created.body.note.bodySha256;
    await post(aliceApp, '/api/notes', { id: created.body.note.id, title: 'Phone and desktop', body: 'from the phone' });
    const stale = await post(aliceApp, '/api/notes', { id: created.body.note.id, title: 'Phone and desktop', body: 'from the desktop', ifSha256: base });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale');
    expect((await get(aliceApp, `/api/notes/${created.body.note.id}`)).body.body).toBe('from the phone');
  });

  test('restoring a note that is not archived is a no-op success', async () => {
    const created = await post(aliceApp, '/api/notes', { title: 'Never archived', body: 'x' });
    const before = (await get(aliceApp, `/api/notes/${created.body.note.id}`)).body.updatedAt;
    expect((await post(aliceApp, `/api/notes/${created.body.note.id}/restore`, {})).status).toBe(200);
    expect((await get(aliceApp, `/api/notes/${created.body.note.id}`)).body.updatedAt).toBe(before);
  });
});
