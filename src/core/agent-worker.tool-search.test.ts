import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentWorker } from '@/core/agent-worker';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext } from '@/core/types';
import * as config from '@/config';

/**
 * On the lazy path with first-party Claude, the worker sends every tool and
 * defers the long tail behind the API's tool search. The deferred set is a
 * fixed floor, not the sticky selection: what is loaded must not change
 * mid-conversation, or the point (a tool block that never changes) is lost.
 */

const ctx: AgentContext = {
  id: 'w', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', topic: 't', model: 'claude-opus-5-5',
  role: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {}, space: null, trigger: 'user', funding: 'own',
};
const h = (name: string, toolId?: string): ToolHandler => ({ name, toolId, description: name, parameters: {}, execute: async () => null });
const tools = [h('filesystem__read_file', 'filesystem'), h('shell__run', 'shell'), h('notes__search', 'notes'), h('websearch__search', 'websearch'), h('spawn_child'), h('list_tools', 'tool_discovery')];

function worker(advertisement: AgentWorker['config']['toolAdvertisement']) {
  const w = new AgentWorker(ctx, { maxIterations: 1, contextWindowSize: 100_000, timeout: 60_000, maxTokenBudget: 0, toolOutputSoftCap: 1000, toolAdvertisement: advertisement });
  w.registerTools(tools);
  return w as unknown as { nativeToolSearchDeferrals(m: { provider?: string; modelId: string }): string[] | undefined };
}

afterEach(() => vi.restoreAllMocks());

describe('native tool search deferrals', () => {
  const lazy = { mode: 'lazy' as const, coreToolIds: ['filesystem', 'shell', 'notes'] };

  test('first-party Claude on the lazy path defers everything outside the fixed floor', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ agent: { nativeToolSearch: true } } as never);
    // `notes` is in this turn's sticky selection, and is deferred anyway: the floor does not follow it.
    expect(worker(lazy).nativeToolSearchDeferrals({ provider: 'anthropic', modelId: 'claude-opus-5-5' })).toEqual(['notes__search', 'websearch__search']);
  });

  test.each([
    ['another provider', { provider: 'openai', modelId: 'gpt-5.6' }, lazy],
    ['a proxy serving Claude', { provider: 'litellm', modelId: 'claude-opus-5-5' }, lazy],
    ['a model without tool search', { provider: 'anthropic', modelId: 'claude-opus-4-1' }, lazy],
    ['the full advertisement', { provider: 'anthropic', modelId: 'claude-opus-5-5' }, { mode: 'full' as const }],
  ])('not for %s', (_label, model, advertisement) => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ agent: { nativeToolSearch: true } } as never);
    expect(worker(advertisement).nativeToolSearchDeferrals(model)).toBeUndefined();
  });

  test('not when the operator switched it off', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ agent: { nativeToolSearch: false } } as never);
    expect(worker(lazy).nativeToolSearchDeferrals({ provider: 'anthropic', modelId: 'claude-opus-5-5' })).toBeUndefined();
  });
});
