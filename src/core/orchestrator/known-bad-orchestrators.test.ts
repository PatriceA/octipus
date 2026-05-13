import { describe, expect, test } from 'bun:test';
import { checkOrchestratorCapability } from './known-bad-orchestrators';

describe('checkOrchestratorCapability', () => {
  test('flags qwen3.6:27b — observed failure on QA 2026-05-12', () => {
    const w = checkOrchestratorCapability('qwen3.6:27b');
    expect(w).not.toBeNull();
    expect(w?.modelId).toBe('qwen3.6:27b');
    expect(w?.reason).toContain('malformed tool-call');
  });

  test('flags qwen3.6:35b-a3b-q4_K_M — same family, quantized', () => {
    expect(checkOrchestratorCapability('qwen3.6:35b-a3b-q4_K_M')).not.toBeNull();
  });

  test('flags qwen3:8b — base Qwen3 family (observed 2026-05-12 14:27)', () => {
    expect(checkOrchestratorCapability('qwen3:8b')).not.toBeNull();
  });

  test('flags qwen3:14b — base Qwen3 family, larger size', () => {
    expect(checkOrchestratorCapability('qwen3:14b')).not.toBeNull();
  });

  test('case-insensitive match', () => {
    expect(checkOrchestratorCapability('Qwen3.6:7B-Instruct')).not.toBeNull();
    expect(checkOrchestratorCapability('QWEN3:8B')).not.toBeNull();
  });

  test('does not flag known-good models', () => {
    expect(checkOrchestratorCapability('gpt-5')).toBeNull();
    expect(checkOrchestratorCapability('claude-sonnet-4-6')).toBeNull();
    expect(checkOrchestratorCapability('gemini-3-flash-preview')).toBeNull();
    expect(checkOrchestratorCapability('deepseek-v4-flash')).toBeNull();
    // Other Qwen variants (different family) are out of scope.
    expect(checkOrchestratorCapability('qwen2.5:32b')).toBeNull();
    // qwen3-vl is a distinct family (dash separator, not colon).
    expect(checkOrchestratorCapability('qwen3-vl:8b')).toBeNull();
    expect(checkOrchestratorCapability('qwen3-vl:30b')).toBeNull();
  });
});
