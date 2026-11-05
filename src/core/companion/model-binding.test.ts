import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), defaults: vi.fn() }));
vi.mock('@/models/resolve-model', () => ({ resolveModel: mocks.resolve }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: mocks.defaults }) }));
import { ModelSelector } from '@/core/agent/model-selector';
beforeEach(() => { vi.clearAllMocks(); });
test('a persisted binding bypasses per-message model selection', async () => {
  mocks.resolve.mockResolvedValue({ name: 'bound', modelId: 'cli/codex', provider: 'cli', supportsTools: true });
  expect(await new ModelSelector().selectForRootAgent('session', 'task', { message: 'Review this PDF', boundModelName: 'bound' }, { userId: 'owner' }))
    .toEqual({ name: 'bound', modelId: 'cli/codex' });
  expect(mocks.defaults).not.toHaveBeenCalled();
});
test.each([null, { name: 'ocr', modelId: 'deepseek-ocr', provider: 'ollama', supportsTools: true }])('missing or specialist bindings fail without silently selecting another model', async row => {
  mocks.resolve.mockResolvedValue(row);
  await expect(new ModelSelector().selectForRootAgent('session', 'task', { message: 'Work', boundModelName: 'bound' }, { userId: 'owner' })).rejects.toThrow('bound Companion model');
  expect(mocks.defaults).not.toHaveBeenCalled();
});
