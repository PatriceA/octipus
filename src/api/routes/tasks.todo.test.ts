/**
 * The personal to-do layer (migration 0209) end to end on embedded Postgres:
 * the API's new fields (star, manual order, My Day, repeat), capture through
 * `quick` and `/parse`, My Day's daily rollover and suggestions, a repeating
 * to-do's next occurrence (exactly once, by the user, the API or an agent's
 * tasks tool), `/todo`, and the `tasks.changed` event the list refetches on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import type { ToolHandler } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';

const publishEvent = vi.hoisted(() => vi.fn());
vi.mock('@/core/gateway/hub', () => ({ getGatewayHub: () => ({ publishEvent }) }));

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = randomUUID();
const bobId = randomUUID();
const apps: Record<string, ElysiaLike> = {};
let executeRaw: (sql: string) => Promise<unknown>;
let queryRaw: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
let tools: Map<string, ToolHandler>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tasks-todo-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  executeRaw = db.executeRaw as typeof executeRaw;
  queryRaw = db.queryRaw as typeof queryRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }, { id: bobId, username: 'bob' }]);

  const { taskRoutes } = await import('./tasks');
  const { principalFromUser } = await import('@/security/principal');
  for (const [name, id] of [['alice', aliceId], ['bob', bobId]] as const) {
    apps[name] = new Elysia()
      .derive(() => {
        const u = { id, username: name, isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(taskRoutes)) as unknown as ElysiaLike;
  }

  const { TasksTool } = await import('@/tools/tasks');
  const tool = new TasksTool();
  await tool.initialize();
  const { getPermissionManager } = await import('@/security/permissions');
  await getPermissionManager().setPermission(aliceId, 'tasks', 'write', 'ALLOW');
  tools = (tool as unknown as { tools: Map<string, ToolHandler> }).tools;
  await import('@/core/commands/todo');
});

afterAll(async () => {
  await (await import('@/core/tasks/wakeups')).flushWakeups();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  await executeRaw(`DELETE FROM tasks`);
  await executeRaw(`DELETE FROM task_lists`);
  // Each test starts with no stored zone (tests below set one where it matters).
  await executeRaw(`UPDATE users SET preferences = '{}'::jsonb`);
  publishEvent.mockClear();
});

async function req(method: string, path: string, body?: unknown, who: 'alice' | 'bob' = 'alice') {
  const res = await apps[who].handle(new Request(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: (await res.json()) as any };
}

const agent = (): AgentContext => ({
  id: 'agent-1', sessionId: 'sess-1', userId: aliceId, role: 'general', topic: 'general', model: 'test',
  status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
}) as AgentContext;
const tool = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, agent()) as Promise<any>;

async function rowsOf(userId: string) {
  return (await queryRaw(`SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at, title`, [userId])).rows;
}

/** Today's date in a zone, as the server computes it. */
function today(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

describe('the new fields', () => {
  test('a new to-do is not important, not in My Day, has no repeat, and sorts newest first', async () => {
    const a = await req('POST', '/api/tasks', { title: 'First' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await req('POST', '/api/tasks', { title: 'Second' });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ important: false, myDayOn: null, repeat: null, repeatNextId: null });
    expect(typeof a.body.sortOrder).toBe('number');
    expect(b.body.sortOrder).toBeLessThan(a.body.sortOrder);
  });

  test('star, manual order and My Day are set and cleared with PATCH', async () => {
    const { body: task } = await req('POST', '/api/tasks', { title: 'Order me', important: true, myDay: true, tz: 'Pacific/Kiritimati' });
    expect(task).toMatchObject({ important: true, myDayOn: today('Pacific/Kiritimati') });
    const patched = await req('PATCH', `/api/tasks/${task.id}`, { important: false, sortOrder: 12.5, myDay: false });
    expect(patched.body).toMatchObject({ important: false, sortOrder: 12.5, myDayOn: null });
    // My Day is today in the zone the client sends.
    const again = await req('PATCH', `/api/tasks/${task.id}`, { myDay: true, tz: 'Pacific/Pago_Pago' });
    expect(again.body.myDayOn).toBe(today('Pacific/Pago_Pago'));
  });

  test('a repeat is a preset or a rule; a bad one is a 400 naming the problem', async () => {
    const { body: task } = await req('POST', '/api/tasks', { title: 'Water plants', repeat: 'weekdays' });
    // The server stamps the series' zone (and for months its anchor day).
    expect(task.repeat).toEqual({ unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5], tz: expect.any(String) });
    const rule = await req('PATCH', `/api/tasks/${task.id}`, { repeat: { unit: 'month', interval: 2 } });
    expect(rule.body.repeat).toMatchObject({ unit: 'month', interval: 2, anchorDay: expect.any(Number) });
    const bad = await req('PATCH', `/api/tasks/${task.id}`, { repeat: { unit: 'fortnight' } });
    expect(bad).toMatchObject({ status: 400, body: { error: expect.stringContaining('Invalid repeat unit') } });
    const cleared = await req('PATCH', `/api/tasks/${task.id}`, { repeat: null });
    expect(cleared.body.repeat).toBeNull();
    expect((await req('POST', '/api/tasks', { title: 'x', sortOrder: 'high' })).status).toBe(422);
  });
});

