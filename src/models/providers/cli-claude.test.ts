import { describe, expect, it } from 'vitest';
import { claudeCodeConfig } from './cli-provider';

describe('claudeCodeConfig.parseOutput totalTokens (C18)', () => {
  it('computes total from NESTED usage.* (not just top-level fields)', () => {
    // `claude --output-format json` reports usage nested. The old code summed
    // only the top-level input_tokens/output_tokens (absent here) → total 0
    // while input/output read the nested values → nonzero parts, zero total.
    const stdout = JSON.stringify({
      result: 'ok',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const r = claudeCodeConfig.parseOutput(stdout, Date.now() - 5);
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(50);
    expect(r.usage.totalTokens).toBe(150);
  });

  it('still reads top-level usage fields when present', () => {
    const stdout = JSON.stringify({ result: 'ok', input_tokens: 10, output_tokens: 20 });
    const r = claudeCodeConfig.parseOutput(stdout, Date.now());
    expect(r.usage.totalTokens).toBe(30);
  });

  it('falls back to plain text with zero usage', () => {
    const r = claudeCodeConfig.parseOutput('just text', Date.now());
    expect(r.content).toBe('just text');
    expect(r.usage.totalTokens).toBe(0);
  });
});
