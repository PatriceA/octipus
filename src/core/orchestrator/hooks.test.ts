import { afterEach, describe, expect, test } from 'bun:test';
import { type BuildSystemPromptOptions, getOrchestratorHooks } from './hooks';

const baseCtx = (): BuildSystemPromptOptions => ({
  role: 'orchestrator',
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
