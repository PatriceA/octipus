/**
 * Cross-tenant isolation for hook execution.
 *
 * HookManager caches every user's enabled hooks by trigger type. These tests
 * seed hooks for alice and bob and verify that:
 *  - POST /api/hooks/:id/test fires only the caller's hook (never bob's
 *    schedule / permission_requested hooks), and refuses heartbeat hooks;
 *  - tool_pre / tool_post hooks only run for their owner's tool calls, while
 *    a user's own tool_pre deny still blocks;
 *  - trigger() skips hooks owned by someone other than the user named in the
 *    context.
 *
 * executeAction is mocked so no real notifications/agents/webhooks run; the
 * mock records which hooks were executed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import type { Hook } from '@/db/schema/hooks';

const executed: string[] = [];
vi.mock('./actions', () => ({
  executeAction: vi.fn(async (hook: Hook) => {
    executed.push(hook.name);
    const deny = (hook.actionConfig as Record<string, unknown> | null)?.deny === true;
    return { success: true, data: deny ? { deny: true, message: `denied by ${hook.name}` } : { ran: hook.name } };
  }),
}));

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
const ids: Record<string, string> = {};
let aliceApp: ElysiaLike;
let webhookApp: ElysiaLike;
let manager: import('./manager').HookManager;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-hooks-tenancy-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false),
       ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );

  await executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled)
     VALUES
       ('${aliceId}', 'alice-cron', 'schedule', '{"cronExpression":"0 0 1 1 *"}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${bobId}', 'bob-cron', 'schedule', '{"cronExpression":"0 0 1 1 *"}'::jsonb, 'spawn_agent', '{}'::jsonb, true),
       ('${aliceId}', 'alice-perm', 'permission_requested', '{}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${bobId}', 'bob-perm', 'permission_requested', '{}'::jsonb, 'webhook', '{}'::jsonb, true),
       ('${aliceId}', 'alice-heartbeat', 'heartbeat', '{}'::jsonb, 'spawn_agent', '{}'::jsonb, true),
       ('${bobId}', 'bob-heartbeat', 'heartbeat', '{}'::jsonb, 'spawn_agent', '{}'::jsonb, true),
       ('${bobId}', 'bob-msg', 'message_received', '{}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${bobId}', 'bob-webhook-nopath', 'webhook', '{}'::jsonb, 'spawn_agent', '{}'::jsonb, true)`,
  );
  const { rows } = await queryRaw(`SELECT id, name FROM hooks`);
  for (const r of rows as Array<{ id: string; name: string }>) ids[r.name] = r.id;

  const { getHookManager } = await import('./manager');
  manager = getHookManager();
  // Cache now holds BOTH users' hooks — the precondition for the old leak.
  await manager.loadHooks();

  // tool_pre / tool_post are not (yet) values of the DB trigger_type enum, so
  // tool hooks cannot be seeded as rows; inject them into the cache directly.
  const toolHook = (name: string, userId: string, trigger: 'tool_pre' | 'tool_post', pattern: string, deny: boolean) =>
    ({
      id: crypto.randomUUID(), userId, name, trigger, triggerConfig: { toolPattern: pattern },
      action: 'notify', actionConfig: deny ? { deny: true } : {}, conditions: null,
      isEnabled: true, executionCount: 0,
    }) as unknown as Hook;
  const cache = (manager as unknown as { hookCache: Map<string, Hook[]> }).hookCache;
  cache.set('tool_pre', [
    toolHook('alice-tool-pre', aliceId, 'tool_pre', 'danger', true),
    toolHook('bob-tool-pre', bobId, 'tool_pre', '*', true),
  ]);
  cache.set('tool_post', [toolHook('bob-tool-post', bobId, 'tool_post', '*', false)]);

  const { hookRoutes } = await import('@/api/routes/hooks');
  const { principalFromUser } = await import('@/security/principal');
  aliceApp = new Elysia()
    .derive(() => {
      const u = { id: aliceId, username: 'alice', isAdmin: false };
      return { user: u, session: null, principal: principalFromUser(u) };
    })
    .group('/api', (a) => a.use(hookRoutes)) as unknown as ElysiaLike;

  const { webhookRoutes } = await import('@/api/routes/webhooks');
  webhookApp = new Elysia().group('/api', (a) => a.use(webhookRoutes)) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(() => {
  executed.length = 0;
});

async function postTest(hookId: string, body: unknown = {}) {
  const res = await aliceApp.handle(
    new Request(`http://localhost/api/hooks/${hookId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe('POST /api/hooks/:id/test', () => {
  test('testing alice’s schedule hook runs only that hook', async () => {
    const r = await postTest(ids['alice-cron']);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-cron']]);
    expect(executed).toEqual(['alice-cron']);
  });

  test('data.hookId naming bob’s schedule hook does not run it', async () => {
    const r = await postTest(ids['alice-cron'], { data: { hookId: ids['bob-cron'] } });
    expect(r.body.results).toEqual([]);
    expect(executed).not.toContain('bob-cron');
  });

  test('testing alice’s permission hook never runs bob’s', async () => {
    const r = await postTest(ids['alice-perm']);
    expect(r.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-perm']]);
    expect(executed).toEqual(['alice-perm']);
  });

  test('caller-supplied context naming another user is refused', async () => {
    const r = await postTest(ids['alice-perm'], { context: { agent: { userId: bobId } } });
    expect(r.body.results).toEqual([]);
    expect(executed).toEqual([]);
  });

  test('heartbeat hooks cannot be test-fired', async () => {
    const r = await postTest(ids['alice-heartbeat']);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/heartbeat hooks run on their schedule/);
    expect(executed).toEqual([]);
  });

  test('alice cannot test bob’s hook at all', async () => {
    const r = await postTest(ids['bob-cron']);
    expect(r.body).toEqual({ error: 'Hook not found' });
    expect(executed).toEqual([]);
  });
});

describe('triggerToolHooks', () => {
  test('bob’s tool hooks do not run for alice’s tool call', async () => {
    const pre = await manager.triggerToolHooks(aliceId, 'tool_pre', 'safe', 'safe', { secret: 'x' });
    expect(pre.decision).toBe('allow');
    await manager.triggerToolHooks(aliceId, 'tool_post', 'safe', 'safe', { secret: 'x' }, { output: 'ok' });
    expect(executed).toEqual([]);
  });

  test('alice’s own tool_pre deny still blocks her tool', async () => {
    const pre = await manager.triggerToolHooks(aliceId, 'tool_pre', 'danger', 'danger', {});
    expect(pre).toEqual({ decision: 'deny', message: 'denied by alice-tool-pre' });
    expect(executed).toEqual(['alice-tool-pre']);
  });

  test('bob’s hooks still apply to bob’s own tool calls', async () => {
    const pre = await manager.triggerToolHooks(bobId, 'tool_pre', 'anything', 'anything', {});
    expect(pre.decision).toBe('deny');
    expect(executed).toEqual(['bob-tool-pre']);
  });

  test('no user (system context) runs no user hooks', async () => {
    const pre = await manager.triggerToolHooks(undefined, 'tool_pre', 'danger', 'danger', {});
    expect(pre.decision).toBe('allow');
    expect(executed).toEqual([]);
  });
});

describe('trigger() owner guard', () => {
  test('a message context for alice never runs bob’s message hook', async () => {
    const message = {
      id: 'm1', channelType: 'api', channelId: 'c', userId: aliceId, content: 'hi', timestamp: new Date(),
    } as never;
    const results = await manager.trigger({ type: 'message_received', data: {}, timestamp: new Date() }, { message });
    expect(results).toEqual([]);
    expect(executed).toEqual([]);
  });

  test('cron-style trigger with data.hookId still fires exactly that hook', async () => {
    const results = await manager.trigger(
      { type: 'schedule', data: { hookId: ids['bob-cron'] }, timestamp: new Date() },
      { schedule: { cronExpression: '0 0 1 1 *', scheduledTime: new Date() } },
    );
    expect(results.map((r) => r.hookId)).toEqual([ids['bob-cron']]);
    expect(executed).toEqual(['bob-cron']);
  });
});

describe('POST /api/webhooks/:path (unauthenticated)', () => {
  test('a path no hook claims fires nothing (not every path-less webhook hook)', async () => {
    const res = await webhookApp.handle(
      new Request('http://localhost/api/webhooks/no-such-path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
    );
    expect(res.status).toBe(404);
    expect(executed).toEqual([]);
  });
});
