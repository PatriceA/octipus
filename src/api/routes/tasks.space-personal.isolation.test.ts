/**
 * The personal layer of a space's to-dos is per member (review of the to-do
 * redesign): one member's star, My Day and order are not another's, a viewer
 * may set their own without write access, and the space's lists (including
 * an empty one) are the space's, not anyone's personal lists. Driven through
 * the real `createServer()` as in space-content.isolation.test.ts.
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
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-todos-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'st-owner' },
    { id: editorId, username: 'st-editor' },
    { id: viewerId, username: 'st-viewer' },
    { id: strangerId, username: 'st-stranger', isAdmin: true },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', ownerId], ['editor', editorId], ['viewer', viewerId], ['stranger', strangerId]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { createServer } = await import('@/api/server');
  app = createServer();

  const created = await call('owner', 'POST', '/api/spaces', { body: { name: 'Todos' }, space: null });
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

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

describe('the personal layer of a space to-do is each member\'s own', () => {
  test('stars, My Day and order do not leak between members; a viewer sets their own', async () => {
    const created = await json(await call('editor', 'POST', '/api/tasks', { body: { title: 'Ship it', important: true, myDay: true, sortOrder: 5, tz: 'UTC' } }));
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ important: true, sortOrder: 5, myDayOn: expect.any(String) });
    const id = created.body.id;
    const asOwner = await json(await call('owner', 'GET', `/api/tasks/${id}`));
    expect(asOwner.body).toMatchObject({ important: false, myDayOn: null });
    expect(asOwner.body.sortOrder).not.toBe(5);
    const ownerList = await json(await call('owner', 'GET', '/api/tasks'));
    expect(ownerList.body.tasks.find((t: any) => t.id === id)).toMatchObject({ important: false, myDayOn: null });
    expect((await json(await call('owner', 'GET', '/api/tasks/my-day?tz=UTC'))).body.tasks).toEqual([]);
    expect((await json(await call('editor', 'GET', '/api/tasks/my-day?tz=UTC'))).body.tasks.map((t: any) => t.id)).toEqual([id]);

    // A viewer may star for themselves, but not edit the task.
    const starred = await json(await call('viewer', 'PATCH', `/api/tasks/${id}`, { body: { important: true } }));
    expect(starred).toMatchObject({ status: 200, body: { important: true } });
    expect((await call('viewer', 'PATCH', `/api/tasks/${id}`, { body: { title: 'Renamed' } })).status).toBe(403);
    expect((await json(await call('owner', 'GET', `/api/tasks/${id}`))).body.important).toBe(false);
    // The editor's own star stays.
    expect((await json(await call('editor', 'GET', `/api/tasks/${id}`))).body.important).toBe(true);
  });

  test('a space\'s lists are the space\'s: an empty one is shared with members and not in anyone\'s personal lists', async () => {
    expect((await call('editor', 'POST', '/api/tasks/lists', { body: { name: 'Launch plan' } })).status).toBe(200);
    expect((await call('viewer', 'POST', '/api/tasks/lists', { body: { name: 'Nope' } })).status).toBe(403);
    const names = async (who: string, space?: string | null) => (await json(await call(who, 'GET', '/api/tasks/lists', { space }))).body.lists.map((l: any) => l.name);
    expect(await names('owner')).toContain('Launch plan');
    expect(await names('editor', null)).not.toContain('Launch plan');
    expect((await call('stranger', 'GET', '/api/tasks/lists')).status).toBe(404);
  });
});
