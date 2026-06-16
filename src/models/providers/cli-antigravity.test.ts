import { describe, expect, it } from 'bun:test';
import { antigravityConfig } from './cli-provider';

describe('antigravityConfig (replaces Gemini CLI)', () => {
  it('drives the agy binary and keeps cli/gemini patterns for backward-compat routing', () => {
    expect(antigravityConfig.name).toBe('Antigravity');
    expect(antigravityConfig.binaryPath).toBe('agy');
    // Existing cli/gemini model rows must still route here.
    expect(antigravityConfig.modelPatterns).toContain('cli/gemini');
    expect(antigravityConfig.modelPatterns).toContain('cli/antigravity');
    expect(antigravityConfig.modelPatterns).toContain('cli/agy');
    expect(antigravityConfig.bufferOutput).toBe(true);
    expect(antigravityConfig.modelFlag).toBe('--model');
    expect(antigravityConfig.quotaProvider).toBe('antigravity');
  });

  it('buildArgs runs --print plain-text mode with auto-approve', () => {
    const args = antigravityConfig.buildArgs('hello world');
    expect(args).toContain('--dangerously-skip-permissions');
    const p = args.indexOf('--print');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(args[p + 1]).toBe('hello world');
  });

  it('parseOutput returns the trimmed plain-text stdout (no JSON envelope)', () => {
    const r = antigravityConfig.parseOutput('  The answer is 42.\n', Date.now() - 5);
    expect(r.content).toBe('The answer is 42.');
    expect(r.model).toBe('cli/antigravity');
    // agy reports no usage in print mode.
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('detects quota / rate-limit errors', () => {
    expect(antigravityConfig.isQuotaError('RESOURCE_EXHAUSTED: quota exceeded')).toBe(true);
    expect(antigravityConfig.isQuotaError('429 rate limit')).toBe(true);
    expect(antigravityConfig.isQuotaError('ok')).toBe(false);
  });
});
