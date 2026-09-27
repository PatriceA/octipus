import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { StructuredTask } from './structure';
import { computeWakeups, onTaskWakeup, resetWakeupCoalescing, type TaskWakeupEvent } from './wakeups';

const t = (id: string, status: string, extra: Partial<StructuredTask> = {}): StructuredTask => ({ id, title: id.toUpperCase(), status, ...extra });
const ids = (rows: StructuredTask[]) => rows.map((r) => r.id);

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
    expect(ids([computeWakeups(t('c2', 'done', { parentId: 'p' }), 'open', rows).childrenCompleted!])).toEqual(['p']);
    const withOpenSibling = [...rows, t('c3', 'in_progress', { parentId: 'p' })];
    expect(computeWakeups(t('c2', 'done', { parentId: 'p' }), 'open', withOpenSibling).childrenCompleted).toBeNull();
  });

  test('a closed parent is not woken', () => {
    const r = computeWakeups(t('c', 'done', { parentId: 'p' }), 'open', [t('p', 'archived')]);
    expect(r.childrenCompleted).toBeNull();
  });

  test('archived counts as closed, for the closed task and for other blockers', () => {
    const rows = [t('x', 'archived'), t('b', 'open', { blockedBy: ['a', 'x'] }), t('p', 'open')];
    const r = computeWakeups(t('a', 'archived', { parentId: 'p' }), 'open', rows);
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

// ── Embedded PGlite: the PATCH route drives the wakeup end to end ─────────

type ElysiaLike = { handle: (req: Request) => Promise<Response> };
const rand = (n: number) => randomBytes(n).toString('hex');

describe('wakeups via PATCH /api/tasks/:id (embedded PGlite)', () => {
  const aliceId = '31111111-1111-1111-1111-111111111111';
  const bobId = '32222222-2222-2222-2222-222222222222';
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

    const { taskRoutes } = await import('@/api/routes/tasks');
    const { Elysia } = await import('@/api/http');
    const { principalFromUser } = await import('@/security/principal');
    const u = { id: aliceId, username: 'alice-w', isAdmin: false };
    aliceApp = new Elysia()
      .derive(() => ({ user: u, session: null, principal: principalFromUser(u) }))
      .group('/api', (a) => a.use(taskRoutes)) as unknown as ElysiaLike;
    off = onTaskWakeup((e) => events.push(e));
  });

  afterAll(async () => {
    off?.();
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(() => {
    events.length = 0;
    resetWakeupCoalescing();
  });

  async function insertTask(userId: string, title: string, extra = ''): Promise<string> {
    const cols = extra ? `, ${extra.split('=')[0]}` : '';
    const vals = extra ? `, ${extra.slice(extra.indexOf('=') + 1)}` : '';
    const { rows } = await queryRaw(`INSERT INTO tasks (user_id, title${cols}) VALUES ('${userId}', '${title}'${vals}) RETURNING id`);
    return rows[0].id;
  }
  async function patch(id: string, body: unknown) {
    const res = await aliceApp.handle(new Request(`http://localhost/api/tasks/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  }
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
      { type: 'task.unblocked', userId: aliceId, workspaceId: null, taskId: dependent, title: 'Build it', triggeredBy: blocker },
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
});
