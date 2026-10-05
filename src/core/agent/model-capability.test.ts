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

/** The selected model's provider id (the selector also returns the row name). */
async function selectId(selector: ModelSelector, ...args: Parameters<ModelSelector['selectForRootAgent']>): Promise<string> {
  return (await selector.selectForRootAgent(...args)).modelId;
}

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
  const bad = { modelId: 'flash-lite', name: 'flash-lite', supportsTools: true, provider: 'gemini' };
  const good = { modelId: 'deepseek-default', name: 'deepseek-default', supportsTools: true, provider: 'deepseek' };

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
      // Routed, so the lane answers rather than the default — otherwise this
      // asserts the fallback and never exercises the floor at all.
      const routing = { message: 'hello', classification: classifyMessage('hello') };
      // Clean model is kept…
      expect(await selectId(new ModelSelector(), undefined, 'casual', routing)).toBe('flash-lite');
      // …but once it needs the shim, the floor reroutes to the default.
      recordModelToolCall('flash-lite', true);
      expect(await selectId(new ModelSelector(), undefined, 'casual', routing)).toBe('deepseek-default');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('root model binding selection', () => {
  const chatModel = { modelId: 'deepseek-chat', name: 'deepseek-chat', supportsTools: true, provider: 'deepseek', isEnabled: true };
  const buildLaneModel = { modelId: 'gemini-build', name: 'gemini-build', supportsTools: true, provider: 'gemini', isEnabled: true };
  const pinnedGeneralModel = { modelId: 'gemini-pinned', name: 'gemini-pinned', supportsTools: true, provider: 'gemini', isEnabled: true };
  const sessionModel = { modelId: 'claude-session', name: 'claude-session', supportsTools: true, provider: 'anthropic', isEnabled: true };
  const defaultModel = { modelId: 'default-model', name: 'default-model', supportsTools: true, provider: 'openai', isEnabled: true };

  function installRegistry() {
    const models = [chatModel, buildLaneModel, pinnedGeneralModel, sessionModel, defaultModel];
    return vi.spyOn(modelRegistry, 'getModelRegistry').mockReturnValue({
      getModelForTopic: async (topic: string) => {
        if (topic === 'everyday') return chatModel;
        if (topic === 'build') return buildLaneModel;
        return null;
      },
      getModelByModelId: async (modelId: string) => models.find((model) => model.modelId === modelId) ?? null,
      getModelVisibleTo: async (name: string) => models.find((model) => model.name === name) ?? null,
      getModelByModelIdVisibleTo: async (modelId: string) => models.find((model) => model.modelId === modelId) ?? null,
      getUserBinding: async () => null,
      getDefaultModel: async () => defaultModel,
      getAllModels: async () => models,
    } as never);
  }

  test('a coding request routes to the build lane', async () => {
    installRegistry();
    const message = 'implement the retry logic in the client';
    expect(await selectId(new ModelSelector(), undefined, 'task', {
      message, classification: classifyMessage(message),
    })).toBe(buildLaneModel.modelId);
  });

  test.each(['write this as a plan', 'draft plan', 'generate plan', 'create docs', 'go ahead'])(
    'a request with nothing dear about it stays on everyday: "%s"', async (message) => {
      installRegistry();
      const classification = classifyMessage(message);
      expect(await selectId(new ModelSelector(), undefined, classification.type, {
        message, classification,
      })).toBe(chatModel.modelId);
    });

  test('an unbound lane falls through to the default model rather than failing', async () => {
    // An operator who never split their lanes still has a working install.
    vi.spyOn(modelRegistry, 'getModelRegistry').mockReturnValue({
      getModelForTopic: async () => null,
      getModelByModelId: async () => null,
      getDefaultModel: async () => defaultModel,
      getAllModels: async () => [defaultModel],
    } as never);
    const message = 'implement the retry logic';
    expect(await selectId(new ModelSelector(), undefined, 'task', {
      message, classification: classifyMessage(message),
    })).toBe(defaultModel.modelId);
  });

  test('with no request to route, the default model answers', async () => {
    installRegistry();
    expect(await selectId(new ModelSelector(), undefined, 'task')).toBe(defaultModel.modelId);
  });

  test('a casual turn lands on everyday, because that is what a casual message is', async () => {
    installRegistry();
    const message = 'hey, how are you?';
    expect(await selectId(new ModelSelector(), undefined, 'casual', {
      message, classification: classifyMessage(message),
    })).toBe(chatModel.modelId);
  });

  test('the session model override beats the routed lane', async () => {
    // The one rule above routing: an explicit choice by the user wins. A
    // classification is a guess and must never override a decision.
    installRegistry();
    setSessionModel('session-1', 'user-1', sessionModel.name);
    const selector = new ModelSelector();

    const message = 'implement the retry logic';
    expect(await selectId(selector, 'session-1', 'task', {
      message, classification: classifyMessage(message),
    }, { userId: 'user-1' })).toBe(sessionModel.modelId);
    // Another member of the same session does not get that override.
    expect(await selectId(selector, 'session-1', 'task', {
      message, classification: classifyMessage(message),
    }, { userId: 'user-2' })).toBe(buildLaneModel.modelId);
  });
});
