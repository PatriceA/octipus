import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hook } from '@/core/types';
import { markHeartbeatGatePassed } from '@/core/heartbeat';
import { executeAction, isCapacityRefusal, resolveHookSessionId } from './actions';
import { ConcurrencyLimitError } from '@/core/errors/concurrency-limit';
import type { TriggerContext } from './triggers';

// The role-heartbeat path: the worker spawn is observed, never run.
const spawned = vi.hoisted(() => ({ abortOnSpawn: undefined as AbortController | undefined, calls: [] as Array<{ role: string; task: string; input: string; context: Record<string, unknown>; overrides: Record<string, unknown> }> }));
// The orchestrated path's root turn; a test sets what it does.
const orchestrated = vi.hoisted(() => ({ handleMessage: undefined as undefined | (() => Promise<unknown>) }));
vi.mock('@/core/agent', () => ({
  getAgentService: () => ({
    handleMessage: () => orchestrated.handleMessage!(),
    spawnWorker: async (role: string, task: string, input: string, context: Record<string, unknown>, overrides: Record<string, unknown>) => {
      spawned.calls.push({ role, task, input, context, overrides });
      if (typeof overrides.onWorkerSpawned === 'function') overrides.onWorkerSpawned('heartbeat-worker');
      spawned.abortOnSpawn?.abort(new Error('Heartbeat lease lost'));
      return 'worked the board';
    },
  }),
}));
// The direct (non-orchestrated) spawn: the options are observed, nothing runs.
const direct = vi.hoisted(() => ({ stops: [] as Array<{ id: string; options: unknown }>, spawns: [] as Array<Record<string, unknown>>, runImpl: undefined as undefined | (() => Promise<string>), spawnError: undefined as Error | undefined }));
vi.mock('@/core/agent-manager', () => ({
  getAgentManager: () => ({
    stop: (id: string, options: unknown) => { direct.stops.push({ id, options }); return true; },
    spawn: async (options: Record<string, unknown>) => {
      if (direct.spawnError) throw direct.spawnError;
      direct.spawns.push(options);
      return { run: () => (direct.runImpl ? direct.runImpl() : Promise.resolve('')), getContext: () => ({ id: 'agent-1' }) };
    },
  }),
}));
vi.mock('@/core/agent/roles', () => ({ ROLE_CONFIGS: { coding: {}, general: {} } }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'ws-1' }) }) }));
// The hook session does not exist yet: the heartbeat runs in the default workspace.
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => null, createAutomation: async (row: Record<string, unknown>) => row } }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ctx(over: Partial<TriggerContext> = {}): TriggerContext {
  return over as TriggerContext;
}
function hook(over: Partial<Hook> = {}): Hook {
  return { id: 'hook-1', userId: '11111111-1111-4111-8111-111111111111', sessionId: null, ...over } as Hook;
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
    expect(call.context).toMatchObject({ sessionId: 'hook-sess', userId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws-1', role: 'coding', attended: false, root: false });
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

  test('runs a burst of deliveries to one hook session one after another, not in parallel', async () => {
    const { withSessionTurn } = await import('@/core/session-turn-lock');
    // A turn already running in the session (the user's, or an earlier delivery).
    let releaseTurn!: () => void;
    const busy = withSessionTurn('hook-sess', () => new Promise<void>(resolve => { releaseTurn = resolve; }));
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const finishers: Array<() => void> = [];
    direct.runImpl = async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); order.push('start');
      await new Promise<void>(resolve => finishers.push(resolve));
      inFlight -= 1; order.push('end');
      return '';
    };
    try {
      const fire = () => executeAction(hook({
        userId: '77777777-7777-4777-8777-777777777777', trigger: 'webhook', action: 'spawn_agent', sessionId: 'hook-sess',
        actionConfig: { orchestrated: false, agentPrompt: 'triage' },
      } as Partial<Hook>), ctx());
      const results = await Promise.all([fire(), fire()]);
      expect(results.every(r => r.success)).toBe(true);
      const settle = () => new Promise(resolve => setTimeout(resolve, 0));
      await settle();
      expect(order).toEqual([]); // both wait behind the running turn
      releaseTurn(); await busy; await settle();
      expect(order).toEqual(['start']);
      finishers.shift()!(); await settle(); await settle();
      expect(order).toEqual(['start', 'end', 'start']);
      finishers.shift()!(); await settle();
      expect(maxInFlight).toBe(1);
    } finally {
      direct.runImpl = undefined;
    }
  });

  test('a queued run that /stop drops never runs, and its spawned agent is stopped', async () => {
    const { cancelQueuedTurns, withSessionTurn } = await import('@/core/session-turn-lock');
    let releaseTurn!: () => void;
    const busy = withSessionTurn('hook-sess-stop', () => new Promise<void>(resolve => { releaseTurn = resolve; }));
    const ran = vi.fn(async () => '');
    direct.runImpl = ran;
    direct.stops.length = 0;
    try {
      const r = await executeAction(hook({
        userId: '77777777-7777-4777-8777-777777777777', trigger: 'webhook', action: 'spawn_agent', sessionId: 'hook-sess-stop',
        actionConfig: { orchestrated: false, agentPrompt: 'triage' },
      } as Partial<Hook>), ctx());
      expect(r.success).toBe(true);
      expect(cancelQueuedTurns('hook-sess-stop')).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(direct.stops.map(s => s.id)).toEqual(['agent-1']);
      releaseTurn(); await busy;
      expect(ran).not.toHaveBeenCalled();
    } finally {
      direct.runImpl = undefined;
    }
  });
});

