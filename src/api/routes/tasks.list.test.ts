/**
 * GET /api/tasks without a status: every active task first, then one page of
 * the done ones. The list used to be ordered by the status text (archived,
 * done, in_progress, open) and cut at 200 rows, so a user with 200 finished
 * tasks saw none of their open ones — on the web page and in the mobile app,
 * which both call the endpoint with no parameters.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = randomUUID();
const bobId = randomUUID();
let aliceApp: ElysiaLike;
const DONE = 230;
const ARCHIVED = 20;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tasks-list-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }, { id: bobId, username: 'bob' }]);

  // More finished tasks than the old shared cap, each finished a minute
  // after the one before; two active ones created before all of them.
  await executeRaw(
    `INSERT INTO tasks (user_id, title, status, priority, created_at) VALUES
       ('${aliceId}', 'open-low', 'open', 0, now() - interval '30 days'),
       ('${aliceId}', 'working', 'in_progress', 1, now() - interval '30 days'),
       ('${aliceId}', 'open-high', 'open', 3, now() - interval '30 days'),
       ('${bobId}', 'bob-open', 'open', 0, now())`,
  );
  await executeRaw(
    `INSERT INTO tasks (user_id, title, status, priority, completed_at)
     SELECT '${aliceId}', 'done-' || g, 'done', 0, now() - (${DONE} - g) * interval '1 minute'
       FROM generate_series(1, ${DONE}) AS g`,
  );
  await executeRaw(
    `INSERT INTO tasks (user_id, title, status, priority)
     SELECT '${aliceId}', 'archived-' || g, 'archived', 0 FROM generate_series(1, ${ARCHIVED}) AS g`,
  );

  const { taskRoutes } = await import('./tasks');
  const { principalFromUser } = await import('@/security/principal');
  aliceApp = new Elysia()
    .derive(() => {
      const u = { id: aliceId, username: 'alice', isAdmin: false };
      return { user: u, session: null, principal: principalFromUser(u) };
    })
    .group('/api', (a) => a.use(taskRoutes)) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(path: string) {
  const res = await aliceApp.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: (await res.json()) as any };
}

describe('GET /api/tasks with no status', () => {
  test('lists every active task first, then the 50 most recently done, with a done summary', async () => {
    const { status, body } = await get('/api/tasks');
    expect(status).toBe(200);
    const titles: string[] = body.tasks.map((t: any) => t.title);
    // In progress, then open by priority; bob's never.
    expect(titles.slice(0, 3)).toEqual(['working', 'open-high', 'open-low']);
    expect(titles).not.toContain('bob-open');
    const done = titles.slice(3);
    expect(done).toHaveLength(50);
    expect(done[0]).toBe(`done-${DONE}`);
    expect(done.at(-1)).toBe(`done-${DONE - 49}`);
    // Archived tasks are left out of the default list.
    expect(titles.some((t) => t.startsWith('archived-'))).toBe(false);
    expect(body.done).toEqual({ total: DONE, offset: 0, limit: 50, hasMore: true });
    expect(typeof body.serverNow).toBe('string');
  });

  test('doneOffset and doneLimit page through the done tasks; the active ones come every time', async () => {
    const { body } = await get('/api/tasks?doneLimit=100&doneOffset=200');
    const titles: string[] = body.tasks.map((t: any) => t.title);
    expect(titles.slice(0, 3)).toEqual(['working', 'open-high', 'open-low']);
    expect(titles.slice(3)).toEqual(Array.from({ length: DONE - 200 }, (_, i) => `done-${DONE - 200 - i}`));
    expect(body.done).toEqual({ total: DONE, offset: 200, limit: 100, hasMore: false });
  });

  test('doneLimit=0 returns only the active tasks and still counts the done ones', async () => {
    const { body } = await get('/api/tasks?doneLimit=0');
    expect(body.tasks.map((t: any) => t.title)).toEqual(['working', 'open-high', 'open-low']);
    expect(body.done).toMatchObject({ total: DONE, hasMore: true });
  });

  test('doneLimit is capped and a non-numeric one is refused', async () => {
    const capped = await get('/api/tasks?doneLimit=100000');
    expect(capped.body.done.limit).toBe(500);
    expect(capped.body.tasks).toHaveLength(3 + DONE);
    const bad = await get('/api/tasks?doneLimit=lots');
    expect(bad.status).toBe(422);
  });

  test('filters apply to both parts', async () => {
    const { body } = await get('/api/tasks?category=none&assigneeKind=role');
    expect(body.tasks).toEqual([]);
    expect(body.done.total).toBe(0);
  });
});

describe('GET /api/tasks?status=', () => {
  test('status=done lists the most recently finished first, archived ones only on request', async () => {
    const done = await get('/api/tasks?status=done');
    expect(done.body.tasks[0].title).toBe(`done-${DONE}`);
    expect(done.body.tasks).toHaveLength(200);
    expect(done.body.done).toBeUndefined();
    const archived = await get('/api/tasks?status=archived');
    expect(archived.body.tasks).toHaveLength(ARCHIVED);
  });
});

describe('TaskRepo.listOwn', () => {
  test('a limit never cuts an active task out in favour of a finished one', async () => {
    const { contentRepos } = await import('@/db/repositories/content');
    const { principalFromUser } = await import('@/security/principal');
    const repo = contentRepos(principalFromUser({ id: aliceId, username: 'alice', isAdmin: false })).tasks;
    const rows = await repo.listOwn({ limit: 5 });
    expect(rows.map((r) => r.title)).toEqual(['working', 'open-high', 'open-low', `done-${DONE}`, `done-${DONE - 1}`]);
    expect(await repo.countOwn({ status: 'done' })).toBe(DONE);
    expect(await repo.countOwn()).toBe(3 + DONE + ARCHIVED);
  });
});
