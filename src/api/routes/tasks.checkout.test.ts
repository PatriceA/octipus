/**
 * Work board on /api/tasks: atomic checkout, release, assignee and comments.
 *
 * The claim is one conditional UPDATE, so two concurrent checkouts by
 * different actors must yield exactly one 200 and one 409 naming the winner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
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

let app: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tasks-checkout-'));

  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${aliceId}', 'alice', false) ON CONFLICT DO NOTHING`);

  const { taskRoutes } = await import('./tasks');
  const { principalFromUser } = await import('@/security/principal');
  app = new Elysia()
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

async function send(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
const create = async (body: Record<string, unknown>) => (await send('POST', '/api/tasks', body)).body;

describe('POST /api/tasks/:id/checkout', () => {
  test('two concurrent checkouts: exactly one wins, the other gets 409 with the holder', async () => {
    const task = await create({ title: 'contended' });
    const results = await Promise.all([
      send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-a', runId: 'run-a' }),
      send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-b', runId: 'run-b' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    const loser = results.find((r) => r.status === 409)!;
    expect(winner.body).toMatchObject({ status: 'in_progress' });
    expect(['node-a', 'node-b']).toContain(winner.body.checkedOutBy);
    expect(loser.body).toMatchObject({ reason: 'conflict', holder: winner.body.checkedOutBy });
  });

  test('re-checkout by the holder is idempotent; the user defaults to the actor', async () => {
    const task = await create({ title: 'mine' });
    const first = await send('POST', `/api/tasks/${task.id}/checkout`);
    expect(first.status).toBe(200);
    expect(first.body.checkedOutBy).toBe(`user:${aliceId}`);
    const again = await send('POST', `/api/tasks/${task.id}/checkout`, {});
    expect(again.status).toBe(200);
    expect(again.body.checkedOutBy).toBe(`user:${aliceId}`);
  });

  test('a task with an open blocker or open sub-tasks is 409 blocked', async () => {
    const blocker = await create({ title: 'first' });
    const blocked = await create({ title: 'second', blockedBy: [blocker.id] });
    const r = await send('POST', `/api/tasks/${blocked.id}/checkout`, { actor: 'node-a' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: 'blocked', waiting: { blockers: [{ id: blocker.id, title: 'first' }] } });

    const phase = await create({ title: 'phase' });
    await create({ title: 'child', parentId: phase.id });
    const p = await send('POST', `/api/tasks/${phase.id}/checkout`, { actor: 'node-a' });
    expect(p.body).toMatchObject({ reason: 'blocked', waiting: { openChildren: 1 } });

    await send('PATCH', `/api/tasks/${blocker.id}`, { status: 'done' });
    const freed = await send('POST', `/api/tasks/${blocked.id}/checkout`, { actor: 'node-a' });
    expect(freed.status).toBe(200);
  });

  test('completing clears the checkout, and a done task cannot be checked out', async () => {
    const task = await create({ title: 'finish me' });
    await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-a', runId: 'run-1' });
    const done = await send('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    expect(done.body).toMatchObject({ status: 'done', checkedOutBy: null, checkedOutAt: null, checkoutRunId: null });
    const late = await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-b' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ reason: 'conflict', holder: null, status: 'done' });
  });

  test('a done task is a status conflict even when it is also blocked', async () => {
    const blocker = await create({ title: 'still open' });
    const task = await create({ title: 'closed but blocked', blockedBy: [blocker.id] });
    await send('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    const r = await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-a' });
    expect(r).toMatchObject({ status: 409, body: { reason: 'conflict', status: 'done', error: 'Task is done' } });
  });

  test('a lapsed lease is taken over atomically; a live one is not', async () => {
    const task = await create({ title: 'abandoned' });
    await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-dead' });
    const live = await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-b' });
    expect(live.status).toBe(409);
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE tasks SET checked_out_at = now() - interval '31 minutes' WHERE id = '${task.id}'`);
    const takeover = await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-b', runId: 'run-b' });
    expect(takeover.status).toBe(200);
    expect(takeover.body).toMatchObject({ checkedOutBy: 'node-b', checkoutRunId: 'run-b' });
  });

  test('moving a task back to open ends the checkout; the user overrides a holder', async () => {
    const task = await create({ title: 'reopen me' });
    await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-a' });
    const edited = await send('PATCH', `/api/tasks/${task.id}`, { title: 'renamed by the user' });
    expect(edited.body).toMatchObject({ title: 'renamed by the user', checkedOutBy: 'node-a' });
    const reopened = await send('PATCH', `/api/tasks/${task.id}`, { status: 'open' });
    expect(reopened.body).toMatchObject({ status: 'open', checkedOutBy: null, checkedOutAt: null });
  });

  test('unknown task is 404', async () => {
    const r = await send('POST', '/api/tasks/00000000-0000-0000-0000-000000000000/checkout');
    expect(r).toEqual({ status: 404, body: { error: 'Task not found' } });
  });
});

describe('POST /api/tasks/:id/release', () => {
  test('only the holder releases (task back to open); force clears a dead holder', async () => {
    const task = await create({ title: 'stale' });
    await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-dead' });
    const other = await send('POST', `/api/tasks/${task.id}/release`, { actor: 'node-b' });
    expect(other.status).toBe(409);
    expect(other.body.holder).toBe('node-dead');
    const forced = await send('POST', `/api/tasks/${task.id}/release`, { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ status: 'open', checkedOutBy: null });
    const claim = await send('POST', `/api/tasks/${task.id}/checkout`, { actor: 'node-b' });
    expect(claim.status).toBe(200);
  });

  test('releasing a task nobody holds writes nothing', async () => {
    const task = await create({ title: 'unheld' });
    const r = await send('POST', `/api/tasks/${task.id}/release`, { actor: 'node-a' });
    expect(r.status).toBe(200);
    expect(r.body.updatedAt).toBe(task.updatedAt);
  });
});

describe('assignee', () => {
  test('create, filter and clear an assignee; half an assignee is a 400', async () => {
    const a = await create({ title: 'for pm', assigneeKind: 'role', assigneeRef: 'pm' });
    expect(a).toMatchObject({ assigneeKind: 'role', assigneeRef: 'pm' });
    await create({ title: 'for coder', assigneeKind: 'role', assigneeRef: 'coder' });
    const list = await send('GET', '/api/tasks?assigneeKind=role&assigneeRef=pm');
    expect(list.body.tasks.map((t: any) => t.title)).toEqual(['for pm']);

    const half = await send('POST', '/api/tasks', { title: 'x', assigneeKind: 'node' });
    expect(half.status).toBe(400);
    const cleared = await send('PATCH', `/api/tasks/${a.id}`, { assigneeKind: null });
    expect(cleared.body).toMatchObject({ assigneeKind: null, assigneeRef: null });
  });

  test('a null ref on its own clears; a ref without a kind is a 400', async () => {
    const a = await create({ title: 'for node', assigneeKind: 'node', assigneeRef: 'node-7' });
    const refOnly = await send('PATCH', `/api/tasks/${a.id}`, { assigneeRef: 'node-8' });
    expect(refOnly).toEqual({ status: 400, body: { error: 'assigneeKind is required with assigneeRef' } });
    const cleared = await send('PATCH', `/api/tasks/${a.id}`, { assigneeRef: null });
    expect(cleared.body).toMatchObject({ assigneeKind: null, assigneeRef: null });
  });
});

describe('comments', () => {
  test('comments round-trip oldest first', async () => {
    const task = await create({ title: 'discuss' });
    const first = await send('POST', `/api/tasks/${task.id}/comments`, { body: 'first' });
    expect(first.body).toMatchObject({ taskId: task.id, authorKind: 'user', authorRef: aliceId, body: 'first' });
    await send('POST', `/api/tasks/${task.id}/comments`, { body: 'second' });
    const list = await send('GET', `/api/tasks/${task.id}/comments`);
    expect(list.body).toMatchObject({ truncated: false });
    expect(list.body.comments.map((c: any) => c.body)).toEqual(['first', 'second']);
    const empty = await send('POST', `/api/tasks/${task.id}/comments`, { body: '' });
    expect(empty.status).toBe(422);
  });

  test('a long thread returns the newest comments, oldest first, and says it was truncated', async () => {
    const task = await create({ title: 'chatty' });
    for (const body of ['one', 'two', 'three']) await send('POST', `/api/tasks/${task.id}/comments`, { body });
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const { principalFromUser } = await import('@/security/principal');
    const thread = await scopedRepos(principalFromUser({ id: aliceId, username: 'alice', isAdmin: false })).tasks.listComments(task.id, 2);
    expect(thread?.truncated).toBe(true);
    expect(thread?.comments.map((c) => c.body)).toEqual(['two', 'three']);
  });
});