describe('capture', () => {
  test('POST with quick parses the line on the server and matches an existing list', async () => {
    await req('POST', '/api/tasks', { title: 'Seed', category: 'House work' });
    const { status, body } = await req('POST', '/api/tasks', { quick: 'Mop the floor tomorrow 9am !high #house-work *', tz: 'Europe/Berlin' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ title: 'Mop the floor', priority: 3, category: 'House work', important: true });
    const due = new Date(body.dueAt);
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(due)).toBe('09:00');
    expect(today('Europe/Berlin', 1)).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(due));
  });

  test('explicit fields win over the line; a line with nothing but a title stays one', async () => {
    const { body } = await req('POST', '/api/tasks', { quick: 'Call Ana !low #work', priority: 2, category: 'Home' });
    expect(body).toMatchObject({ title: 'Call Ana', priority: 2, category: 'Home' });
    const plain = await req('POST', '/api/tasks', { quick: 'Tomorrow' });
    expect(plain.body).toMatchObject({ title: 'Tomorrow', dueAt: null });
    expect((await req('POST', '/api/tasks', {})).status).toBe(400);
  });

  test('/parse previews the line without creating anything', async () => {
    const { body } = await req('POST', '/api/tasks/parse', { text: 'Pay rent every month !! #bills', tz: 'UTC' });
    expect(body).toMatchObject({ title: 'Pay rent', priority: 2, category: 'bills', repeat: { unit: 'month', interval: 1 }, dueAt: null, timezone: 'UTC' });
    expect(body.tokens.map((t: any) => t.kind)).toEqual(['repeat', 'priority', 'list']);
    expect(await rowsOf(aliceId)).toHaveLength(0);
  });
});

