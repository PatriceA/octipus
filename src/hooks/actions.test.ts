import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hook } from '@/core/types';
import { executeAction, resolveHookSessionId } from './actions';

// The role-heartbeat spawn path: a spawned worker is observed, never run.
const spawned = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, runs: [] as string[] }));
vi.mock('@/core/agent-manager', () => ({
  getAgentManager: () => ({
    spawn: async (options: Record<string, unknown>) => {
      spawned.options.push(options);
      return { run: async (m: string) => { spawned.runs.push(m); return 'ok'; }, getContext: () => ({ id: 'agent-1' }) };
    },
  }),
}));
vi.mock('@/core/agent/roles', () => ({
  ROLE_CONFIGS: { coding: {}, general: {} },
  getRoleConfig: (role: string) => ({ systemPromptTemplate: `ROLE PROMPT ${role}` }),
  getToolsForRole: () => [{ name: 'read_file' }],
}));
vi.mock('@/tools/registry', () => ({
  getToolRegistry: () => ({ getToolHandlersForTools: (ids: string[]) => (ids.includes('tasks') ? [{ name: 'checkout_task' }, { name: 'complete_task' }] : []) }),
}));
vi.mock('@/config', () => ({ getConfig: () => ({ agent: { defaultTimeout: 1000 } }) }));
import type { TriggerContext } from './triggers';

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
    spawned.options.length = 0;
    spawned.runs.length = 0;
  });

  const roleHook = (role: string) => hook({
    trigger: 'heartbeat', action: 'spawn_agent', sessionId: 'hook-sess',
    triggerConfig: { role }, actionConfig: { orchestrated: true, agentPrompt: '' },
  } as Partial<Hook>);
  const message = { message: { content: 'Role heartbeat: ready tasks…' } } as never;

  test('spawns the agent AS the role, with the role prompt and the tasks tool, on the hook session', async () => {
    const r = await executeAction(roleHook('coding'), ctx(message));
    expect(r).toEqual({ success: true, data: { agentId: 'agent-1', role: 'coding' } });
    expect(spawned.options).toHaveLength(1);
    const o = spawned.options[0];
    expect(o.role).toBe('coding');
    expect(o.sessionId).toBe('hook-sess');
    expect(o.userId).toBe('user-1');
    expect(o.systemPrompt).toBe('ROLE PROMPT coding');
    expect((o.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['read_file', 'checkout_task', 'complete_task']);
    await vi.waitFor(() => expect(spawned.runs).toEqual(['Role heartbeat: ready tasks…']));
  });

  test('an unknown role fails the action instead of spawning a general agent', async () => {
    const r = await executeAction(roleHook('juggler'), ctx(message));
    expect(r.success).toBe(false);
    expect(spawned.options).toHaveLength(0);
  });
});
