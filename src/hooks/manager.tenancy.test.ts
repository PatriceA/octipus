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
 *    context, and untargeted schedule events fire nothing;
 *  - a test fire builds its context server-side, can't target another user's
 *    session, and doesn't count as a real run;
 *  - cached counters stay current, and triggerHook honours a DB-side disable;
 *  - path webhooks fire only the hooks whose own signature verifies;
 *  - execute_tool always runs as the hook owner.
 *
 * executeAction is mocked so no real notifications/agents/webhooks run; the
 * mock records which hooks were executed and with what context. The real
 * module stays reachable via vi.importActual.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import type { Hook } from '@/db/schema/hooks';

const executed: string[] = [];
const contexts: unknown[] = [];
vi.mock('./actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./actions')>()),
  executeAction: vi.fn(async (hook: Hook, context: unknown) => {
    executed.push(hook.name);
    contexts.push(context);
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
const bobSession = '33333333-3333-3333-3333-333333333333';
const aliceSecret = 'alice-secret';
const bobSecret = 'bob-secret';

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
       ('${bobId}', 'bob-webhook-nopath', 'webhook', '{}'::jsonb, 'spawn_agent', '{}'::jsonb, true),
       ('${aliceId}', 'alice-spawn', 'schedule', '{"cronExpression":"0 0 1 1 *"}'::jsonb, 'spawn_agent', '{}'::jsonb, true),
       ('${aliceId}', 'alice-shared-path', 'webhook', '{"webhookPath":"shared","webhookSecret":"${aliceSecret}"}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${bobId}', 'bob-shared-path', 'webhook', '{"webhookPath":"shared","webhookSecret":"${bobSecret}"}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${aliceId}', 'alice-disabled-later', 'schedule', '{"cronExpression":"0 0 1 1 *"}'::jsonb, 'notify', '{}'::jsonb, true),
       ('${aliceId}', 'alice-telegram', 'message_received', '{"channelTypes":["telegram"]}'::jsonb, 'notify', '{}'::jsonb, true)`,
  );
  await executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled, conditions)
     VALUES ('${aliceId}', 'alice-gh-push', 'webhook', '{"webhookPath":"gh"}'::jsonb, 'notify', '{}'::jsonb, true,
             '[{"field":"webhook.headers.x-github-event","operator":"equals","value":"push"}]'::jsonb)`,
  );
  await executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled, max_executions)
     VALUES ('${aliceId}', 'alice-once', 'schedule', '{"cronExpression":"0 0 1 1 *"}'::jsonb, 'notify', '{}'::jsonb, true, 1)`,
  );
  await executeRaw(
    `INSERT INTO sessions (id, user_id, channel_type, channel_id, title)
     VALUES ('${bobSession}', '${bobId}', 'webchat', 'bob-chat', 'bob private chat')`,
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
  contexts.length = 0;
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

  test('data.hookId naming bob’s schedule hook does not run it (the route pins hookId)', async () => {
    const r = await postTest(ids['alice-cron'], { data: { hookId: ids['bob-cron'] } });
    expect(r.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-cron']]);
    expect(executed).toEqual(['alice-cron']);
  });

  test('testing alice’s permission hook never runs bob’s', async () => {
    const r = await postTest(ids['alice-perm']);
    expect(r.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-perm']]);
    expect(executed).toEqual(['alice-perm']);
  });

  test('caller-supplied context is ignored: the hook runs as its owner, in no foreign session', async () => {
    const r = await postTest(ids['alice-spawn'], {
      context: {
        agent: { userId: bobId, sessionId: bobSession, role: 'admin', root: true },
        message: { userId: bobId, content: 'hello', metadata: { sessionId: bobSession } },
        tool: { name: 'x', toolId: 'x', args: { secret: 1 } },
      },
    });
    expect(r.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-spawn']]);
    const ctx = contexts[0] as import('./triggers').TriggerContext;
    expect(ctx.agent).toBeUndefined();
    expect(ctx.tool).toBeUndefined();
    expect(ctx.message?.userId).toBe(aliceId);
    expect(ctx.message?.content).toBe('hello'); // only the text is carried over
    expect(JSON.stringify(ctx)).not.toContain(bobSession);
    expect(JSON.stringify(ctx)).not.toContain(bobId);
  });

  test('a channel-filtered message hook can be test-fired; identity fields are still ignored', async () => {
    const none = await postTest(ids['alice-telegram'], { message: 'hi' });
    expect(none.body.results).toEqual([]); // defaults to channel 'api'

    const r = await postTest(ids['alice-telegram'], {
      context: {
        message: {
          content: 'hi',
          channelType: 'telegram',
          userId: bobId,
          metadata: { sessionId: bobSession, userId: bobId, chatKind: 'group' },
        },
        agent: { userId: bobId, sessionId: bobSession },
        tool: { name: 'x', toolId: 'x', args: {} },
      },
    });
    expect(r.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-telegram']]);
    const ctx = contexts[0] as import('./triggers').TriggerContext;
    expect(ctx.message?.channelType).toBe('telegram');
    expect(ctx.message?.userId).toBe(aliceId);
    expect(ctx.message?.metadata).toEqual({ chatKind: 'group' });
    expect(ctx.agent).toBeUndefined();
    expect(ctx.tool).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain(bobSession);
    expect(JSON.stringify(ctx)).not.toContain(bobId);
  });

  test('the `channel` alias works and an unknown channel type is a 400', async () => {
    const ok = await postTest(ids['alice-telegram'], { context: { message: { content: 'hi', channel: 'telegram' } } });
    expect(ok.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-telegram']]);
    const bad = await postTest(ids['alice-telegram'], { context: { message: { content: 'hi', channelType: 'carrier-pigeon' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Invalid channel type/);
  });

  test('a webhook hook with a header condition can be test-fired', async () => {
    const miss = await postTest(ids['alice-gh-push'], { context: { webhook: { headers: { 'X-GitHub-Event': 'issues' } } } });
    expect(miss.body.results).toEqual([]);
    const r = await postTest(ids['alice-gh-push'], {
      context: { webhook: { path: 'gh', method: 'post', headers: { 'X-GitHub-Event': 'push' }, body: { ref: 'main' } } },
    });
    expect(r.body.results.map((x: any) => x.hookId)).toEqual([ids['alice-gh-push']]);
    const ctx = contexts[contexts.length - 1] as import('./triggers').TriggerContext;
    expect(ctx.webhook).toEqual({ path: 'gh', method: 'POST', headers: { 'x-github-event': 'push' }, body: { ref: 'main' } });
  });

  test('a test fire is not a real run: counters untouched, logged as manual_test', async () => {
    const { queryRaw } = await import('@/db/postgres');
    await postTest(ids['alice-once']);
    await postTest(ids['alice-once']); // maxExecutions 1 does not apply to tests
    expect(executed).toEqual(['alice-once', 'alice-once']);
    const { rows } = await queryRaw(`SELECT execution_count FROM hooks WHERE id = '${ids['alice-once']}'`);
    expect((rows[0] as any).execution_count).toBe(0);
    const logs = await queryRaw(`SELECT source FROM hook_executions WHERE hook_id = '${ids['alice-once']}'`);
    expect((logs.rows as any[]).map((l) => l.source)).toEqual(['manual_test', 'manual_test']);
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

describe('schedule targeting and counters', () => {
  test('an untargeted schedule event fires nothing (fail closed)', async () => {
    const results = await manager.trigger(
      { type: 'schedule', data: {}, timestamp: new Date() },
      { schedule: { cronExpression: '0 0 1 1 *', scheduledTime: new Date() } },
    );
    expect(results).toEqual([]);
    expect(executed).toEqual([]);
  });

  test('cached counters update in place, so maxExecutions holds between reloads', async () => {
    const fire = () =>
      manager.trigger(
        { type: 'schedule', data: { hookId: ids['alice-once'] }, timestamp: new Date() },
        { schedule: { cronExpression: '0 0 1 1 *', scheduledTime: new Date() } },
      );
    await fire();
    await fire();
    expect(executed).toEqual(['alice-once']);
    // triggerHook reads the DB row, which agrees.
    expect(await manager.triggerHook(ids['alice-once'], { type: 'schedule', data: { hookId: ids['alice-once'] }, timestamp: new Date() }, {})).toEqual([]);
  });

  test('triggerHook honours a disable made directly in the DB; a claimed row still fires', async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE hooks SET is_enabled = false WHERE id = '${ids['alice-disabled-later']}'`);
    const event = { type: 'schedule' as const, data: { hookId: ids['alice-disabled-later'] }, timestamp: new Date() };
    expect(await manager.triggerHook(ids['alice-disabled-later'], event, {})).toEqual([]);
    expect(executed).toEqual([]);

    // The cron-runner disables a one-shot before firing it and passes the row it claimed.
    const row = await manager.getHook(ids['alice-disabled-later']);
    const results = await manager.triggerHook(ids['alice-disabled-later'], event, {}, { claimedRow: row! });
    expect(results.map((r) => r.hookId)).toEqual([ids['alice-disabled-later']]);
  });
});