describe('My Day', () => {
  test('a pick from yesterday is out of today\'s list and suggested back; pressing to-dos are suggested', async () => {
    const tz = 'Europe/Berlin';
    const { body: kept } = await req('POST', '/api/tasks', { title: 'Picked today', myDay: true, tz });
    const { body: old } = await req('POST', '/api/tasks', { title: 'Picked yesterday' });
    await executeRaw(`INSERT INTO task_user_state (task_id, user_id, my_day_on) VALUES ('${old.id}', '${aliceId}', '${today(tz, -1)}')`);
    const { body: overdue } = await req('POST', '/api/tasks', { title: 'Overdue bill', dueAt: '2020-01-01' });
    await req('POST', '/api/tasks', { title: 'Someday maybe' });
    const { body: doneToday } = await req('POST', '/api/tasks', { title: 'Done today', myDay: true, tz });
    await req('PATCH', `/api/tasks/${doneToday.id}`, { status: 'done' });
    await req('POST', '/api/tasks', { title: 'Bob picked', myDay: true, tz }, 'bob');

    const { status, body } = await req('GET', `/api/tasks/my-day?tz=${tz}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ timezone: tz, date: today(tz) });
    expect(body.tasks.map((t: any) => t.title).sort()).toEqual(['Done today', 'Picked today']);
    expect(body.suggestions.map((s: any) => [s.title, s.bucket])).toEqual([
      ['Picked yesterday', 'earlier'],
      ['Overdue bill', 'overdue'],
    ]);
    expect(body.suggestions[0].reason).toBe('in My Day yesterday');
    expect(body.suggestions[1].id).toBe(overdue.id);
    expect(kept.myDayOn).toBe(today(tz));
  });
});

describe('repeating to-dos', () => {
  test('completing one creates the next occurrence once, with its steps; done again makes no second', async () => {
    const { body: task } = await req('POST', '/api/tasks', {
      title: 'Weekly review', notes: 'Inbox zero', category: 'Work', priority: 2, important: true, repeat: 'weekly',
      dueAt: '2020-01-06', myDay: true, tz: 'UTC',
    });
    await req('POST', '/api/tasks', { title: 'Clear inbox', parentId: task.id });
    const done = await req('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    expect(done.body.status).toBe('done');
    expect(done.body.repeatNextId).toEqual(expect.any(String));
    const again = await req('PATCH', `/api/tasks/${task.id}`, { status: 'done', notes: 'edited' });
    expect(again.body.repeatNextId).toBe(done.body.repeatNextId);

    const rows = await rowsOf(aliceId);
    const next = rows.find((r) => r.id === done.body.repeatNextId);
    expect(rows.filter((r) => r.title === 'Weekly review')).toHaveLength(2);
    expect(next).toMatchObject({ status: 'open', notes: 'Inbox zero', category: 'Work', priority: 2, repeat: { unit: 'week', interval: 1, tz: 'UTC' } });
    // The star is copied per user; My Day is not.
    const [state] = (await queryRaw(`SELECT * FROM task_user_state WHERE task_id = $1`, [next.id])).rows;
    expect(state).toMatchObject({ user_id: aliceId, important: true, my_day_on: null });
    // Due a whole number of weeks after 2020-01-06 (a Monday), today or later, at the end of that day.
    const due = new Date(next.due_at);
    expect(due.getUTCDay()).toBe(1);
    expect(due.toISOString().slice(11)).toBe('23:59:59.999Z');
    expect(due.getTime()).toBeGreaterThanOrEqual(Date.now() - 86_400_000);
    expect(due.getTime() - Date.now()).toBeLessThan(8 * 86_400_000);
    const steps = rows.filter((r) => r.parent_id === next.id);
    expect(steps.map((s) => [s.title, s.status])).toEqual([['Clear inbox', 'open']]);
  });

  test('two completions racing make one next occurrence', async () => {
    const { body: task } = await req('POST', '/api/tasks', { title: 'Stretch', repeat: 'daily' });
    await Promise.all([
      req('PATCH', `/api/tasks/${task.id}`, { status: 'done' }),
      req('PATCH', `/api/tasks/${task.id}`, { status: 'done' }),
      tool('complete_task', { id: task.id }),
    ]);
    expect((await rowsOf(aliceId)).filter((r) => r.title === 'Stretch')).toHaveLength(2);
  });

  test('reopening takes back an untouched next occurrence; a touched one stays and is not doubled', async () => {
    const { body: task } = await req('POST', '/api/tasks', { title: 'Pay rent', repeat: 'monthly', dueAt: '2030-01-31' });
    const first = await req('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    const nextId = first.body.repeatNextId;
    expect((await req('GET', `/api/tasks/${nextId}`)).body.dueAt).toMatch(/^2030-02-28T/);
    // Undo: back to open, the occurrence goes away and the link clears.
    const reopened = await req('PATCH', `/api/tasks/${task.id}`, { status: 'open' });
    expect(reopened.body.repeatNextId).toBeNull();
    expect((await req('GET', `/api/tasks/${nextId}`)).status).toBe(404);

    // Complete again: a fresh occurrence, which the user then edits.
    const second = await req('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    await req('PATCH', `/api/tasks/${second.body.repeatNextId}`, { notes: 'landlord changed account' });
    await req('PATCH', `/api/tasks/${task.id}`, { status: 'open' });
    await req('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    const rows = (await rowsOf(aliceId)).filter((r) => r.title === 'Pay rent');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === second.body.repeatNextId)?.notes).toBe('landlord changed account');
  });

  test('an agent completing a repeating to-do through the tasks tool gets the next one back', async () => {
    const created = await tool('create_task', { title: 'Backup check', repeat: 'every 2 weeks', important: true });
    expect(created.task).toMatchObject({ repeat: { unit: 'week', interval: 2 }, important: true });
    const done = await tool('complete_task', { id: created.task.id });
    expect(done).toMatchObject({ completed: true, next: { title: 'Backup check', status: 'open', repeat: { unit: 'week', interval: 2 } } });
    const twice = await tool('complete_task', { id: created.task.id });
    expect(twice.next).toBeUndefined();
    expect((await rowsOf(aliceId)).filter((r) => r.title === 'Backup check')).toHaveLength(2);
    const bad = await tool('update_task', { id: created.task.id, repeat: 'hourly' });
    expect(bad.error).toMatch(/Invalid repeat/);
    const stopped = await tool('update_task', { id: created.task.id, repeat: 'none', myDay: true });
    // My Day is today in the user's zone (none stored here: UTC).
    expect(stopped.task).toMatchObject({ repeat: null, myDayOn: today('UTC') });
  });
});

describe('/todo', () => {
  test('adds a parsed to-do to the user\'s list and says what it understood', async () => {
    const { getCommand } = await import('@/core/commands/registry');
    const result = await getCommand('todo')!.execute({ sessionId: 's1', userId: aliceId, args: 'renew passport next month !high #admin' });
    expect(result.response).toMatch(/^Added to-do \*\*renew passport\*\* — due .+ · high priority · #admin\.$/);
    const [row] = await rowsOf(aliceId);
    expect(row).toMatchObject({ title: 'renew passport', priority: 3, category: 'admin', source: 'user' });
    expect(row.source_ref).toEqual({ sessionId: 's1' });
    expect((await getCommand('todo')!.execute({ sessionId: 's1', userId: aliceId, args: ' ' })).response).toMatch(/^Usage/);
  });

  test('a star (`*`) stars the to-do for the user, as the reply says', async () => {
    const { getCommand } = await import('@/core/commands/registry');
    const result = await getCommand('todo')!.execute({ sessionId: 's1', userId: aliceId, args: 'water the ferns *' });
    expect(result.response).toMatch(/important/);
    const id = (await rowsOf(aliceId)).find((r) => r.title === 'water the ferns')?.id;
    const state = await queryRaw('SELECT important FROM task_user_state WHERE task_id = $1 AND user_id = $2', [id, aliceId]);
    expect(state.rows[0]?.important).toBe(true);
  });
});

describe('tasks.changed', () => {
  test('every personal write tells the owner\'s connections, ids only', async () => {
    const { body: task } = await req('POST', '/api/tasks', { title: 'Live' });
    await req('PATCH', `/api/tasks/${task.id}`, { important: true });
    await req('DELETE', `/api/tasks/${task.id}`);
    await new Promise((r) => setTimeout(r, 20));
    const events = publishEvent.mock.calls.map(([e]) => e).filter((e) => e.type === 'tasks.changed');
    expect(events).toHaveLength(3);
    for (const e of events) expect(e).toEqual({ type: 'tasks.changed', source: 'tasks', userId: aliceId, payload: { taskId: task.id } });
  });
});

describe('review findings', () => {
  const setZone = (zone: string, source = 'device') =>
    executeRaw(`UPDATE users SET preferences = '{"timezone":"${zone}","timezoneSource":"${source}"}'::jsonb WHERE id = '${aliceId}'`);
  const zoneOf = async (id = aliceId) => (await queryRaw(`SELECT preferences FROM users WHERE id = $1`, [id])).rows[0].preferences;

  test('a future occurrence is not work: checkout refuses it, the agent view and the heartbeat probe leave it out', async () => {
    const { body: task } = await req('POST', '/api/tasks', { title: 'Water plants', repeat: 'daily', dueAt: '2099-01-01', assigneeKind: 'role', assigneeRef: 'general', tz: 'UTC' });
    const { body: now } = await req('POST', '/api/tasks', { title: 'Today\'s run', repeat: 'daily', dueAt: today('UTC'), assigneeKind: 'role', assigneeRef: 'general', tz: 'UTC' });
    // A runner claiming by itself is refused; the user's own claim is an explicit request and goes through.
    const refused = await req('POST', `/api/tasks/${task.id}/checkout`, { actor: 'runner-1' });
    expect(refused).toMatchObject({ status: 409, body: { reason: 'not_due', dueAt: expect.stringMatching(/^2099-01-01/) } });
    expect((await req('POST', `/api/tasks/${now.id}/checkout`, {})).status).toBe(200);
    await req('POST', `/api/tasks/${now.id}/release`, { force: true });
    const listed = await tool('list_tasks', { view: 'next' });
    expect(listed.tasks.map((t: any) => t.title)).toEqual(["Today's run"]);
    const { probeRoleWork } = await import('@/core/heartbeat');
    expect((await probeRoleWork(aliceId, 'general')).map((t) => t.title)).toEqual(["Today's run"]);
    // The tool's checkout says why, and what to do when the user asked for it now.
    const why = await tool('checkout_task', { id: task.id });
    expect(why).toMatchObject({ notDue: true, error: expect.stringContaining('now: true') });
    expect(await tool('checkout_task', { id: task.id, now: true })).toMatchObject({ checkedOut: true });
    await req('POST', `/api/tasks/${task.id}/release`, { force: true });
    expect((await req('POST', `/api/tasks/${task.id}/checkout`, {})).status).toBe(200);
  });

  test('a reported zone is remembered; a fixed offset never replaces a named zone; a chosen zone is kept', async () => {
    const { rememberDeviceTimezone } = await import('@/core/tasks/timezone');
    await req('GET', '/api/tasks/my-day?tz=Europe/Berlin');
    await expect.poll(async () => (await zoneOf()).timezone).toBe('Europe/Berlin');
    // The phone reports an offset: Berlin stays.
    expect(await rememberDeviceTimezone(aliceId, 'Etc/GMT-1')).toBe(false);
    expect(await rememberDeviceTimezone(aliceId, 'UTC')).toBe(false);
    expect((await zoneOf()).timezone).toBe('Europe/Berlin');
    // A named zone replaces a fixed one.
    await setZone('Etc/GMT-1');
    expect(await rememberDeviceTimezone(aliceId, 'Europe/Lisbon')).toBe(true);
    expect((await zoneOf()).timezone).toBe('Europe/Lisbon');
    // A zone chosen in Settings is never overwritten by a device.
    await setZone('Asia/Tokyo', 'user');
    expect(await rememberDeviceTimezone(aliceId, 'Europe/Berlin')).toBe(false);
    expect(await zoneOf()).toMatchObject({ timezone: 'Asia/Tokyo', timezoneSource: 'user' });
  });

  test('a bare offset (`+05:30`) is no zone: never stored, never a series zone, never read by SQL', async () => {
    const { rememberDeviceTimezone } = await import('@/core/tasks/timezone');
    await setZone('Europe/Berlin');
    expect(await rememberDeviceTimezone(aliceId, '+05:30')).toBe(false);
    expect(await rememberDeviceTimezone(aliceId, '-0800')).toBe(false);
    expect((await zoneOf()).timezone).toBe('Europe/Berlin');
    const { body } = await req('POST', '/api/tasks', { title: 'Offset series', repeat: { unit: 'day', interval: 1, tz: '+05:30' }, dueAt: '2030-03-30', tz: '+05:30' });
    expect(body.repeat.tz).toBe('Europe/Berlin');
  });

  test('a device report never replaces a zone chosen in Settings, even when the choice lands between its read and its write', async () => {
    await setZone('Etc/GMT-1');
    const { userRepository } = await import('@/db/repositories/user-repository');
    // The user's choice lands first; the device's write carries its own condition.
    await setZone('Asia/Tokyo', 'user');
    expect(await userRepository.setDeviceTimezone(aliceId, 'Europe/Lisbon', false)).toBe(false);
    expect(await zoneOf()).toMatchObject({ timezone: 'Asia/Tokyo', timezoneSource: 'user' });
  });

  test('a series runs in the stored named zone even when the request sends a fixed offset', async () => {
    await setZone('Europe/Berlin');
    const { body } = await req('POST', '/api/tasks', { title: 'Stretch', repeat: 'daily', dueAt: '2030-03-30', tz: 'Etc/GMT-1' });
    expect(body.repeat.tz).toBe('Europe/Berlin');
  });

  test('/todo and the agent\'s My Day use the user\'s stored zone, not UTC', async () => {
    await setZone('America/New_York');
    const { getCommand } = await import('@/core/commands/registry');
    await getCommand('todo')!.execute({ sessionId: 's1', userId: aliceId, args: 'call Ana tomorrow 3pm' });
    const [row] = await rowsOf(aliceId);
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(row.due_at))).toBe('15:00');
    await setZone('Pacific/Kiritimati');
    const made = await tool('create_task', { title: 'Plan', myDay: true });
    expect(made.task.myDayOn).toBe(today('Pacific/Kiritimati'));
  });

  test('reopening keeps a next occurrence that has a comment, an added step or a star, or is old', async () => {
    const complete = async (title: string) => {
      const { body } = await req('POST', '/api/tasks', { title, repeat: 'daily' });
      return (await req('PATCH', `/api/tasks/${body.id}`, { status: 'done' })).body as { id: string; repeatNextId: string };
    };
    const reopenKeeps = async (done: { id: string; repeatNextId: string }) => {
      const reopened = await req('PATCH', `/api/tasks/${done.id}`, { status: 'open' });
      expect(reopened.body.repeatNextId).toBe(done.repeatNextId);
      expect((await req('GET', `/api/tasks/${done.repeatNextId}`)).status).toBe(200);
    };
    const commented = await complete('A');
    await req('POST', `/api/tasks/${commented.repeatNextId}/comments`, { body: 'started on it' });
    await reopenKeeps(commented);
    const stepped = await complete('B');
    await req('POST', '/api/tasks', { title: 'new step', parentId: stepped.repeatNextId });
    await reopenKeeps(stepped);
    const starred = await complete('C');
    await req('PATCH', `/api/tasks/${starred.repeatNextId}`, { important: true });
    await reopenKeeps(starred);
    const old = await complete('D');
    await executeRaw(`UPDATE tasks SET created_at = now() - interval '11 minutes', updated_at = now() - interval '11 minutes' WHERE id = '${old.repeatNextId}'`);
    await reopenKeeps(old);
    // And a completion after a kept occurrence makes no second one.
    await req('PATCH', `/api/tasks/${old.id}`, { status: 'done' });
    expect((await rowsOf(aliceId)).filter((r) => r.title === 'D')).toHaveLength(2);
  });

  test('deleted steps are not copied; copied steps keep their list', async () => {
    const { body: task } = await req('POST', '/api/tasks', { title: 'Weekly shop', repeat: 'weekly', category: 'Home' });
    const { body: keep } = await req('POST', '/api/tasks', { title: 'milk', parentId: task.id, category: 'Home' });
    const { body: gone } = await req('POST', '/api/tasks', { title: 'old step', parentId: task.id });
    await req('PATCH', `/api/tasks/${gone.id}`, { status: 'archived' });
    await req('PATCH', `/api/tasks/${keep.id}`, { status: 'done' });
    const { body: done } = await req('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    const steps = (await rowsOf(aliceId)).filter((r) => r.parent_id === done.repeatNextId);
    expect(steps.map((s) => [s.title, s.status, s.category])).toEqual([['milk', 'open', 'Home']]);
  });

  test('the spawn claims only a finished row, and the sweep heals a series left without a next occurrence', async () => {
    const { spawnNextOccurrence, healRepeatSeries } = await import('@/db/repositories/task-series');
    const { body: open } = await req('POST', '/api/tasks', { title: 'Open one', repeat: 'daily' });
    const row = (await queryRaw(`SELECT * FROM tasks WHERE id = $1`, [open.id])).rows[0];
    // An occurrence reopened before the claim: no stray next one.
    expect(await spawnNextOccurrence({ ...row, repeat: row.repeat, dueAt: null, remindAt: null, userId: row.user_id, workspaceId: row.workspace_id, sortOrder: row.sort_order } as any, { claim: true, fallbackTz: 'UTC' })).toBeNull();
    expect((await rowsOf(aliceId)).filter((r) => r.title === 'Open one')).toHaveLength(1);
    // A completion whose spawn never happened (simulated: done, no link, no next one).
    await executeRaw(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = '${open.id}'`);
    expect(await healRepeatSeries(async () => 'UTC')).toBe(1);
    expect(await healRepeatSeries(async () => 'UTC')).toBe(0);
    expect((await rowsOf(aliceId)).filter((r) => r.title === 'Open one')).toHaveLength(2);
  });

  test('deleting or archiving an occurrence skips it: the series goes on', async () => {
    const { body: a } = await req('POST', '/api/tasks', { title: 'Skip me', repeat: 'daily', dueAt: '2099-01-01', tz: 'UTC' });
    await req('PATCH', `/api/tasks/${a.id}`, { status: 'archived' });
    let rows = (await rowsOf(aliceId)).filter((r) => r.title === 'Skip me' && r.status === 'open');
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].due_at).toISOString().slice(0, 10)).toBe('2099-01-02');
    await req('DELETE', `/api/tasks/${rows[0].id}`);
    rows = (await rowsOf(aliceId)).filter((r) => r.title === 'Skip me' && r.status === 'open');
    expect(rows.map((r) => new Date(r.due_at).toISOString().slice(0, 10))).toEqual(['2099-01-03']);
    // Restoring the archived one takes back the untouched occurrence it made.
    const restored = await req('PATCH', `/api/tasks/${a.id}`, { status: 'open' });
    expect(restored.status).toBe(200);
  });

  test('a repeating step comes back before the wakeups run, so its parent stays open', async () => {
    const { body: parent } = await req('POST', '/api/tasks', { title: 'Morning routine' });
    const { body: step } = await req('POST', '/api/tasks', { title: 'Stretch', parentId: parent.id, repeat: 'daily' });
    await req('PATCH', `/api/tasks/${step.id}`, { status: 'done' });
    await (await import('@/core/tasks/wakeups')).flushWakeups();
    expect((await req('GET', `/api/tasks/${parent.id}`)).body.status).toBe('open');
    const children = (await rowsOf(aliceId)).filter((r) => r.parent_id === parent.id);
    expect(children.map((c) => c.status).sort()).toEqual(['done', 'open']);
  });

  test('lists: an empty list persists, renames move every to-do, deleting leaves the to-dos with an undo', async () => {
    expect((await req('POST', '/api/tasks/lists', { name: 'Garden' })).body).toEqual({ name: 'Garden' });
    expect((await req('POST', '/api/tasks/lists', { name: 'garden' })).status).toBe(409);
    await req('POST', '/api/tasks', { title: 'Mow', category: 'Home' });
    await req('POST', '/api/tasks', { title: 'Paint', category: 'Home' });
    expect((await req('GET', '/api/tasks/lists')).body.lists).toEqual([{ name: 'Garden', open: 0 }, { name: 'Home', open: 2 }]);
    // Bob sees none of them.
    expect((await req('GET', '/api/tasks/lists', undefined, 'bob')).body.lists).toEqual([]);
    const renamed = await req('PATCH', '/api/tasks/lists', { name: 'Home', newName: 'House' });
    expect(renamed.body.taskIds).toHaveLength(2);
    const deleted = await req('DELETE', '/api/tasks/lists?name=House');
    expect(deleted.body.taskIds).toHaveLength(2);
    expect((await rowsOf(aliceId)).map((r) => r.category)).toEqual([null, null]);
    await req('POST', '/api/tasks/lists/move', { taskIds: deleted.body.taskIds, name: 'House' });
    expect((await rowsOf(aliceId)).map((r) => r.category)).toEqual(['House', 'House']);
    await req('DELETE', '/api/tasks/lists?name=Garden');
    expect((await req('GET', '/api/tasks/lists')).body.lists).toEqual([{ name: 'House', open: 2 }]);
    // Each move of a to-do between lists is audited (rename, delete, move back).
    const { auditRepository } = await import('@/db/repositories/audit-repository');
    for (const id of deleted.body.taskIds as string[]) {
      const moves = (await auditRepository.findByResource('task', id)).map((r) => r.details as Record<string, unknown>).filter((d) => d.op === 'update');
      expect(moves).toHaveLength(3);
      expect(moves.every((d) => JSON.stringify(d.change) === '["category"]')).toBe(true);
    }
  });
});
