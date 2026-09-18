/**
 * Phase 2.1 capability floor — per-model shim-usage stats + the
 * validateRootModel reroute they drive.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as modelRegistry from '@/models/model-registry';
import {
  hasRecentShim,
  recordModelToolCall,
  resetModelCapabilityStats,
} from './model-capability';
import { classifyMessage } from './classifier';
import { ModelSelector } from './model-selector';
import {
  _resetSessionModelOverridesForTesting,
  setSessionModel,
} from './session-model-override';

afterEach(() => {
  resetModelCapabilityStats();
  _resetSessionModelOverridesForTesting();
  vi.restoreAllMocks();
});

describe('model-capability stats', () => {
  test('a single shim sample trips hasRecentShim', () => {
    resetModelCapabilityStats('m-shimmy');
    expect(hasRecentShim('m-shimmy')).toBe(false);
    recordModelToolCall('m-shimmy', true);
    expect(hasRecentShim('m-shimmy')).toBe(true);
  });

  test('native calls heal the window (sliding window forgets old shim flags)', () => {
    resetModelCapabilityStats('m-heal');
    recordModelToolCall('m-heal', true);
    expect(hasRecentShim('m-heal')).toBe(true);
    // 10 native calls push the single shim flag out of the 10-slot window.
    for (let i = 0; i < 10; i++) recordModelToolCall('m-heal', false);
    expect(hasRecentShim('m-heal')).toBe(false);
  });

  test('reset clears the blame', () => {
    recordModelToolCall('m-reset', true);
    expect(hasRecentShim('m-reset')).toBe(true);
    resetModelCapabilityStats('m-reset');
    expect(hasRecentShim('m-reset')).toBe(false);
  });
});

describe('validateRootModel — capability floor reroute', () => {
  const bad = { modelId: 'flash-lite', supportsTools: true, provider: 'gemini' };
  const good = { modelId: 'deepseek-default', supportsTools: true, provider: 'deepseek' };

  test('reroutes a recently-shimmed model to the tool-reliable default', async () => {
    // Spy the module factory so the selector's registry is fully controlled and
    // robust to the singleton being swapped by other suites in a full run.
    const fakeRegistry = {
      getModelForTopic: async () => bad,
      getDefaultModel: async () => good,
      getAllModels: async () => [bad, good],
    };
    const spy = vi.spyOn(modelRegistry, 'getModelRegistry').mockReturnValue(fakeRegistry as never);
    try {
      resetModelCapabilityStats();
      // Clean model is kept…
      expect(await new ModelSelector().selectForRootAgent()).toBe('flash-lite');
      // …but once it needs the shim, the floor reroutes to the default.
      recordModelToolCall('flash-lite', true);
      expect(await new ModelSelector().selectForRootAgent()).toBe('deepseek-default');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('root model binding selection', () => {
  const chatModel = { modelId: 'deepseek-chat', supportsTools: true, provider: 'deepseek' };
  const generalLaneModel = { modelId: 'gemini-general', supportsTools: true, provider: 'gemini' };
  const pinnedGeneralModel = { modelId: 'gemini-pinned', supportsTools: true, provider: 'gemini' };
  const sessionModel = { modelId: 'claude-session', supportsTools: true, provider: 'anthropic' };
  const defaultModel = { modelId: 'default-model', supportsTools: true, provider: 'openai' };

  function installRegistry() {
    const models = [chatModel, generalLaneModel, pinnedGeneralModel, sessionModel, defaultModel];
    return vi.spyOn(modelRegistry, 'getModelRegistry').mockReturnValue({
      getModelForTopic: async (topic: string) => {
        if (topic === 'everyday') return chatModel;
        if (topic === 'agents') return generalLaneModel;
        return null;
      },
      getModelByModelId: async (modelId: string) => models.find((model) => model.modelId === modelId) ?? null,
      getDefaultModel: async () => defaultModel,
      getAllModels: async () => models,
    } as never);
  }

  test('task turn honors the General expert model override instead of the chat lane', async () => {
    installRegistry();
    const selector = new ModelSelector(async () => ({
      modelPreference: pinnedGeneralModel.modelId,
      topic: 'agents',
    }));

    expect(await selector.selectForRootAgent(undefined, 'task')).toBe(pinnedGeneralModel.modelId);
  });

  test.each(['task', 'ambiguous', 'approval'] as const)('%s turn uses the General expert assigned lane when it has no model override', async (turnType) => {
    installRegistry();
    const selector = new ModelSelector(async () => ({ modelPreference: null, topic: 'agents' }));

    expect(await selector.selectForRootAgent(undefined, turnType)).toBe(generalLaneModel.modelId);
  });

  test.each(['write this as a plan', 'draft plan', 'generate plan', 'create docs', 'go ahead'])('classifier-to-model routing keeps "%s" on General', async (message) => {
    installRegistry();
    const selector = new ModelSelector(async () => ({ modelPreference: null, topic: 'agents' }));
    const classification = classifyMessage(message);
    expect(classification.type).not.toBe('casual');
    expect(await selector.selectForRootAgent(undefined, classification.type)).toBe(generalLaneModel.modelId);
  });

  test('task turn uses the root default when the General expert lane is unbound', async () => {
    installRegistry();
    const selector = new ModelSelector(async () => ({ modelPreference: null, topic: 'unbound-lane' }));

    expect(await selector.selectForRootAgent(undefined, 'task')).toBe(defaultModel.modelId);
  });

  test('task turn fails loudly when the General expert pins an unregistered model', async () => {
    installRegistry();
    const selector = new ModelSelector(async () => ({
      modelPreference: 'removed-model',
      topic: 'agents',
    }));

    await expect(selector.selectForRootAgent(undefined, 'task')).rejects.toThrow(
      'General expert is pinned to unregistered model "removed-model"',
    );
  });

  test('casual turn continues to use the conversation lane (chat folded into everyday)', async () => {
    installRegistry();
    const selector = new ModelSelector(async () => ({
      modelPreference: pinnedGeneralModel.modelId,
      topic: 'agents',
    }));

    expect(await selector.selectForRootAgent(undefined, 'casual')).toBe(chatModel.modelId);
  });

  test('session model override wins over the General expert on a task turn', async () => {
    installRegistry();
    setSessionModel('session-1', sessionModel.modelId);
    const selector = new ModelSelector(async () => ({
      modelPreference: pinnedGeneralModel.modelId,
      topic: 'agents',
    }));

    expect(await selector.selectForRootAgent('session-1', 'task')).toBe(sessionModel.modelId);
  });
});
