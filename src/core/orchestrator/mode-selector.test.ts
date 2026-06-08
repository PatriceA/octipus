/**
 * Orchestrator mode selector — param derivation + threshold banding. The mode
 * keys off model SIZE (metadata or tag), never model names (house rule #2).
 */
import { describe, expect, test } from 'bun:test';
import { deriveParamCount, paramCountToMode, resolveOrchestratorMode } from './mode-selector';

const THRESHOLDS = {
  routerSmallModelMaxParams: 10_000_000_000,
  liteModelMaxParams: 24_000_000_000,
};

describe('deriveParamCount', () => {
  test.each([
    ['qwen2.5:32b-instruct-q4_K_M', 32_000_000_000],
    ['llama3.1:8b-instruct-q4_K_M', 8_000_000_000],
    ['llama3.2:1b-instruct-q4_K_M', 1_000_000_000],
    ['qwen2.5:14b-instruct-q4_K_M', 14_000_000_000],
    ['llama3.3:70b-instruct-q4_K_M', 70_000_000_000],
    ['qwen2.5-coder:1.5b-instruct-q4_K_M', 1_500_000_000],
  ])('parses %s from the tag', (modelId, expected) => {
    expect(deriveParamCount(modelId)).toBe(expected);
  });

  test('prefers explicit metadata.paramCount over the tag', () => {
    expect(deriveParamCount('weird-name', { paramCount: 13_000_000_000 })).toBe(13_000_000_000);
  });

  test('returns undefined when no size is determinable', () => {
    expect(deriveParamCount('gpt-4o')).toBeUndefined();
    expect(deriveParamCount('claude-3-opus')).toBeUndefined();
  });
});

describe('paramCountToMode', () => {
  test.each([
    [7_000_000_000, 'router'],
    [8_000_000_000, 'router'],
    [9_999_999_999, 'router'],
    [10_000_000_000, 'lite'],
    [14_000_000_000, 'lite'],
    [23_999_999_999, 'lite'],
    [24_000_000_000, 'full'],
    [32_000_000_000, 'full'],
    [70_000_000_000, 'full'],
  ])('%d params → %s', (params, mode) => {
    expect(paramCountToMode(params, THRESHOLDS)).toBe(mode);
  });
});

describe('resolveOrchestratorMode', () => {
  const cfg = { mode: 'auto' as const, ...THRESHOLDS };

  test('auto: derives from model size', () => {
    expect(resolveOrchestratorMode({ modelId: 'qwen2.5:7b' }, cfg)).toBe('router');
    expect(resolveOrchestratorMode({ modelId: 'qwen2.5:14b' }, cfg)).toBe('lite');
    expect(resolveOrchestratorMode({ modelId: 'qwen2.5:32b' }, cfg)).toBe('full');
  });

  test('auto: unknown size falls back to lite', () => {
    expect(resolveOrchestratorMode({ modelId: 'gpt-4o' }, cfg)).toBe('lite');
  });

  test('explicit mode pins regardless of size', () => {
    expect(resolveOrchestratorMode({ modelId: 'qwen2.5:7b' }, { ...cfg, mode: 'full' })).toBe('full');
    expect(resolveOrchestratorMode({ modelId: 'qwen2.5:70b' }, { ...cfg, mode: 'router' })).toBe('router');
  });
});
