/**
 * Unit tests for the tasks tool. Verifies create/list/complete operate only on
 * the calling user's tasks (scoped principal built from context.userId) and that
 * the permission contract is read=ALLOW / write=ASK.
 *
 * Invocations use role:'general' (an autonomous worker) so the base-tool
 * permission gate is skipped exactly as it is for root agent-spawned workers
 * in production — the realistic agent path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext, ToolManifest } from '@/core/types';
import type { ToolHandler } from '@/core/agent-worker';
import { TasksTool } from './index';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let tool: TasksTool;
let handlers: Map<string, ToolHandler>;

function ctx(userId: string): AgentContext {
  return {
    id: 'agent-1',
    sessionId: 'sess-1',
    userId,
    role: 'general', // autonomous worker → permission gate skipped
    topic: 'general',
    model: 'test',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  } as AgentContext;
}

const call = (name: string, args: Record<string, unknown>, userId: string) =>
  handlers.get(name)!.execute(args, ctx(userId)) as Promise<any>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tasks-tool-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false), ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );

  tool = new TasksTool();
  await tool.initialize();
  handlers = (tool as unknown as { tools: Map<string, ToolHandler> }).tools;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('manifest permission contract', () => {
  test('read is ALLOW, write is ASK', () => {
    const m: ToolManifest = tool.getManifest();
    expect(m.permissions.find((p) => p.action === 'read')?.defaultLevel).toBe('ALLOW');
    expect(m.permissions.find((p) => p.action === 'write')?.defaultLevel).toBe('ASK');
  });
});

describe('scoped create / list / complete', () => {
  test('a created task is owned by the caller and listed only for them', async () => {
    const created = await call('create_task', { title: 'alice writes a memo', priority: 2 }, aliceId);
    expect(created.created).toBe(true);
    expect(created.task.source).toBe('agent');

    await call('create_task', { title: 'bob buys milk' }, bobId);

    const aliceList = await call('list_tasks', {}, aliceId);
    const titles = aliceList.tasks.map((t: any) => t.title);
    expect(titles).toContain('alice writes a memo');
    expect(titles).not.toContain('bob buys milk');
  });

  test('complete sets status done; caller cannot complete another user\'s task', async () => {
    const created = await call('create_task', { title: 'finish report' }, aliceId);
    const done = await call('complete_task', { id: created.task.id }, aliceId);
    expect(done.completed).toBe(true);
    expect(done.task.status).toBe('done');
    expect(done.task.completedAt).not.toBeNull();

    // Bob tries to complete alice's task → scoped repo returns null → "not found".
    const cross = await call('complete_task', { id: created.task.id }, bobId);
    expect(cross).toEqual({ error: 'Task not found' });
  });

  test('list dueToday filters by due date', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await call('create_task', { title: 'overdue thing', dueAt: past }, aliceId);
    const due = await call('list_tasks', { dueToday: true }, aliceId);
    expect(due.tasks.some((t: any) => t.title === 'overdue thing')).toBe(true);
    // A task with no due date is excluded from the due-today view.
    expect(due.tasks.some((t: any) => t.title === 'alice writes a memo')).toBe(false);
  });

  test('category: create stores it, list filters by it (and "none" → uncategorized)', async () => {
    const milk = await call('create_task', { title: 'buy milk', category: 'Shopping' }, aliceId);
    expect(milk.task.category).toBe('Shopping');
    await call('create_task', { title: 'wax the car', category: 'Car' }, aliceId);

    const shopping = await call('list_tasks', { category: 'Shopping' }, aliceId);
    const shoppingTitles = shopping.tasks.map((t: any) => t.title);
    expect(shoppingTitles).toContain('buy milk');
    expect(shoppingTitles).not.toContain('wax the car');

    // 'none' selects uncategorized tasks (e.g. the earlier 'alice writes a memo').
    const uncategorized = await call('list_tasks', { category: 'none' }, aliceId);
    expect(uncategorized.tasks.every((t: any) => t.category == null)).toBe(true);
    expect(uncategorized.tasks.some((t: any) => t.title === 'buy milk')).toBe(false);
  });

  test('category: update sets and clears it (empty string → null)', async () => {
    const t = await call('create_task', { title: 'fix the fence' }, aliceId);
    expect(t.task.category).toBeNull();
    const tagged = await call('update_task', { id: t.task.id, category: 'House work' }, aliceId);
    expect(tagged.task.category).toBe('House work');
    const cleared = await call('update_task', { id: t.task.id, category: '' }, aliceId);
    expect(cleared.task.category).toBeNull();
  });

  test('update_task can both set AND clear dueAt (empty string clears)', async () => {
    const t = await call('create_task', { title: 'renew passport' }, aliceId);
    const when = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const set = await call('update_task', { id: t.task.id, dueAt: when }, aliceId);
    expect(set.task.dueAt).not.toBeNull();
    const cleared = await call('update_task', { id: t.task.id, dueAt: '' }, aliceId);
    expect(cleared.task.dueAt).toBeNull();
  });
});

describe('structure: add_tasks, nesting, waiting', () => {
  test('add_tasks writes a plan as phases with sub-tasks, estimates and dependencies', async () => {
    const r = await call(
      'add_tasks',
      {
        items: [
          {
            title: 'Phase 1: auth',
            category: 'Auth',
            estimate: 'L',
            children: [{ title: 'Login form', estimate: 'S' }, { title: 'Session cookie', estimate: 'M', blockedBy: ['Login form'] }],
          },
          { title: 'Phase 2: billing', children: [{ title: 'Stripe checkout', blockedBy: ['#3'] }] },
        ],
      },
      aliceId,
    );
    expect(r.error).toBeUndefined();
    expect(r.added).toBe(5);
    const byTitle = new Map<string, any>(r.tasks.map((t: any) => [t.title, t]));
    const auth = byTitle.get('Phase 1: auth');
    const login = byTitle.get('Login form');
    const cookie = byTitle.get('Session cookie');
    const stripe = byTitle.get('Stripe checkout');
    expect(login.parentId).toBe(auth.id);
    expect(login.category).toBe('Auth');
    expect(cookie.blockedBy).toEqual([login.id]);
    expect(stripe.blockedBy).toEqual([cookie.id]);
    expect(stripe.parentId).toBe(byTitle.get('Phase 2: billing').id);
    expect(auth.estimate).toBe('L');
    expect(auth.source).toBe('agent');

    // list_tasks nests the children and says what each is waiting on.
    const listed = await call('list_tasks', { category: 'Auth' }, aliceId);
    const phase = listed.tasks.find((t: any) => t.id === auth.id);
    expect(phase.children.map((c: any) => c.title)).toEqual(['Login form', 'Session cookie']);
    expect(phase.waiting).toBe('2 sub-tasks open');
    expect(phase.children[0].waiting).toBeNull();
    expect(phase.children[1].waiting).toBe('blocked by "Login form"');

    // Completing the blocker frees the blocked task without touching its blockedBy list.
    await call('complete_task', { id: login.id }, aliceId);
    const again = await call('list_tasks', { category: 'Auth' }, aliceId);
    const cookieRow = again.tasks.find((t: any) => t.id === auth.id).children.find((c: any) => c.id === cookie.id);
    expect(cookieRow.waiting).toBeNull();
    expect(cookieRow.blockedBy).toEqual([login.id]);
  });

  test('add_tasks refuses an unresolvable dependency and writes nothing', async () => {
    const before = await call('list_tasks', { status: 'all' }, aliceId);
    const r = await call('add_tasks', { items: [{ title: 'orphan dep', blockedBy: ['does not exist'] }] }, aliceId);
    expect(r.error).toContain('is blocked by "does not exist"');
    const after = await call('list_tasks', { status: 'all' }, aliceId);
    expect(after.tasks.length).toBe(before.tasks.length);
  });

  test('a blocker or parent belonging to another user is refused', async () => {
    const bobs = await call('create_task', { title: 'bob private' }, bobId);
    const asParent = await call('create_task', { title: 'x', parentId: bobs.task.id }, aliceId);
    expect(asParent).toEqual({ error: 'Parent task not found' });
    const viaBacklog = await call('add_tasks', { items: [{ title: 'y', blockedBy: [bobs.task.id] }] }, aliceId);
    expect(viaBacklog).toEqual({ error: `Blocking task not found: ${bobs.task.id}` });
  });

  test('list_tasks defaults to active tasks; status "all" includes done; in_progress ranks first in view next', async () => {
    const t = await call('create_task', { title: 'started thing' }, aliceId);
    const started = await call('update_task', { id: t.task.id, status: 'in_progress' }, aliceId);
    expect(started.task.status).toBe('in_progress');
    const done = await call('create_task', { title: 'finished thing' }, aliceId);
    await call('complete_task', { id: done.task.id }, aliceId);

    const active = await call('list_tasks', {}, aliceId);
    const activeTitles = active.tasks.map((x: any) => x.title);
    expect(activeTitles).toContain('started thing');
    expect(activeTitles).not.toContain('finished thing');
    const all = await call('list_tasks', { status: 'all' }, aliceId);
    expect(all.tasks.map((x: any) => x.title)).toContain('finished thing');

    const next = await call('list_tasks', { view: 'next', limit: 50 }, aliceId);
    expect(next.tasks[0]).toMatchObject({ title: 'started thing', bucket: 'doing', reason: 'in progress' });
  });
});
