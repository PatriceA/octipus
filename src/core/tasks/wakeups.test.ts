import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { computeWakeups, dispatchWakeups, emitSafely, flushWakeups, onTaskWakeup, type TaskWakeupEvent, type WakeupTask } from './wakeups';

const t = (id: string, status: string, extra: Partial<WakeupTask> = {}): WakeupTask => ({ id, title: id.toUpperCase(), status, ...extra });
const ids = (rows: WakeupTask[]) => rows.map((r) => r.id);

describe('computeWakeups', () => {
  test('the single blocker resolved wakes the dependent', () => {
    const closed = t('a', 'done');
    const r = computeWakeups(closed, 'open', [t('a', 'open'), t('b', 'open', { blockedBy: ['a'] })]);
    expect(ids(r.unblocked)).toEqual(['b']);
    expect(r.childrenCompleted).toBeNull();
  });

  test('one of two blockers resolved wakes nobody; the last one does', () => {
    const rows = [t('a', 'open'), t('c', 'in_progress'), t('b', 'open', { blockedBy: ['a', 'c'] })];
    expect(computeWakeups(t('a', 'done'), 'open', rows).unblocked).toEqual([]);
    const later = [t('a', 'done'), t('c', 'in_progress'), t('b', 'open', { blockedBy: ['a', 'c'] })];
    expect(ids(computeWakeups(t('c', 'done'), 'in_progress', later).unblocked)).toEqual(['b']);
  });

  test('a closed dependent is not woken', () => {
    const r = computeWakeups(t('a', 'done'), 'open', [t('b', 'done', { blockedBy: ['a'] })]);
    expect(r.unblocked).toEqual([]);
  });

  test('the last child closed wakes the parent; an open sibling holds it', () => {
    const rows = [t('p', 'open'), t('c1', 'done', { parentId: 'p' }), t('c2', 'open', { parentId: 'p' })];
    expect(computeWakeups(t('c2', 'done', { parentId: 'p' }), 'open', rows).childrenCompleted?.id).toBe('p');
    const withOpenSibling = [...rows, t('c3', 'in_progress', { parentId: 'p' })];
    expect(computeWakeups(t('c2', 'done', { parentId: 'p' }), 'open', withOpenSibling).childrenCompleted).toBeNull();
  });

  test('a closed parent is not woken', () => {
    const r = computeWakeups(t('c', 'done', { parentId: 'p' }), 'open', [t('p', 'archived')]);
    expect(r.childrenCompleted).toBeNull();
  });

  test('archived counts as closed, for the closed task and for other blockers', () => {
    const rows = [t('x', 'archived', { updatedAt: new Date(1) }), t('b', 'open', { blockedBy: ['a', 'x'] }), t('p', 'open')];
    const r = computeWakeups(t('a', 'archived', { parentId: 'p', updatedAt: new Date(2) }), 'open', rows);
    expect(ids(r.unblocked)).toEqual(['b']);
    expect(r.childrenCompleted?.id).toBe('p');
  });

  test('sibling closes read after both writes: only the latest by (updatedAt, id) fires', () => {
    // D blocked by A and B; P's last two children C1 and C2. All four closed before either wakeup reads.
    const at = new Date(1000);
    const a = t('a', 'done', { updatedAt: new Date(1) });
    const b = t('b', 'archived', { updatedAt: new Date(2) });
    const c1 = t('c1', 'done', { parentId: 'p', updatedAt: at });
    const c2 = t('c2', 'done', { parentId: 'p', updatedAt: at }); // same instant: id breaks the tie
    const rows = [a, b, c1, c2, t('d', 'open', { blockedBy: ['a', 'b'] }), t('p', 'open')];
    const woken = (closed: WakeupTask) => {
      const r = computeWakeups(closed, 'open', rows);
      return [...ids(r.unblocked), ...(r.childrenCompleted ? [r.childrenCompleted.id] : [])];
    };
    expect(woken(a)).toEqual([]);
    expect(woken(b)).toEqual(['d']);
    expect(woken(c1)).toEqual([]);
    expect(woken(c2)).toEqual(['p']);
  });

  test('an unknown (unreadable) blocker still blocks; a deleted one (absent) does not', () => {
    const rows = [t('b', 'open', { blockedBy: ['a', 'foreign'] })];
    expect(computeWakeups(t('a', 'done'), 'open', rows, ['foreign']).unblocked).toEqual([]);
    expect(ids(computeWakeups(t('a', 'done'), 'open', rows).unblocked)).toEqual(['b']);
  });

  test('a deleted task (non-active status) wakes like a closed one', () => {
    const r = computeWakeups(t('a', 'deleted', { parentId: 'p' }), 'in_progress', [t('b', 'open', { blockedBy: ['a'] }), t('p', 'open')]);
    expect(ids(r.unblocked)).toEqual(['b']);
    expect(r.childrenCompleted?.id).toBe('p');
  });

  test('no double fire: a task already closed (or still active) wakes nobody', () => {
    const rows = [t('b', 'open', { blockedBy: ['a'] }), t('p', 'open')];
    const closed = t('a', 'archived', { parentId: 'p' });
    expect(computeWakeups(closed, 'done', rows)).toEqual({ unblocked: [], childrenCompleted: null });
    expect(computeWakeups(t('a', 'in_progress', { parentId: 'p' }), 'open', rows)).toEqual({ unblocked: [], childrenCompleted: null });
  });
});

