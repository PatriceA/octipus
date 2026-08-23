import { describe, expect, test } from 'vitest';
import {
  __setTopicConfigCacheForTest,
  applyTopicParamOverrides,
  getTopicConfig,
} from './topic-config';

describe('applyTopicParamOverrides', () => {
  const base = { model: 'm', temperature: 0.7, maxTokens: 4096 };

  test('null overrides leave base params untouched', () => {
    const out = applyTopicParamOverrides(base, { executorModel: null, temperature: null, maxTokens: null });
    expect(out.temperature).toBe(0.7);
    expect(out.maxTokens).toBe(4096);
  });

  test('temperature override applies, maxTokens left alone', () => {
    const out = applyTopicParamOverrides(base, { executorModel: null, temperature: 0.1, maxTokens: null });
    expect(out.temperature).toBe(0.1);
    expect(out.maxTokens).toBe(4096);
  });

  test('both overrides apply', () => {
    const out = applyTopicParamOverrides(base, { executorModel: null, temperature: 0, maxTokens: 1024 });
    expect(out.temperature).toBe(0);
    expect(out.maxTokens).toBe(1024);
  });

  test('temperature override of 0 is honored (not treated as falsy/absent)', () => {
    const out = applyTopicParamOverrides({ temperature: 0.9 }, { executorModel: null, temperature: 0, maxTokens: null });
    expect(out.temperature).toBe(0);
  });

  test('does not mutate the base object', () => {
    const input = { temperature: 0.7, maxTokens: 4096 };
    applyTopicParamOverrides(input, { executorModel: null, temperature: 0.2, maxTokens: 2048 });
    expect(input.temperature).toBe(0.7);
    expect(input.maxTokens).toBe(4096);
  });
});

describe('getTopicConfig (cache read)', () => {
  test('returns the cached config for a known topic', () => {
    __setTopicConfigCacheForTest({
      agents: { executorModel: 'fast-model', temperature: 0.2, maxTokens: 8192 },
    });
    const cfg = getTopicConfig('agents');
    expect(cfg.executorModel).toBe('fast-model');
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.maxTokens).toBe(8192);
  });

  test('retired topic names read the canonical lane row (aliasing)', () => {
    __setTopicConfigCacheForTest({
      agents: { executorModel: 'fast-model', temperature: 0.2, maxTokens: 8192 },
    });
    // 'coding' retired → canonicalizes to 'agents'
    expect(getTopicConfig('coding').executorModel).toBe('fast-model');
  });

  test('returns all-null for an unconfigured topic', () => {
    __setTopicConfigCacheForTest({});
    const cfg = getTopicConfig('research');
    expect(cfg).toEqual({ executorModel: null, temperature: null, maxTokens: null });
  });

  test('undefined topic → all-null (no override)', () => {
    __setTopicConfigCacheForTest({ agents: { executorModel: 'x', temperature: null, maxTokens: null } });
    expect(getTopicConfig(undefined)).toEqual({ executorModel: null, temperature: null, maxTokens: null });
  });
});
