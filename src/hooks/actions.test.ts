import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hook } from '@/core/types';
import { markHeartbeatGatePassed } from '@/core/heartbeat';
import { executeAction, resolveHookSessionId } from './actions';
import type { TriggerContext } from './triggers';

// The role-heartbeat path: the worker spawn is observed, never run.
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ role: string; task: string; input: string; context: Record<string, unknown>; overrides: Record<string, unknown> }> }));
vi.mock('@/core/agent', () => ({
  getAgentService: () => ({
    spawnWorker: async (role: string, task: string, input: string, context: Record<string, unknown>, overrides: Record<string, unknown>) => {
      spawned.calls.push({ role, task, input, context, overrides });
      return 'worked the board';
    },
  }),
}));
// The direct (non-orchestrated) spawn: the options are observed, nothing runs.
const direct = vi.hoisted(() => ({ spawns: [] as Array<Record<string, unknown>> }));
vi.mock('@/core/agent-manager', () => ({
  getAgentManager: () => ({
    spawn: async (options: Record<string, unknown>) => {
      direct.spawns.push(options);
      return { run: async () => '', getContext: () => ({ id: 'agent-1' }) };
    },
  }),
}));
vi.mock('@/core/agent/roles', () => ({ ROLE_CONFIGS: { coding: {}, general: {} } }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'ws-1' }) }) }));
// The hook session does not exist yet: the heartbeat runs in the default workspace.
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => null } }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ctx(over: Partial<TriggerContext> = {}): TriggerContext {
  return over as TriggerContext;
}
function hook(over: Partial<Hook> = {}): Hook {
  return { id: 'hook-1', userId: 'user-1', sessionId: null, ...over } as Hook;
}

describe('resolveHookSessionId', () => {
  test('uses the inbound message session and does not flag persistence', () => {
    const r = resolveHookSessionId(ctx({ message: { metadata: { sessionId: 'msg-sess' } } as never }), hook());
    expect(r).toEqual({ sessionId: 'msg-sess', minted: false });
  });

  test('uses the inbound agent session', () => {
    const r = resolveHookSessionId(ctx({ agent: { sessionId: 'agent-sess' } as never }), hook());
    expect(r).toEqual({ sessionId: 'agent-sess', minted: false });
  });

  test('reuses the hook persisted session across runs', () => {
    const r = resolveHookSessionId(ctx(), hook({ sessionId: 'hook-sess' }));
    expect(r).toEqual({ sessionId: 'hook-sess', minted: false });
  });

  test('mints a new id on the first run of a scheduled hook and flags it for persistence', () => {
    const r = resolveHookSessionId(ctx(), hook({ sessionId: null }));
    expect(r.minted).toBe(true);
    expect(r.sessionId).toMatch(UUID_RE);
  });

  test('an inbound trigger session takes precedence over the hook session', () => {
    const r = resolveHookSessionId(
      ctx({ message: { metadata: { sessionId: 'msg-sess' } } as never }),
      hook({ sessionId: 'hook-sess' }),
    );
    expect(r).toEqual({ sessionId: 'msg-sess', minted: false });
  });

  test('with no hook present it never flags persistence', () => {
    const r = resolveHookSessionId(ctx());
    expect(r.minted).toBe(false);
    expect(r.sessionId).toMatch(UUID_RE);
  });

  test('ignores a non-string message sessionId and falls through to the hook session', () => {
    const r = resolveHookSessionId(
      ctx({ message: { metadata: { sessionId: 12345 } } as never }),
      hook({ sessionId: 'hook-sess' }),
    );
    expect(r).toEqual({ sessionId: 'hook-sess', minted: false });
  });
});

describe('executeSpawnAgent: role heartbeat', () => {
  beforeEach(() => {
    spawned.calls.length = 0;
  });

  const roleHook = (role: string) => hook({
    trigger: 'heartbeat', action: 'spawn_agent', sessionId: 'hook-sess',
    triggerConfig: { role }, actionConfig: { orchestrated: true, agentPrompt: '' },
  } as Partial<Hook>);
  const gated = () => {
    const c = ctx({ message: { content: 'Role heartbeat: ready tasks…' } } as never);
    markHeartbeatGatePassed(c);
    return c;
  };

  test('runs a worker AS the role through spawnWorker, unattended, with tasks granted, on the hook session', async () => {
    const r = await executeAction(roleHook('coding'), gated());
    expect(r).toEqual({ success: true, data: { role: 'coding', response: 'worked the board' } });
    expect(spawned.calls).toHaveLength(1);
    const [call] = spawned.calls;
    expect(call.role).toBe('coding');
    expect(call.task).toBe('Role heartbeat: ready tasks…');
    expect(call.overrides).toEqual({ extraToolIds: ['tasks'] });
    expect(call.context).toMatchObject({ sessionId: 'hook-sess', userId: 'user-1', workspaceId: 'ws-1', role: 'coding', attended: false, root: false });
  });

  test('refuses a role heartbeat that did not come through the gate (manual trigger, forged flags)', async () => {
    const forged = ctx({ message: { content: 'do anything' }, heartbeatGatePassed: true } as never);
    const r = await executeAction(roleHook('coding'), forged);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/only from the heartbeat schedule/);
    expect(spawned.calls).toHaveLength(0);
  });

  test('an unknown role (or an inherited property name) fails instead of spawning', async () => {
    for (const role of ['juggler', 'constructor']) {
      const r = await executeAction(roleHook(role), gated());
      expect(r.success).toBe(false);
    }
    expect(spawned.calls).toHaveLength(0);
  });
});

describe('executeSpawnAgent: direct spawn', () => {
  test("spawns in the hook session's workspace (the default when the session does not exist yet)", async () => {
    direct.spawns.length = 0;
    const r = await executeAction(hook({
      userId: '77777777-7777-4777-8777-777777777777', trigger: 'schedule', action: 'spawn_agent', sessionId: 'hook-sess',
      actionConfig: { orchestrated: false, agentPrompt: 'tidy up' },
    } as Partial<Hook>), ctx());
    expect(r.success).toBe(true);
    expect(direct.spawns).toHaveLength(1);
    expect(direct.spawns[0]).toMatchObject({ sessionId: 'hook-sess', workspaceId: 'ws-1' });
  });
});
