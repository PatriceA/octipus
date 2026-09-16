import { describe, expect, test } from 'vitest';
import { claudeCodeConfig, codexCliConfig, execCli, glmCliConfig, kimiCliConfig } from './cli-provider';

/**
 * A prompt containing a newline cannot be passed as a positional argv on
 * Windows: execCli spawns with `shell: true`, and cmd.exe drops everything
 * from the newline on. The CLI then runs with NO prompt, answers from its
 * working directory, and exits 0 — indistinguishable from a real answer.
 *
 * Measured live 2026-09-16: the compaction summarizer (multi-line by
 * construction, bound to `cli/claude` here) came back with "No conversation
 * yet" plus a description of the repo the process was sitting in, while
 * compaction published that as a checkpoint and dropped 34 real turns.
 *
 * Two guarantees are locked in: the prompt-bearing tools deliver on stdin,
 * and execCli refuses a multi-line argv outright rather than hallucinating.
 */
describe('CLI prompt delivery', () => {
  test('execCli refuses a multi-line argument instead of silently losing it', async () => {
    await expect(execCli('claude', ['-p', 'line one\nline two']))
      .rejects.toThrow(/newline/i);
  });

  test('a single-line argument is still allowed', async () => {
    // Reaches spawn and fails on the bogus binary, not on the newline guard.
    await expect(execCli('definitely-not-a-real-binary-xyz', ['one line']))
      .rejects.not.toThrow(/newline/i);
  });

  test('prompt-bearing CLI tools take the prompt on stdin, never in argv', () => {
    for (const config of [claudeCodeConfig, codexCliConfig]) {
      expect(config.promptVia).toBe('stdin');
      // buildArgs is called with an empty prompt in stdin mode; no builder may
      // leave a prompt placeholder behind.
      const args = config.buildArgs('');
      expect(args).not.toContain('');
    }
  });

  test('codex reads stdin via the explicit `-` argument', async () => {
    expect(codexCliConfig.buildArgs('')).toContain('-');
  });

  test('the claude-compatible vendors (GLM, Kimi) inherit stdin delivery', () => {
    for (const config of [glmCliConfig, kimiCliConfig]) {
      expect(config.promptVia).toBe('stdin');
    }
  });
});
