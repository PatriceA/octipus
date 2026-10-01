/**
 * Work taken up in a group channel (phase 2): the task on the member's own
 * board, linked to their thread session; one task per member and message;
 * only that thread's open tasks can be closed by the thread's agent.
 * Against embedded Postgres.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const annaId = 'bbbbbbbb-0000-4000-8000-000000000001';
const bobId = 'bbbbbbbb-0000-4000-8000-000000000002';
const threadA = 'bbbbbbbb-1111-4000-8000-000000000001';
const threadB = 'bbbbbbbb-1111-4000-8000-000000000002';

let tt: typeof import('./taken-tasks');
let executeRaw: (sql: string) => Promise<unknown>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-taken-tasks-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  executeRaw = db.executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin, is_active) VALUES
    ('${annaId}', 'anna', false, true), ('${bobId}', 'bob', false, true)`);
  tt = await import('./taken-tasks');
});

beforeEach(async () => {
  await executeRaw('DELETE FROM tasks');
});

const take = (userId: string, sessionId: string, text: string, messageKey = `C1:${rand(4)}`, author?: string) =>
  tt.takeChannelTask({
    userId, workspaceId: null, sessionId, requester: userId === annaId ? 'Anna Schmidt' : 'Bob',
    where: '#release', request: { text, messageKey, author, url: 'https://x.slack.com/archives/C1/p1' },
  });

describe('taking work', () => {
  test('a task on the member\'s own board, in progress, linked to their thread session', async () => {
    const { task, created } = await take(annaId, threadA, 'draft the release notes for 0.6.1\nwith the migration notes');
    expect(created).toBe(true);
    expect(task).toMatchObject({
      userId: annaId, title: 'Draft the release notes for 0.6.1', status: 'in_progress', source: 'channel',
      sourceRef: { sessionId: threadA, label: '#release' },
    });
    expect(task.notes).toContain('Taken on in #release for Anna Schmidt');
    expect(task.notes).toContain('with the migration notes');
  });

  test('taking the same message twice gives the first task; another member gets their own', async () => {
    const first = await take(annaId, threadA, 'fix the flaky test', 'C1:100.1', 'Bob');
    const again = await take(annaId, threadA, 'fix the flaky test', 'C1:100.1', 'Bob');
    expect(again).toMatchObject({ created: false, task: { id: first.task.id } });
    const bobs = await take(bobId, threadB, 'fix the flaky test', 'C1:100.1', 'Bob');
    expect(bobs.created).toBe(true);
    expect(bobs.task.userId).toBe(bobId);
    expect(first.task.notes).toContain("From Bob's message:");
  });

  test('open tasks are per member and thread session; closed ones drop out', async () => {
    const a = await take(annaId, threadA, 'one');
    await take(annaId, threadB, 'two');
    await take(bobId, threadA, 'three');
    expect((await tt.openTakenTasks(annaId, threadA)).map((t) => t.id)).toEqual([a.task.id]);
    await executeRaw(`UPDATE tasks SET status = 'done' WHERE id = '${a.task.id}'`);
    expect(await tt.openTakenTasks(annaId, threadA)).toEqual([]);
  });
});

describe('finishing taken work', () => {
  test('closes the task with the result as a board comment', async () => {
    const { task } = await take(annaId, threadA, 'draft the notes');
    const done = await tt.completeTakenTask({ userId: annaId, sessionId: threadA, taskId: task.id, result: 'Posted the draft in the thread.', agentId: 'agent-1' });
    expect(done).toEqual({ ok: true, title: 'Draft the notes' });
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const { backgroundUserPrincipal } = await import('@/core/tasks/sourced');
    const repo = scopedRepos(backgroundUserPrincipal(annaId)).tasks;
    expect(await repo.findById(task.id)).toMatchObject({ status: 'done' });
    expect((await repo.listComments(task.id))?.comments.map((c) => c.body)).toEqual(['Posted the draft in the thread.']);
  });

  test("cannot close a task taken in another thread, or another member's", async () => {
    const elsewhere = await take(annaId, threadB, 'other thread');
    const bobs = await take(bobId, threadA, 'bob\'s');
    for (const taskId of [elsewhere.task.id, bobs.task.id]) {
      const r = await tt.completeTakenTask({ userId: annaId, sessionId: threadA, taskId, result: 'x', agentId: 'a' });
      expect(r.ok).toBe(false);
    }
  });

  test('the turn context lists open tasks with their newest board comments', async () => {
    const { task } = await take(annaId, threadA, 'draft the notes');
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const { backgroundUserPrincipal } = await import('@/core/tasks/sourced');
    await scopedRepos(backgroundUserPrincipal(annaId)).tasks.addComment(task.id, { authorKind: 'user', authorRef: annaId, body: 'use the milestone list' });
    const block = await tt.takenTasksContext(await tt.openTakenTasks(annaId, threadA));
    expect(block).toContain(task.id);
    expect(block).toContain('"Draft the notes" (in progress)');
    expect(block).toContain('board comment by the requester');
    expect(block).toContain('use the milestone list');
    expect(block).toContain('complete_taken_task');
    expect(await tt.takenTasksContext([])).toBe('');
  });
});

describe('closing a taken task, by any route', () => {
  test('tells the close listeners once, with the closed row', async () => {
    const { onTaskClosed, flushWakeups } = await import('@/core/tasks/wakeups');
    const seen: Array<{ id: string; status: string; cause: string }> = [];
    const stop = onTaskClosed(({ task, cause }) => { seen.push({ id: task.id, status: task.status, cause }); });
    try {
      const done = await take(annaId, threadA, 'by the agent');
      await tt.completeTakenTask({ userId: annaId, sessionId: threadA, taskId: done.task.id, result: 'ok', agentId: 'a' });
      const { scopedRepos } = await import('@/db/repositories/scoped');
      const { backgroundUserPrincipal } = await import('@/core/tasks/sourced');
      const repo = scopedRepos(backgroundUserPrincipal(annaId)).tasks;
      const archived = await take(annaId, threadA, 'on the board');
      await repo.update(archived.task.id, { status: 'archived' });
      const deleted = await take(annaId, threadA, 'deleted');
      await repo.delete(deleted.task.id);
      await repo.update(done.task.id, { status: 'done' }); // already closed: nothing new
      await flushWakeups();
      expect(seen).toEqual([
        { id: done.task.id, status: 'done', cause: 'closed' },
        { id: archived.task.id, status: 'archived', cause: 'closed' },
        { id: deleted.task.id, status: 'in_progress', cause: 'deleted' },
      ]);
    } finally {
      stop();
    }
  });
});
