/**
 * One session per thread of a spawn_agent webhook hook (src/hooks/thread-sessions.ts),
 * on embedded PGlite. The root agent is mocked: the test observes which session
 * each event runs in, nothing runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hook } from '@/core/types';
import type { TriggerContext } from './triggers';

const turns = vi.hoisted(() => ({ sessions: [] as string[] }));
vi.mock('@/core/agent', () => ({
  getAgentService: () => ({
    handleMessage: async (sessionId: string) => {
      turns.sessions.push(sessionId);
      return { agentId: 'agent-1', response: '' };
    },
  }),
}));

const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const hookId = '33333333-3333-4333-8333-333333333333';
const hookSession = '44444444-4444-4444-8444-444444444444';

let mod: typeof import('./thread-sessions');
let actions: typeof import('./actions');
let executeRaw: (sql: string) => Promise<unknown>;
let queryRaw: <T>(sql: string) => Promise<T[]>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-thread-sessions-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  executeRaw = db.executeRaw as typeof executeRaw;
  queryRaw = async <T>(q: string) => (await db.queryRaw(q)).rows as T[];
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'alice', false), ('${otherUserId}', 'bob', false) ON CONFLICT DO NOTHING`);
  await executeRaw(
    `INSERT INTO hooks (id, user_id, name, trigger, trigger_config, action, action_config)
     VALUES ('${hookId}', '${userId}', 'PR reviewer', 'webhook', '{"webhookPath":"gh"}'::jsonb, 'spawn_agent', '{}'::jsonb)`,
  );
  mod = await import('./thread-sessions');
  actions = await import('./actions');
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb?.();
});

beforeEach(async () => {
  turns.sessions = [];
  await executeRaw('DELETE FROM hook_thread_sessions');
});

const THREAD_KEY = '{{webhook.body.repository.full_name}}#{{webhook.body.pull_request.number}}';

function hook(actionConfig: Record<string, unknown> = {}): Hook {
  return {
    id: hookId, userId, sessionId: hookSession, trigger: 'webhook', action: 'spawn_agent',
    triggerConfig: { webhookPath: 'gh' },
    actionConfig: { agentPrompt: 'Review this', orchestrated: true, threadKey: THREAD_KEY, ...actionConfig },
  } as unknown as Hook;
}

function prEvent(number: number | undefined, action = 'opened'): TriggerContext {
  return {
    webhook: {
      path: 'gh', method: 'POST', headers: { 'x-github-event': 'pull_request' },
      body: { action, repository: { full_name: 'acme/app' }, ...(number === undefined ? {} : { pull_request: { number, title: 't' } }) },
    },
  };
}

describe('checkThreadKey', () => {
  test('a key with an unrendered field has no thread', () => {
    expect(mod.checkThreadKey('acme/app#{{webhook.body.pull_request.number}}'))
      .toEqual({ key: null, reason: 'the event has no webhook.body.pull_request.number' });
    expect(mod.checkThreadKey('   ')).toMatchObject({ key: null });
    expect(mod.checkThreadKey('x'.repeat(mod.MAX_THREAD_KEY_CHARS + 1))).toMatchObject({ key: null });
    expect(mod.checkThreadKey(' acme/app#42 ')).toEqual({ key: 'acme/app#42' });
  });

  test('endsThread reads GitHub and GitLab actions', () => {
    expect(mod.endsThread(['closed'], prEvent(1, 'closed'))).toBe(true);
    expect(mod.endsThread(['closed'], prEvent(1, 'synchronize'))).toBe(false);
    expect(mod.endsThread(undefined, prEvent(1, 'closed'))).toBe(false);
    const gitlab: TriggerContext = { webhook: { path: 'gl', method: 'POST', headers: {}, body: { object_attributes: { action: 'merge' } } } };
    expect(mod.endsThread(['merge'], gitlab)).toBe(true);
  });
});

describe('threadSession', () => {
  test('mints once per key and returns the same session after', async () => {
    const first = await mod.threadSession(hookId, 'acme/app#1');
    expect(first.created).toBe(true);
    expect(await mod.threadSession(hookId, 'acme/app#1')).toEqual({ sessionId: first.sessionId, created: false });
    expect((await mod.threadSession(hookId, 'acme/app#2')).sessionId).not.toBe(first.sessionId);
  });

  test('concurrent first events agree on one session', async () => {
    const all = await Promise.all(Array.from({ length: 5 }, () => mod.threadSession(hookId, 'acme/app#7')));
    expect(new Set(all.map((r) => r.sessionId)).size).toBe(1);
    expect(all.filter((r) => r.created)).toHaveLength(1);
  });

  test('an ended thread starts over', async () => {
    const first = await mod.threadSession(hookId, 'acme/app#3');
    await mod.endThread(hookId, 'acme/app#3');
    const next = await mod.threadSession(hookId, 'acme/app#3');
    expect(next.created).toBe(true);
    expect(next.sessionId).not.toBe(first.sessionId);
  });

  test('idle threads of the hook are pruned on the next mint', async () => {
    await mod.threadSession(hookId, 'acme/app#old');
    await executeRaw(`UPDATE hook_thread_sessions SET last_used_at = now() - interval '${mod.THREAD_IDLE_DAYS + 1} days'`);
    await mod.threadSession(hookId, 'acme/app#new');
    const rows = await queryRaw<{ thread_key: string }>('SELECT thread_key FROM hook_thread_sessions ORDER BY thread_key');
    expect(rows.map((r) => r.thread_key)).toEqual(['acme/app#new']);
  });

  test('rows go with their hook', async () => {
    const tmpHook = '55555555-5555-4555-8555-555555555555';
    await executeRaw(
      `INSERT INTO hooks (id, user_id, name, trigger, trigger_config, action, action_config)
       VALUES ('${tmpHook}', '${userId}', 'tmp', 'webhook', '{}'::jsonb, 'spawn_agent', '{}'::jsonb)`,
    );
    await mod.threadSession(tmpHook, 'k');
    await executeRaw(`DELETE FROM hooks WHERE id = '${tmpHook}'`);
    expect(await queryRaw(`SELECT 1 FROM hook_thread_sessions WHERE hook_id = '${tmpHook}'`)).toHaveLength(0);
  });
});

describe('spawn_agent with a thread key', () => {
  test('events on one PR share a session; another PR gets its own', async () => {
    const a1 = await actions.executeAction(hook(), prEvent(42));
    const b = await actions.executeAction(hook(), prEvent(43));
    const a2 = await actions.executeAction(hook(), prEvent(42, 'synchronize'));
    expect([a1, b, a2].every((r) => r.success)).toBe(true);
    const [s1, s2, s3] = turns.sessions;
    expect(s1).toBe(s3);
    expect(s2).not.toBe(s1);
    expect(s1).not.toBe(hookSession);
    expect(a1.data).toMatchObject({ thread: { key: 'acme/app#42', created: true, ended: false } });
    expect(a2.data).toMatchObject({ thread: { key: 'acme/app#42', created: false } });
  });

  test('an event without the field runs in the hook session and says why', async () => {
    const r = await actions.executeAction(hook(), prEvent(undefined, 'ping'));
    expect(r.success).toBe(true);
    expect(turns.sessions).toEqual([hookSession]);
    expect(r.data).toMatchObject({ thread: { key: null, reason: 'the event has no webhook.body.pull_request.number' } });
  });

  test('the closing event runs in the thread session; the next one starts fresh', async () => {
    const h = hook({ threadEndActions: ['closed'] });
    await actions.executeAction(h, prEvent(9));
    const closed = await actions.executeAction(h, prEvent(9, 'closed'));
    await actions.executeAction(h, prEvent(9, 'reopened'));
    expect(turns.sessions[1]).toBe(turns.sessions[0]);
    expect(turns.sessions[2]).not.toBe(turns.sessions[0]);
    expect(closed.data).toMatchObject({ thread: { key: 'acme/app#9', ended: true } });
  });

  test('a hook without a thread key keeps its one session', async () => {
    await actions.executeAction(hook({ threadKey: undefined }), prEvent(42));
    await actions.executeAction(hook({ threadKey: '' }), prEvent(43));
    expect(turns.sessions).toEqual([hookSession, hookSession]);
  });

  test('a thread session another user holds is never entered', async () => {
    const { sessionId } = await mod.threadSession(hookId, 'acme/app#500');
    await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ('${sessionId}', '${otherUserId}', 'webchat', 'x')`);
    const r = await actions.executeAction(hook(), prEvent(500));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/belongs to another user/);
    expect(turns.sessions).toEqual([]);
  });
});