describe('session ownership', () => {
  test('a hook trigger cannot target another user’s session', async () => {
    const { resolveOwnedHookSessionId } = await vi.importActual<typeof import('./actions')>('./actions');
    const hook = (await manager.getHook(ids['alice-spawn']))!;
    for (const ctx of [
      { agent: { sessionId: bobSession } },
      { message: { metadata: { sessionId: bobSession } } },
    ] as never[]) {
      const r = await resolveOwnedHookSessionId(ctx, { ...hook, sessionId: null });
      expect(r.sessionId).not.toBe(bobSession);
    }
    // Even a hook row pointing at a foreign session doesn't get it.
    const r = await resolveOwnedHookSessionId({}, { ...hook, sessionId: bobSession });
    expect(r.sessionId).not.toBe(bobSession);
    expect(r.minted).toBe(false);
  });

  test('resolveSession refuses another user’s session', async () => {
    const { resolveSession } = await import('@/core/agent/session-resolver');
    await expect(resolveSession(bobSession, aliceId, 'hook')).rejects.toThrow('Session not found');
    await expect(resolveSession(bobSession, bobId, 'webchat')).resolves.toBe(bobSession);
  });

  test('execute_tool runs as the hook owner with a server-built context', async () => {
    const seen: any[] = [];
    const registry = await import('@/tools/registry');
    const spy = vi.spyOn(registry, 'getToolRegistry').mockReturnValue({
      get: () => ({ getTool: () => ({ execute: async (_p: unknown, ctx: unknown) => { seen.push(ctx); return 'ok'; } }) }),
    } as never);
    try {
      const { executeAction } = await vi.importActual<typeof import('./actions')>('./actions');
      const hook = {
        ...(await manager.getHook(ids['alice-cron']))!,
        action: 'execute_tool',
        actionConfig: { toolId: 't', toolAction: 'a' },
        sessionId: bobSession,
      } as Hook;
      const r = await executeAction(hook, {
        agent: { id: 'x', sessionId: bobSession, userId: bobId, role: 'admin', root: true } as never,
      });
      expect(r.success).toBe(true);
      expect(seen[0].userId).toBe(aliceId);
      expect(seen[0].sessionId).not.toBe(bobSession);
      expect(seen[0].root).toBeUndefined();
      expect(seen[0].role).toBe('general');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('POST /api/webhooks/:path (unauthenticated)', () => {
  const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const deliver = (path: string, payload: unknown, secret?: string) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-hub-signature-256'] = sign(body, secret);
    return webhookApp.handle(new Request(`http://localhost/api/webhooks/${path}`, { method: 'POST', headers, body }));
  };

  test('on a shared path, only the hook whose own secret verifies fires', async () => {
    const res = await deliver('shared', { n: 1 }, aliceSecret);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true, accepted: true, hooks: 1 });
    const { drainWebhookTasks } = await import('./webhook-delivery');
    await drainWebhookTasks();
    expect(executed).toEqual(['alice-shared-path']);
  });

  test('a delivery no hook verifies is rejected with 401', async () => {
    const res = await deliver('shared', { n: 2 }, 'wrong');
    expect(res.status).toBe(401);
    expect(executed).toEqual([]);
  });

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
