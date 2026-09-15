import { describe, expect, it } from 'vitest';
import { windowsShellQuote } from './cli-provider';

/**
 * `windowsShellQuote` is the single shared Windows `shell:true` quoting
 * rule for every spawn call site: `execCli` (CLI completions + compaction,
 * `cli-session-compact.ts`) and `CLIAgentWorker`'s own agent-process spawn
 * (`cli-agent-worker.ts`). One implementation, one test — covers both
 * consumers. Tests the quoting logic directly — no real shell spawned —
 * per MSVCRT/CommandLineToArgvW convention: quote on whitespace/embedded-
 * quote, escape embedded quotes, double a run of trailing backslashes
 * before the closing quote.
 */
describe('windowsShellQuote', () => {
  it('wraps a plain multi-word argument in quotes, unchanged inside', () => {
    expect(windowsShellQuote('/compact focus on the migration')).toBe('"/compact focus on the migration"');
  });

  it('passes an argument with no whitespace or quote through unchanged', () => {
    expect(windowsShellQuote('--resume')).toBe('--resume');
  });

  it('escapes a literal embedded quote', () => {
    expect(windowsShellQuote('say "hi" now')).toBe('"say \\"hi\\" now"');
  });

  it('doubles a single trailing backslash before the closing quote', () => {
    // A naive `"${value}"` would let this backslash escape the closing
    // quote instead of terminating the argument. The mid-string backslash
    // (not adjacent to a quote or the end) is left as a single backslash —
    // only a run immediately before a quote gets doubled.
    expect(windowsShellQuote('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"');
  });

  it('doubles two trailing backslashes (to four) before the closing quote', () => {
    expect(windowsShellQuote('C:\\Program Files\\\\')).toBe('"C:\\Program Files\\\\\\\\"');
  });
});
