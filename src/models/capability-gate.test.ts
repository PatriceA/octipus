/**
 * Capability gate — the network-free static warnings. Small local models and
 * known-unreliable ids should be flagged; capable/cloud/unknown-size models
 * should not, so we never nag about a model that's probably fine.
 */
import { describe, expect, test } from 'bun:test';
import { staticCapabilityWarnings } from './capability-gate';

describe('staticCapabilityWarnings', () => {
  test('flags a small local (ollama) model', () => {
    const w = staticCapabilityWarnings({ provider: 'ollama', modelId: 'qwen2.5:7b' });
    expect(w.length).toBeGreaterThan(0);
    expect(w[0]).toMatch(/small local model/i);
  });

  test('does not flag a large local model', () => {
    expect(staticCapabilityWarnings({ provider: 'ollama', modelId: 'qwen2.5:32b' })).toEqual([]);
  });

  test('does not flag a cloud model (unknown size, not local)', () => {
    expect(staticCapabilityWarnings({ provider: 'openai', modelId: 'gpt-4o' })).toEqual([]);
    expect(staticCapabilityWarnings({ provider: 'anthropic', modelId: 'claude-3-opus' })).toEqual([]);
  });

  test('does not flag a small model on a non-local provider (no token cost surprise)', () => {
    // A 7B served by a cloud/openai-compat endpoint is not the local-reliability case.
    expect(staticCapabilityWarnings({ provider: 'openai', modelId: 'some-7b' })).toEqual([]);
  });

  test('prefers explicit metadata.paramCount over the tag', () => {
    // No size in the id, but metadata says 3B → small.
    const w = staticCapabilityWarnings({ provider: 'ollama', modelId: 'mymodel:latest', metadata: { paramCount: 3_000_000_000 } });
    expect(w.some((m) => /small local model/i.test(m))).toBe(true);
  });
});
