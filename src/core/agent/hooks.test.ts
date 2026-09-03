import { afterEach, describe, expect, test } from 'vitest';
import {
  type BuildSystemPromptOptions,
  type ToolDispatchContext,
  getOrchestratorHooks,
} from './hooks';

const baseCtx = (): BuildSystemPromptOptions => ({
  role: 'general',
  userId: 'user-1',
  sessionId: 'session-1',
  workspaceId: null,
  systemPrompt: 'BASE',
});

describe('OrchestratorHooks', () => {
  afterEach(() => getOrchestratorHooks()._clearForTesting());

  test('fire with no handlers returns the ctx unchanged', async () => {
    const ctx = baseCtx();
    const out = await getOrchestratorHooks().fire('before-agent-start', ctx);
    expect(out.systemPrompt).toBe('BASE');
  });

  test('handler can mutate the systemPrompt', async () => {
    const hooks = getOrchestratorHooks();
    hooks.register('before-agent-start', (ctx) => {
      ctx.systemPrompt = `PREPEND\n${ctx.systemPrompt}`;
    });
    const ctx = baseCtx();
    await hooks.fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toBe('PREPEND\nBASE');
  });

  test('multiple handlers run sequentially in registration order', async () => {
    const hooks = getOrchestratorHooks();
    hooks.register('before-agent-start', (ctx) => { ctx.systemPrompt += '|A'; });
    hooks.register('before-agent-start', (ctx) => { ctx.systemPrompt += '|B'; });
    hooks.register('before-agent-start', async (ctx) => { ctx.systemPrompt += '|C'; });
    const ctx = baseCtx();
    await hooks.fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toBe('BASE|A|B|C');
  });

  test('thrown handler does NOT block subsequent handlers', async () => {
    const hooks = getOrchestratorHooks();
    hooks.register('before-agent-start', () => { throw new Error('boom'); });
    hooks.register('before-agent-start', (ctx) => { ctx.systemPrompt += '|after-throw'; });
    const ctx = baseCtx();
    await hooks.fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toBe('BASE|after-throw');
  });

  test('unregister removes the handler', async () => {
    const hooks = getOrchestratorHooks();
    const off = hooks.register('before-agent-start', (ctx) => { ctx.systemPrompt += '|X'; });
    off();
    expect(hooks._count('before-agent-start')).toBe(0);
    const ctx = baseCtx();
    await hooks.fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toBe('BASE');
  });
});

describe('fireWaterfall — dispatch middleware', () => {
  afterEach(() => getOrchestratorHooks()._clearForTesting());

  const toolCtx = (): ToolDispatchContext => ({
    toolId: 'filesystem',
    toolName: 'read_file',
    args: { path: '/etc/passwd' },
    agent: { userId: 'u1', sessionId: 's1', role: 'coding' },
  });

  test('with no handlers the ctx passes through untouched', async () => {
    const out = await getOrchestratorHooks().fireWaterfall('tool:before', toolCtx());
    expect(out.shortCircuit).toBeUndefined();
    expect(out.args.path).toBe('/etc/passwd');
  });

  test('a handler can rewrite args', async () => {
    getOrchestratorHooks().register('tool:before', (ctx) => {
      ctx.args.path = '/workspace/safe.txt';
    });
    const out = await getOrchestratorHooks().fireWaterfall('tool:before', toolCtx());
    expect(out.args.path).toBe('/workspace/safe.txt');
  });

  test('deny short-circuits and skips every later handler', async () => {
    const hooks = getOrchestratorHooks();
    let laterRan = false;
    hooks.register('tool:before', (ctx) => {
      ctx.shortCircuit = { deny: 'path outside workspace' };
    });
    hooks.register('tool:before', () => { laterRan = true; });
    const out = await hooks.fireWaterfall('tool:before', toolCtx());
    expect(out.shortCircuit).toEqual({ deny: 'path outside workspace' });
    expect(laterRan).toBe(false);
  });

  test('a substituted result short-circuits too', async () => {
    getOrchestratorHooks().register('tool:before', (ctx) => {
      ctx.shortCircuit = { result: 'cached' };
    });
    const out = await getOrchestratorHooks().fireWaterfall('tool:before', toolCtx());
    expect(out.shortCircuit).toEqual({ result: 'cached' });
  });

  // The load-bearing difference from `fire`: policy fails CLOSED. A permission
  // hook that crashes must abort the dispatch, never read as "allowed".
  test('a throwing handler aborts the dispatch instead of being swallowed', async () => {
    getOrchestratorHooks().register('tool:before', () => {
      throw new Error('policy backend down');
    });
    await expect(
      getOrchestratorHooks().fireWaterfall('tool:before', toolCtx()),
    ).rejects.toThrow('policy backend down');
  });

  test('observational `fire` still swallows a throwing handler', async () => {
    const hooks = getOrchestratorHooks();
    let secondRan = false;
    hooks.register('tool:after', () => { throw new Error('tracing exporter down'); });
    hooks.register('tool:after', () => { secondRan = true; });
    await hooks.fire('tool:after', {
      toolId: 'filesystem',
      toolName: 'read_file',
      args: {},
      agent: { userId: 'u1', sessionId: 's1' },
      status: 'success',
      result: 'ok',
      durationMs: 3,
    });
    expect(secondRan).toBe(true);
  });

  test('a handler that unregisters mid-chain does not corrupt iteration', async () => {
    const hooks = getOrchestratorHooks();
    const order: string[] = [];
    const off = hooks.register('spawn:before', () => { order.push('b'); });
    hooks.register('spawn:before', () => { order.push('a'); off(); });
    hooks.register('spawn:before', () => { order.push('c'); });
    await hooks.fireWaterfall('spawn:before', {
      parentNodeId: 'n1', parentRole: 'orchestrator', childDepth: 1,
      childRole: 'research', topicPath: 'research', planned: false,
      agent: { userId: 'u1', sessionId: 's1' },
    });
    expect(order).toEqual(['b', 'a', 'c']);
  });
});
