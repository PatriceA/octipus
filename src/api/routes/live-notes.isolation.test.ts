/**
 * Live space notes over REST (docs/plans/coworking-spec.md §7.3, §7.6):
 * revisions, restore, the live-editor merge and file leases, through the
 * real `createServer()`.
 *
 *   - members list and read a note's revisions; an editor restores one
 *     (written as a new revision); a viewer may not;
 *   - a non-member or another space's ids get 404 (I3), and so does a
 *     guest for a note outside their folders (S6);
 *   - a body write to an existing note names its base (400 without one);
 *   - `POST /notes/:id/merge` merges a live editor's unsent text, 409 on a
 *     clash;
 *   - file leases: a viewer may not take one (403), a non-member gets 404.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const ids = { owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), guest: randomUUID(), stranger: randomUUID() };

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let spaceId: string;
let otherSpaceId: string;

async function call(who: keyof typeof ids, method: string, path: string, opts: { body?: unknown; space?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  const space = opts.space === undefined ? spaceId : opts.space;
  if (space) headers['x-octipus-workspace'] = space;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }));
}

async function createNote(who: keyof typeof ids, title: string, body: string, space = spaceId): Promise<{ id: string; bodySha256: string }> {
  const res = await call(who, 'POST', '/api/notes', { body: { title, body }, space });
  expect(res.status).toBe(200);
  const { note } = await res.json();
  return { id: note.id, bodySha256: note.bodySha256 };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-live-notes-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers(Object.entries(ids).map(([name, id]) => ({ id, username: `ln-${name}` })));
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of Object.entries(ids)) tokens[name] = (await getSessionManager().create(id)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();

  const created = await call('owner', 'POST', '/api/spaces', { body: { name: 'Live notes' }, space: null });
  expect(created.status).toBe(201);
  spaceId = (await created.json()).id;
  for (const role of ['editor', 'viewer', 'guest'] as const) {
    const res = await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { body: { role }, space: null });
    const { token } = await res.json();
    expect((await call(role, 'POST', `/api/invites/${token}/accept`, { space: null })).status).toBe(200);
  }
  const other = await call('stranger', 'POST', '/api/spaces', { body: { name: 'Elsewhere' }, space: null });
  expect(other.status).toBe(201);
  otherSpaceId = (await other.json()).id;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('revisions', () => {
  test('members list and read revisions; an editor restores one as a new revision; a viewer may not', async () => {
    const note = await createNote('editor', 'History', 'first version\n');
    const edit = await call('editor', 'POST', '/api/notes', { body: { id: note.id, title: 'History', body: 'second version\n', baseSha256: note.bodySha256 } });
    expect(edit.status).toBe(200);

    const list = await call('viewer', 'GET', `/api/notes/${note.id}/revisions`);
    expect(list.status).toBe(200);
    const { revisions } = await list.json() as { revisions: Array<{ id: string; origin: string; bodySha256: string }> };
    expect(revisions).toHaveLength(2);
    const read = async (id: string) => {
      const res = await call('viewer', 'GET', `/api/notes/${note.id}/revisions/${id}`);
      expect(res.status).toBe(200);
      return (await res.json()).revision as { id: string; body: string };
    };
    const bodies = await Promise.all(revisions.map((r) => read(r.id)));
    expect(bodies.map((b) => b.body).sort()).toEqual(['first version\n', 'second version\n']);
    const firstVersion = bodies.find((b) => b.body === 'first version\n')!;

    expect((await call('viewer', 'POST', `/api/notes/${note.id}/revisions/${firstVersion.id}/restore`)).status).toBe(403);
    const restored = await call('editor', 'POST', `/api/notes/${note.id}/revisions/${firstVersion.id}/restore`);
    expect(restored.status).toBe(200);
    const result = await restored.json();
    expect(result.changed).toBe(true);
    const detail = await (await call('owner', 'GET', `/api/notes/${note.id}`)).json();
    expect(detail.body).toBe('first version\n');
    const after = await (await call('owner', 'GET', `/api/notes/${note.id}/revisions`)).json() as { revisions: Array<{ id: string; origin: string }> };
    expect(after.revisions).toHaveLength(3);
    expect(after.revisions.some((r) => r.origin === 'restore')).toBe(true);
  });

  test('a non-member and another space’s ids get 404, and so does a guest outside their folders', async () => {
    const note = await createNote('editor', 'Private history', 'v1\n');
    const { revisions } = await (await call('editor', 'GET', `/api/notes/${note.id}/revisions`)).json() as { revisions: Array<{ id: string }> };
    const rev = revisions[0].id;
    const paths: Array<[string, string]> = [
      ['GET', `/api/notes/${note.id}/revisions`],
      ['GET', `/api/notes/${note.id}/revisions/${rev}`],
      ['POST', `/api/notes/${note.id}/revisions/${rev}/restore`],
      ['GET', '/api/notes/proposals'],
    ];
    for (const [method, path] of paths) {
      expect((await call('stranger', method, path)).status, `stranger ${method} ${path}`).toBe(404);
    }
    // The guest's scope is empty: the note is not theirs to see, and the proposals list holds nothing of it.
    for (const [method, path] of paths.slice(0, 3)) {
      expect((await call('guest', method, path)).status, `guest ${method} ${path}`).toBe(404);
    }
    const guestProposals = await call('guest', 'GET', '/api/notes/proposals');
    expect(guestProposals.status).toBe(200);
    expect((await guestProposals.json()).proposals).toEqual([]);
    expect((await call('stranger', 'POST', `/api/notes/${note.id}/merge`, { body: { base: 'v1\n', text: 'v2\n' } })).status).toBe(404);
    expect([403, 404]).toContain((await call('guest', 'POST', `/api/notes/${note.id}/merge`, { body: { base: 'v1\n', text: 'v2\n' } })).status);

    // Another space's note and revision, named from this space: 404.
    const foreign = await createNote('stranger', 'Foreign', 'theirs\n', otherSpaceId);
    const foreignRevs = await (await call('stranger', 'GET', `/api/notes/${foreign.id}/revisions`, { space: otherSpaceId })).json() as { revisions: Array<{ id: string }> };
    expect(foreignRevs.revisions).toHaveLength(1);
    const foreignRev = foreignRevs.revisions[0].id;
    expect((await call('editor', 'GET', `/api/notes/${foreign.id}/revisions`)).status).toBe(404);
    expect((await call('editor', 'GET', `/api/notes/${note.id}/revisions/${foreignRev}`)).status).toBe(404);
    expect((await call('editor', 'GET', `/api/notes/${foreign.id}/revisions/${foreignRev}`)).status).toBe(404);
    expect((await call('editor', 'POST', `/api/notes/${note.id}/revisions/${foreignRev}/restore`)).status).toBe(404);
    // The stranger, from their own space, cannot reach this space's revision either.
    expect((await call('stranger', 'GET', `/api/notes/${foreign.id}/revisions/${rev}`, { space: otherSpaceId })).status).toBe(404);
  });
});

describe('writes name their base', () => {
  test('a body write to an existing space note without a base is 400; with it, 200', async () => {
    const note = await createNote('editor', 'Based', 'text\n');
    const missing = await call('editor', 'POST', '/api/notes', { body: { id: note.id, title: 'Based', body: 'other\n' } });
    expect(missing.status).toBe(400);
    const refusal = await missing.json();
    expect(refusal.code).toBe('base_required');
    expect(refusal.error).toMatch(/read the note first/);
    // A metadata-only save needs none.
    expect((await call('editor', 'POST', '/api/notes', { body: { id: note.id, title: 'Based, renamed' } })).status).toBe(200);
    const ok = await call('editor', 'POST', '/api/notes', { body: { id: note.id, title: 'Based', body: 'other\n', baseSha256: note.bodySha256 } });
    expect(ok.status).toBe(200);
  });

  test('POST /notes/:id/merge merges a live editor’s text; a clash is 409 and changes nothing; a viewer may not', async () => {
    const note = await createNote('editor', 'Merged', 'alpha\n\nbeta\n');
    // Meanwhile the owner changed the second paragraph.
    const owner = await call('owner', 'POST', '/api/notes', { body: { id: note.id, title: 'Merged', body: 'alpha\n\nBETA\n', baseSha256: note.bodySha256 } });
    expect(owner.status).toBe(200);
    const merged = await call('editor', 'POST', `/api/notes/${note.id}/merge`, { body: { base: 'alpha\n\nbeta\n', text: 'alpha, offline\n\nbeta\n' } });
    expect(merged.status).toBe(200);
    expect((await merged.json()).merged).toBe(true);
    const detail = await (await call('viewer', 'GET', `/api/notes/${note.id}`)).json();
    expect(detail.body).toBe('alpha, offline\n\nBETA\n');

    const clash = await call('editor', 'POST', `/api/notes/${note.id}/merge`, { body: { base: 'alpha\n\nbeta\n', text: 'alpha\n\nbeta, mine\n' } });
    expect(clash.status).toBe(409);
    expect((await clash.json()).code).toBe('stale');
    expect((await (await call('viewer', 'GET', `/api/notes/${note.id}`)).json()).body).toBe('alpha, offline\n\nBETA\n');

    expect((await call('viewer', 'POST', `/api/notes/${note.id}/merge`, { body: { base: 'alpha\n', text: 'x\n' } })).status).toBe(403);
  });
});

describe('file leases', () => {
  test('a viewer may read leases but not take one; a non-member gets 404', async () => {
    expect((await call('viewer', 'GET', `/api/spaces/${spaceId}/file-leases`, { space: null })).status).toBe(200);
    expect((await call('viewer', 'POST', `/api/spaces/${spaceId}/file-leases`, { body: { path: 'docs/plan.md' }, space: null })).status).toBe(403);
    expect((await call('stranger', 'GET', `/api/spaces/${spaceId}/file-leases`, { space: null })).status).toBe(404);
    expect((await call('stranger', 'POST', `/api/spaces/${spaceId}/file-leases`, { body: { path: 'docs/plan.md' }, space: null })).status).toBe(404);
    const taken = await call('editor', 'POST', `/api/spaces/${spaceId}/file-leases`, { body: { path: 'docs/plan.md' }, space: null });
    expect(taken.status).toBe(200);
  });
});
