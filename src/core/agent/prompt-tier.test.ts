/**
 * Prompt-tier selector — param derivation + threshold banding. The tier
 * keys off model SIZE (metadata or tag), never model names (house rule #2).
 */
import { describe, expect, test } from 'vitest';
import { deriveParamCount, paramCountToTier, resolvePromptTier } from './prompt-tier';

const THRESHOLDS = {
  smallModelMaxParams: 10_000_000_000,
  liteModelMaxParams: 30_000_000_000,
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

  test('expands MoE tags to the aggregate, not per-expert', () => {
    // 8 × 7B = 56B → must not be mistaken for a 7B (small) model.
    expect(deriveParamCount('mixtral:8x7b-instruct-v0.1-q4_K_M')).toBe(56_000_000_000);
    expect(paramCountToTier(deriveParamCount('mixtral:8x7b') as number, THRESHOLDS)).toBe('full');
  });

  test('prefers explicit metadata.paramCount over the tag', () => {
    expect(deriveParamCount('weird-name', { paramCount: 13_000_000_000 })).toBe(13_000_000_000);
  });

  test('returns undefined when no size is determinable', () => {
    expect(deriveParamCount('gpt-4o')).toBeUndefined();
    expect(deriveParamCount('claude-3-opus')).toBeUndefined();
  });
});

describe('paramCountToTier', () => {
  test.each([
    // Below the small-model threshold is still `lite` — the router tier it used
    // to return was a control-flow branch, and Phase 9 deleted it.
    [7_000_000_000, 'lite'],
    [8_000_000_000, 'lite'],
    [9_999_999_999, 'lite'],
    [10_000_000_000, 'lite'],
    [14_000_000_000, 'lite'],
    [23_999_999_999, 'lite'],
    [27_000_000_000, 'lite'],          // a 27b dense local model
    [29_999_999_999, 'lite'],
    [30_000_000_000, 'full'],
    [32_000_000_000, 'full'],
    [70_000_000_000, 'full'],
  ] as const)('%d params → %s', (params, mode) => {
    expect(paramCountToTier(params, THRESHOLDS)).toBe(mode);
  });
});

describe('resolvePromptTier', () => {
  const cfg = { mode: 'auto' as const, ...THRESHOLDS };

  test('auto: derives from model size', () => {
    expect(resolvePromptTier({ modelId: 'qwen2.5:7b' }, cfg)).toBe('lite');
    expect(resolvePromptTier({ modelId: 'qwen2.5:14b' }, cfg)).toBe('lite');
    expect(resolvePromptTier({ modelId: 'qwen2.5:32b' }, cfg)).toBe('full');
  });

  test('auto: unknown size and unknown family with no provider falls back to lite', () => {
    expect(resolvePromptTier({ modelId: 'my-custom-model' }, cfg)).toBe('lite');
  });

  test('auto: a hosted frontier family behind a proxy or custom endpoint → full', () => {
    // Claude or GPT through LiteLLM used to run a lite root capped at 8 iterations.
    for (const [modelId, provider] of [
      ['claude-sonnet-5-5', 'litellm'],
      ['anthropic/claude-opus-5', 'custom-anthropic'],
      ['gpt-5.4', 'custom-openai'],
      ['openai/o3-mini', 'litellm'],
      ['gemini-3-pro', 'litellm'],
      ['deepseek-v4-flash', 'custom-openai'],
      ['kimi-k2-thinking', 'litellm'],
      ['gpt-4o', undefined],
    ] as const) {
      expect(resolvePromptTier({ modelId, provider }, cfg), `${provider}/${modelId}`).toBe('full');
    }
  });

  test('auto: open-weight lookalikes and local runners do not get the family promotion', () => {
    expect(resolvePromptTier({ modelId: 'gpt-oss', provider: 'litellm' }, cfg)).toBe('lite');
    expect(resolvePromptTier({ modelId: 'gemma3', provider: 'custom-openai' }, cfg)).toBe('lite');
    expect(resolvePromptTier({ modelId: 'deepseek-r1', provider: 'ollama' }, cfg)).toBe('lite');
    expect(resolvePromptTier({ modelId: 'deepseek-v3', provider: 'ollama' }, cfg)).toBe('lite');
    // A parsed size still wins over the family.
    expect(resolvePromptTier({ modelId: 'claude-distill-7b', provider: 'litellm' }, cfg)).toBe('lite');
  });

  test('auto: unknown size on a cloud provider → full, not lite (RC7)', () => {
    // gpt-4o / claude-* have no `Nb` tag; they must not be throttled to lite.
    expect(resolvePromptTier({ modelId: 'gpt-4o', provider: 'openai' }, cfg)).toBe('full');
    expect(resolvePromptTier({ modelId: 'claude-sonnet-5', provider: 'anthropic' }, cfg)).toBe('full');
    expect(resolvePromptTier({ modelId: 'some-cli-model', provider: 'cli' }, cfg)).toBe('full');
  });

  test('auto: unknown size on a local-weight provider stays lite', () => {
    // A local runner with an unparseable id is the genuinely risky case.
    expect(resolvePromptTier({ modelId: 'my-custom-model', provider: 'ollama' }, cfg)).toBe('lite');
  });

  test('auto: explicit metadata.paramCount wins over an unparseable id', () => {
    // RC7 populates paramCount at install so this path is the common one.
    expect(
      resolvePromptTier({ modelId: 'my-model', metadata: { paramCount: 32e9 }, provider: 'ollama' }, cfg),
    ).toBe('full');
  });

  test('explicit mode pins regardless of size', () => {
    expect(resolvePromptTier({ modelId: 'qwen2.5:7b' }, { ...cfg, mode: 'full' })).toBe('full');
    expect(resolvePromptTier({ modelId: 'qwen2.5:70b' }, { ...cfg, mode: 'lite' })).toBe('lite');
  });
});
