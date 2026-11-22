/**
 * `modelMayServe`: an agent spawned before its session's protection level
 * rose (a start's context hooks showed a level 3-4 passage) may not go on
 * running a model that content may not reach. Real routing
 * (core/protection/routing.ts); the model rows are stood in for.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';

vi.mock('@/core/modules/registry', async (original) => ({ ...await original<object>(), isModuleOn: (id: string) => id === 'protection' }));
const rows = vi.hoisted(() => new Map<string, Partial<ModelConfigEntry>>());
vi.mock('@/models/model-registry', async (original) => ({
  ...await original<object>(),
  getModelRegistry: () => ({
    getModel: async (name: string) => rows.get(name) ?? null,
    getModelByModelId: async (modelId: string) => [...rows.values()].find((r) => r.modelId === modelId) ?? null,
  }),
}));

const { AgentManager } = await import('./agent-manager');
const { raiseSessionLevel, resetSessionLevels } = await import('./protection/session-level');

const agent = (sessionId: string, modelName: string) => ({ getContext: () => ({ id: 'a', sessionId, userId: 'u', model: rows.get(modelName)?.modelId ?? modelName, modelName }) });
type Agent = Parameters<InstanceType<typeof AgentManager>['modelMayServe']>[0];

beforeEach(() => {
  resetSessionLevels();
  rows.clear();
  rows.set('claude-cli', { name: 'claude-cli', provider: 'cli', modelId: 'claude-code', endpoint: null, metadata: {} });
  rows.set('gpt-remote', { name: 'gpt-remote', provider: 'openai', modelId: 'gpt-remote', endpoint: null, metadata: {} });
  rows.set('vllm-local', { name: 'vllm-local', provider: 'custom-openai', modelId: 'vllm-local', endpoint: 'http://vllm:8000', metadata: { dataPolicy: { hosting: 'local', retention: 'none', trainsOnInput: false } } });
});

describe('modelMayServe', () => {
  test('below level 3 any model may go on', async () => {
    const mgr = new AgentManager();
    raiseSessionLevel('mms-1', 2);
    expect(await mgr.modelMayServe(agent('mms-1', 'claude-cli') as unknown as Agent)).toBe(true);
  });

  test('at level 3 a CLI or remote agent may not; a local one may', async () => {
    const mgr = new AgentManager();
    raiseSessionLevel('mms-2', 3);
    expect(await mgr.modelMayServe(agent('mms-2', 'claude-cli') as unknown as Agent)).toBe(false);
    raiseSessionLevel('mms-3', 4);
    expect(await mgr.modelMayServe(agent('mms-3', 'gpt-remote') as unknown as Agent)).toBe(false);
    expect(await mgr.modelMayServe(agent('mms-3', 'vllm-local') as unknown as Agent)).toBe(true);
  });
});
