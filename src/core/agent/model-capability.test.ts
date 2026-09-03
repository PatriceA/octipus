/**
 * Phase 2.1 capability floor — per-model shim-usage stats + the
 * validateOrchestratorModel reroute they drive.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as modelRegistry from '@/models/model-registry';
import {
  hasRecentShim,
  recordModelToolCall,
  resetModelCapabilityStats,
} from './model-capability';
import { ModelSelector } from './model-selector';

afterEach(() => {
  resetModelCapabilityStats();
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

describe('validateOrchestratorModel — capability floor reroute', () => {
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
      expect(await new ModelSelector().selectForOrchestration()).toBe('flash-lite');
      // …but once it needs the shim, the floor reroutes to the default.
      recordModelToolCall('flash-lite', true);
      expect(await new ModelSelector().selectForOrchestration()).toBe('deepseek-default');
    } finally {
      spy.mockRestore();
    }
  });
});