describe('emitSafely', () => {
  test('a throwing or rejecting listener is logged and the others still run', async () => {
    const seen: string[] = [];
    const offs = [
      onTaskWakeup(() => {
        throw new Error('sync boom');
      }),
      onTaskWakeup(async () => {
        throw new Error('async boom');
      }),
      onTaskWakeup((e) => {
        seen.push(e.taskId);
      }),
    ];
    const event: TaskWakeupEvent = { type: 'task.unblocked', userId: 'u', workspaceId: null, taskId: 't1', title: 'T', triggeredBy: 'x', cause: 'closed' };
    expect(() => emitSafely(event)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run here
    expect(seen).toEqual(['t1']);
    for (const off of offs) off();
  });
});

// ── Embedded PGlite: the task routes drive the wakeup end to end ─────────

type ElysiaLike = { handle: (req: Request) => Promise<Response> };
const rand = (n: number) => randomBytes(n).toString('hex');

describe('wakeups via /api/tasks (embedded PGlite)', () => {
  const aliceId = '31111111-1111-1111-1111-111111111111';
  const bobId = '32222222-2222-2222-2222-222222222222';
  const ws1 = '41111111-1111-1111-1111-111111111111';
  const ws2 = '42222222-2222-2222-2222-222222222222';
  let aliceApp: ElysiaLike;
  let queryRaw: (sql: string) => Promise<{ rows: any[] }>;
  const events: TaskWakeupEvent[] = [];
  let off: () => void;

  beforeAll(async () => {
    process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
    process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
    process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
    process.env.LOG_LEVEL ??= 'error';
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-task-wakeups-'));

    const db = await import('@/db/postgres');
    await db.initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    queryRaw = db.queryRaw as typeof queryRaw;
    await db.executeRaw(
      `INSERT INTO users (id, username, is_admin) VALUES ('${aliceId}', 'alice-w', false), ('${bobId}', 'bob-w', false)
       ON CONFLICT DO NOTHING`,
    );
    await db.executeRaw(
      `INSERT INTO workspaces (id, user_id, slug, name, files_dir) VALUES
         ('${ws1}', '${aliceId}', 'one', 'One', '${ws1}'), ('${ws2}', '${aliceId}', 'two', 'Two', '${ws2}')`,
    );

    const { taskRoutes } = await import('@/api/routes/tasks');
    const { Elysia } = await import('@/api/http');
    const { principalFromUser } = await import('@/security/principal');
    const u = { id: aliceId, username: 'alice-w', isAdmin: false };
    aliceApp = new Elysia()
      .derive(() => ({ user: u, session: null, principal: principalFromUser(u) }))
      .group('/api', (a) => a.use(taskRoutes)) as unknown as ElysiaLike;
    off = onTaskWakeup((e) => {
      events.push(e);
    });
  });

  afterAll(async () => {
    off?.();
    await flushWakeups();
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    await flushWakeups();
    events.length = 0;
  });

  async function insertTask(userId: string, title: string, extra = ''): Promise<string> {
    const cols = extra ? `, ${extra.split('=')[0]}` : '';
    const vals = extra ? `, ${extra.slice(extra.indexOf('=') + 1)}` : '';
    const { rows } = await queryRaw(`INSERT INTO tasks (user_id, title${cols}) VALUES ('${userId}', '${title}'${vals}) RETURNING id`);
    return rows[0].id;
  }
  async function send(method: string, id: string, body?: unknown) {
    const res = await aliceApp.handle(new Request(`http://localhost/api/tasks/${id}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const out = { status: res.status, body: await res.json() };
    await flushWakeups();
    return out;
  }
  const patch = (id: string, body: unknown) => send('PATCH', id, body);
  const notesFor = async (userId: string) =>
    (await queryRaw(`SELECT type, title, metadata FROM notifications WHERE user_id = '${userId}' ORDER BY created_at`)).rows;

  test('completing a blocker emits task.unblocked and files one notification; bob is never touched', async () => {
    const blocker = await insertTask(aliceId, 'Write spec');
    const dependent = await insertTask(aliceId, 'Build it', `blocked_by=ARRAY['${blocker}']::uuid[]`);
    // Bob's row points at alice's blocker (only possible by raw SQL): it must not be woken.
    const bobTask = await insertTask(bobId, 'Bob waits', `blocked_by=ARRAY['${blocker}']::uuid[]`);

    const r = await patch(blocker, { status: 'done' });
    expect(r.status).toBe(200);
    expect(events).toEqual([
      { type: 'task.unblocked', userId: aliceId, workspaceId: null, taskId: dependent, title: 'Build it', triggeredBy: blocker, cause: 'closed' },
    ]);
    expect(events.some((e) => e.taskId === bobTask)).toBe(false);

    const notes = await notesFor(aliceId);
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('task_unblocked');
    expect(notes[0].title).toBe('“Build it” is unblocked');
    expect(notes[0].metadata).toMatchObject({ taskId: dependent, triggeredBy: blocker });
    expect(await notesFor(bobId)).toHaveLength(0);
    const bobRow = (await queryRaw(`SELECT status FROM tasks WHERE id = '${bobTask}'`)).rows[0];
    expect(bobRow.status).toBe('open');

    // Re-closing (done → archived) is not a transition from active: no second fire.
    await patch(blocker, { status: 'archived' });
    expect(events).toHaveLength(1);
  });

  test('archiving the last open child wakes the parent once', async () => {
    const parent = await insertTask(aliceId, 'Phase 1');
    const c1 = await insertTask(aliceId, 'Step A', `parent_id='${parent}'`);
    const c2 = await insertTask(aliceId, 'Step B', `parent_id='${parent}'`);

    await patch(c1, { status: 'done' });
    expect(events).toEqual([]);
    await patch(c2, { status: 'archived' });
    expect(events.map((e) => [e.type, e.taskId, e.triggeredBy])).toEqual([['task.children_completed', parent, c2]]);
    const notes = (await notesFor(aliceId)).filter((n: any) => n.metadata.taskId === parent);
    expect(notes.map((n: any) => n.title)).toEqual(['All sub-tasks of “Phase 1” are done']);
  });

  test('an open blocker outside the workspace scope, or another user’s, still blocks', async () => {
    const { ScopedTaskRepo } = await import('@/db/repositories/scoped');
    const { principalFromUser } = await import('@/security/principal');
    const inWs1 = new ScopedTaskRepo({ ...principalFromUser({ id: aliceId, username: 'alice-w', isAdmin: false }), workspaceId: ws1 });
    const a = await insertTask(aliceId, 'A in ws1', `workspace_id='${ws1}'`);
    const other = await insertTask(aliceId, 'Other in ws2', `workspace_id='${ws2}'`);
    const bobs = await insertTask(bobId, 'Bob open');
    const d1 = await insertTask(aliceId, 'Needs A and ws2', `blocked_by=ARRAY['${a}','${other}']::uuid[]`);
    const d2 = await insertTask(aliceId, 'Needs A and bob', `blocked_by=ARRAY['${a}','${bobs}']::uuid[]`);
    const d3 = await insertTask(aliceId, 'Needs A only', `blocked_by=ARRAY['${a}']::uuid[]`);

    expect((await inWs1.update(a, { status: 'done' }))?.status).toBe('done');
    await flushWakeups();
    expect(events.map((e) => e.taskId)).toEqual([d3]);
    expect(events.some((e) => e.taskId === d1 || e.taskId === d2)).toBe(false);
  });

  test('deleting the last active blocker wakes the dependent', async () => {
    const b1 = await insertTask(aliceId, 'Old blocker', `status='done'`);
    const b2 = await insertTask(aliceId, 'Doomed blocker');
    const dep = await insertTask(aliceId, 'Waiting on two', `blocked_by=ARRAY['${b1}','${b2}']::uuid[]`);
    const r = await send('DELETE', b2);
    expect(r.body).toEqual({ deleted: true });
    expect(events.map((e) => [e.type, e.taskId, e.cause])).toEqual([['task.unblocked', dep, 'deleted']]);
  });

  test('an empty status is rejected, not treated as unchanged', async () => {
    const id = await insertTask(aliceId, 'x');
    const r = await patch(id, { status: '' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid status ""' });
  });

  test('concurrent closes of one blocker fire once', async () => {
    const blocker = await insertTask(aliceId, 'Raced', `status='in_progress'`);
    const dep = await insertTask(aliceId, 'After race', `blocked_by=ARRAY['${blocker}']::uuid[]`);
    const results = await Promise.all([
      patch(blocker, { status: 'done' }),
      patch(blocker, { status: 'done' }),
      patch(blocker, { status: 'archived' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(events.filter((e) => e.taskId === dep)).toHaveLength(1);
    const notes = (await notesFor(aliceId)).filter((n: any) => n.metadata.taskId === dep);
    expect(notes).toHaveLength(1);
  });

  test('two blockers (and the last two children) closed before either wakeup reads: one event each', async () => {
    const { ScopedTaskRepo } = await import('@/db/repositories/scoped');
    const { principalFromUser } = await import('@/security/principal');
    const repo = new ScopedTaskRepo(principalFromUser({ id: aliceId, username: 'alice-w', isAdmin: false }));
    const a = await insertTask(aliceId, 'Blocker A');
    const b = await insertTask(aliceId, 'Blocker B');
    const d = await insertTask(aliceId, 'Needs A and B', `blocked_by=ARRAY['${a}','${b}']::uuid[]`);
    const p = await insertTask(aliceId, 'Phase X');
    const c1 = await insertTask(aliceId, 'Child 1', `parent_id='${p}'`);
    const c2 = await insertTask(aliceId, 'Child 2', `parent_id='${p}'`);

    // Both writes first (raw SQL, so no wakeup is scheduled), then both wakeups.
    for (const id of [a, b, c1, c2]) await queryRaw(`UPDATE tasks SET status = 'done', updated_at = now() WHERE id = '${id}'`);
    for (const id of [a, b, c1, c2]) {
      const closed = (await repo.findById(id))!;
      await dispatchWakeups({ closed, previousStatus: 'open', cause: 'closed', ...(await repo.wakeupContext(closed)) });
    }
    expect(events.filter((e) => e.taskId === d)).toHaveLength(1);
    expect(events.filter((e) => e.taskId === p)).toHaveLength(1);
    expect(events.map((e) => e.type).sort()).toEqual(['task.children_completed', 'task.unblocked']);
  });

  test('an async listener rejection is caught and does not fail the close', async () => {
    const rejecting = vi.fn(async () => {
      throw new Error('listener down');
    });
    const stop = onTaskWakeup(rejecting);
    try {
      const blocker = await insertTask(aliceId, 'Blocker L');
      const dep = await insertTask(aliceId, 'Dep L', `blocked_by=ARRAY['${blocker}']::uuid[]`);
      const r = await patch(blocker, { status: 'done' });
      expect(r.status).toBe(200);
      expect(rejecting).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.taskId)).toEqual([dep]);
      await new Promise((res) => setTimeout(res, 0));
    } finally {
      stop();
    }
  });
});
