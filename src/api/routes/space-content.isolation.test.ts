/**
 * Space content over REST (docs/plans/coworking-spec.md §5.4, §5.5, I1–I3).
 *
 * Driven through the real `createServer()` — auth derive, workspace derive
 * (with the space resolution and the `SPACE_ROUTES` rewrite), the denied
 * guard and the error handler that maps `SpaceError`:
 *
 *   - an editor writes a note, a task, a comment in the space; another
 *     member reads them, and the author's personal workspace does not
 *     show them;
 *   - a viewer reads but a write is 403;
 *   - a non-member naming the space gets 404 on every route, personal ones
 *     included; a removed member's next request is 404 too, while auth and
 *     the space list still answer so the client can recover;
 *   - a personal route with a space header runs in the personal workspace.
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

const ownerId = randomUUID();
const editorId = randomUUID();
const viewerId = randomUUID();
const strangerId = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let spaceId: string;

async function call(who: string, method: string, path: string, opts: { body?: unknown; space?: string | null } = {}): Promise<Response> {
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

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-content-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'sc-owner' },
    { id: editorId, username: 'sc-editor' },
    { id: viewerId, username: 'sc-viewer' },
    { id: strangerId, username: 'sc-stranger', isAdmin: true },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', ownerId], ['editor', editorId], ['viewer', viewerId], ['stranger', strangerId]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { createServer } = await import('@/api/server');
  app = createServer();

  const created = await call('owner', 'POST', '/api/spaces', { body: { name: 'Content' }, space: null });
  expect(created.status).toBe(201);
  spaceId = (await created.json()).id;
  for (const [who, role] of [['editor', 'editor'], ['viewer', 'viewer']]) {
    const res = await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { body: { role }, space: null });
    const { token } = await res.json();
    expect((await call(who, 'POST', `/api/invites/${token}/accept`, { space: null })).status).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('members share the space’s notes and tasks', () => {
  let noteId: string;
  let taskId: string;

  test('an editor writes a note; the owner and a viewer read it; the editor’s personal workspace does not', async () => {
    const res = await call('editor', 'POST', '/api/notes', { body: { title: 'Launch plan', body: 'see [[Budget]]' } });
    expect(res.status).toBe(200);
    noteId = (await res.json()).note.id;

    for (const who of ['owner', 'viewer']) {
      const list = await (await call(who, 'GET', '/api/notes')).json();
      expect(list.notes.map((n: { id: string }) => n.id), who).toContain(noteId);
      expect((await call(who, 'GET', `/api/notes/${noteId}`)).status, who).toBe(200);
    }
    const personal = await (await call('editor', 'GET', '/api/notes', { space: null })).json();
    expect(personal.notes.map((n: { id: string }) => n.id)).not.toContain(noteId);
    expect((await call('editor', 'GET', `/api/notes/${noteId}`, { space: null })).status).toBe(404);
  });

  test('a link inside the space binds to the space’s note, and the owner edits the editor’s note', async () => {
    const budget = await call('owner', 'POST', '/api/notes', { body: { title: 'Budget' } });
    expect(budget.status).toBe(200);
    const budgetId = (await budget.json()).note.id;
    const detail = await (await call('viewer', 'GET', `/api/notes/${noteId}`)).json();
    expect(detail.outgoing.find((e: { endpoint: { id?: string } }) => e.endpoint.id === budgetId)).toBeDefined();
    const edit = await call('owner', 'POST', '/api/notes', { body: { id: noteId, title: 'Launch plan', body: 'edited by the owner' } });
    expect(edit.status).toBe(200);
    expect((await edit.json()).note.userId).toBe(editorId);
  });

  test('an editor creates a task; the owner comments; every member reads the thread', async () => {
    const res = await call('editor', 'POST', '/api/tasks', { body: { title: 'Book the venue', workspaceId: randomUUID() } });
    expect(res.status).toBe(200);
    const task = await res.json();
    taskId = task.id;
    expect(task.workspaceId).toBe(spaceId);
    expect(task.userId).toBe(editorId);

    const comment = await call('owner', 'POST', `/api/tasks/${taskId}/comments`, { body: { body: 'on it' } });
    expect(comment.status).toBe(200);
    expect((await comment.json()).userId).toBe(ownerId);

    const thread = await (await call('viewer', 'GET', `/api/tasks/${taskId}/comments`)).json();
    expect(thread.comments.map((c: { body: string }) => c.body)).toEqual(['on it']);
    const list = await (await call('owner', 'GET', '/api/tasks')).json();
    expect(list.tasks.map((t: { id: string }) => t.id)).toContain(taskId);
    const personal = await (await call('editor', 'GET', '/api/tasks', { space: null })).json();
    expect(personal.tasks.map((t: { id: string }) => t.id)).not.toContain(taskId);
  });

  test('a viewer cannot write: 403 on notes, tasks, comments, documents and artifacts', async () => {
    expect((await call('viewer', 'POST', '/api/notes', { body: { title: 'Nope' } })).status).toBe(403);
    expect((await call('viewer', 'DELETE', `/api/notes/${noteId}`)).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/tasks', { body: { title: 'Nope' } })).status).toBe(403);
    expect((await call('viewer', 'PATCH', `/api/tasks/${taskId}`, { body: { status: 'done' } })).status).toBe(403);
    expect((await call('viewer', 'POST', `/api/tasks/${taskId}/comments`, { body: { body: 'hi' } })).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/artifacts', { body: { slug: 'nope', title: 'Nope', type: 'html' } })).status).toBe(403);
    const form = new FormData();
    form.append('files', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    const upload = await app.handle(new Request('http://localhost/api/documents/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.viewer}`, 'x-octipus-workspace': spaceId },
      body: form,
    }));
    expect(upload.status).toBe(403);
  });

  test('artifacts: a workspace artifact is shared, a private one is its creator’s only', async () => {
    const shared = await call('editor', 'POST', '/api/artifacts', { body: { slug: 'board', title: 'Board', type: 'html' } });
    expect(shared.status).toBe(201);
    const priv = await call('editor', 'POST', '/api/artifacts', { body: { slug: 'mine', title: 'Mine', type: 'html', visibility: 'private' } });
    expect(priv.status).toBe(201);
    const privId = (await priv.json()).artifact.id;
    const seen = await (await call('owner', 'GET', '/api/artifacts')).json();
    expect(seen.artifacts.map((a: { slug: string }) => a.slug)).toEqual(['board']);
    expect((await call('owner', 'GET', `/api/artifacts/${privId}`)).status).toBe(404);
    expect((await call('editor', 'GET', `/api/artifacts/${privId}`)).status).toBe(200);
  });
});

describe('non-members and removed members (I3)', () => {
  test('a non-member naming the space gets 404 everywhere, even on personal routes — admin included', async () => {
    for (const [method, path] of [['GET', '/api/notes'], ['GET', '/api/tasks'], ['GET', '/api/sessions'], ['GET', '/api/models'], ['GET', '/api/search?q=launch']]) {
      expect((await call('stranger', method, path)).status, `${method} ${path}`).toBe(404);
    }
    // …but can still sign in and list their spaces.
    expect((await call('stranger', 'GET', '/api/spaces')).status).toBe(200);
  });

  test('a personal route with a space header runs in the member’s personal workspace', async () => {
    const res = await call('editor', 'GET', '/api/memory');
    expect(res.status).toBe(200);
  });

  test('a removed member’s next request is 404, while the recovery paths answer', async () => {
    expect((await call('viewer', 'GET', '/api/notes')).status).toBe(200);
    const removed = await call('owner', 'DELETE', `/api/spaces/${spaceId}/members/${viewerId}`, { space: null });
    expect(removed.status).toBeLessThan(300);
    const denied = await call('viewer', 'GET', '/api/notes');
    expect(denied.status).toBe(404);
    // The web reads the code to switch back to the default workspace.
    expect(await denied.json()).toEqual({ error: 'Space not found', code: 'workspace_denied' });
    expect((await call('viewer', 'GET', '/api/tasks')).status).toBe(404);
    expect((await call('viewer', 'GET', '/api/spaces')).status).toBe(200);
    expect((await call('viewer', 'GET', '/api/me/workspaces')).status).toBe(200);
  });
});