describe('executeSpawnAgent: orchestrated', () => {
  test('a turn /stop dropped from the session queue reports droppedByStop instead of failing', async () => {
    const { SessionTurnCancelledError } = await import('@/core/session-turn-lock');
    orchestrated.handleMessage = async () => { throw new SessionTurnCancelledError('hook-sess'); };
    try {
      const r = await executeAction(hook({
        userId: '77777777-7777-4777-8777-777777777777', trigger: 'webhook', action: 'spawn_agent', sessionId: 'hook-sess',
        actionConfig: { orchestrated: true, agentPrompt: 'triage' },
      } as Partial<Hook>), ctx());
      expect(r.success).toBe(false);
      expect(r).toMatchObject({ droppedByStop: true });
      expect(r.notStarted).toBeUndefined(); // a user's stop is never retried as a refusal
      expect(r.error).toContain('/stop');
    } finally {
      orchestrated.handleMessage = undefined;
    }
  });
});

describe('executeSpawnAgent: refused before any agent started', () => {
  const fire = () => executeAction(hook({
    userId: '77777777-7777-4777-8777-777777777777', trigger: 'webhook', action: 'spawn_agent', sessionId: 'hook-sess',
    actionConfig: { orchestrated: false, agentPrompt: 'triage' },
  } as Partial<Hook>), ctx());

  test('the agent cap or a quota is reported as notStarted', async () => {
    const { QuotaExceededError } = await import('@/security/quota-error');
    for (const err of [
      new ConcurrencyLimitError(3),
      new QuotaExceededError({ kind: 'concurrentAgents', current: 2, max: 2, userId: 'u' }),
    ]) {
      direct.spawnError = err;
      try {
        expect(await fire()).toEqual({ success: false, error: err.message, notStarted: true });
      } finally {
        direct.spawnError = undefined;
      }
    }
  });

  test('any other spawn failure is a plain failure (the action ran)', async () => {
    direct.spawnError = new Error('model provider unreachable');
    try {
      const r = await fire();
      expect(r).toEqual({ success: false, error: 'model provider unreachable' });
    } finally {
      direct.spawnError = undefined;
    }
  });

  test('isCapacityRefusal', () => {
    expect(isCapacityRefusal(new ConcurrencyLimitError(10))).toBe(true);
    expect(isCapacityRefusal(Object.assign(new Error('x'), { name: 'ConcurrencyLimitError' }))).toBe(true);
    // Only the typed error counts, not a lookalike message.
    expect(isCapacityRefusal(new Error('Maximum concurrent agents (10) reached'))).toBe(false);
    expect(isCapacityRefusal(new Error('boom'))).toBe(false);
  });
});

describe('personal heartbeat cannot become a chat turn', () => {
  test('refuses plain heartbeat even with orchestrated=true and a forged gate flag', async () => {
    const before = direct.spawns.length;
    const h = hook({ trigger: 'heartbeat', triggerConfig: {}, action: 'spawn_agent', actionConfig: { orchestrated: true } });
    const c = ctx({ message: { content: 'Heartbeat check-in' }, heartbeatGatePassed: true } as never);
    markHeartbeatGatePassed(c);
    const result = await executeAction(h, c);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not as chat or General turns');
    expect(spawned.calls).toHaveLength(0);
    expect(direct.spawns).toHaveLength(before);
  });
});

test('losing a heartbeat lease cancels the worker and its descendants', async () => {
  const controller = new AbortController();
  const c = ctx({ message: { content: 'Actual assigned work' } } as never);
  markHeartbeatGatePassed(c, undefined, undefined, controller.signal);
  spawned.abortOnSpawn = controller;
  direct.stops.length = 0;
  try {
    const h = { ...hook({ trigger: 'heartbeat', action: 'spawn_agent', actionConfig: {}, sessionId: 'hook-sess' }), triggerConfig: { role: 'coding' } } as Hook;
    const result = await executeAction(h, c);
    expect(result).toMatchObject({ success: false, error: 'Heartbeat lease lost' });
    expect(direct.stops).toEqual([{ id: 'heartbeat-worker', options: { cascade: true } }]);
  } finally { spawned.abortOnSpawn = undefined; }
});
