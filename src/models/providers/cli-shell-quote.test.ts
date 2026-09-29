import { describe, expect, it } from 'vitest';
import { assertWindowsCmdLineFits, isWindowsBatch, windowsShellQuote } from './cli-provider';

/**
 * `windowsShellQuote` is the single shared Windows `shell:true` quoting
 * rule for every spawn call site: `execCli` (one-shot CLI completions) and
 * `CLIAgentWorker`'s own agent-process spawn
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

describe('assertWindowsCmdLineFits', () => {
  const huge = 'x'.repeat(33_000);
  it('fails with an actionable error instead of ENAMETOOLONG on Windows', () => {
    expect(() => assertWindowsCmdLineFits('agy', ['--print', huge], 'win32')).toThrow(/Windows limit of 32767/);
  });
  it('passes a normal command line, and anything off Windows', () => {
    expect(() => assertWindowsCmdLineFits('agy', ['--print', 'hi'], 'win32')).not.toThrow();
    expect(() => assertWindowsCmdLineFits('agy', ['--print', huge], 'linux')).not.toThrow();
  });
});

// Live-verified 2026-09-29 by spawning an npm-style .cmd shim and node.exe with shell:true:
// both received every argument below intact; before, a `|` after an embedded quote became a pipe.
describe('windowsShellQuote — cmd.exe metacharacters', () => {
  it('escapes metacharacters cmd sees as unquoted, once for an exe and twice for a batch shim', () => {
    expect(windowsShellQuote('a|b')).toBe('a^|b');
    expect(windowsShellQuote('a|b', true)).toBe('a^^^|b');
    expect(windowsShellQuote('x & y')).toBe('"x & y"');
  });

  it('keeps a `|` after an escaped quote from turning into a pipe', () => {
    // cmd flips quote state on the `\"`, so the `|` is outside quotes in its view.
    expect(windowsShellQuote('m = "a|b"')).toBe('"m = \\"a^|b\\""');
  });

  it('tells a .cmd shim from an exe', () => {
    expect(isWindowsBatch('C:/bin/codex.cmd')).toBe(true);
    expect(isWindowsBatch('C:/bin/node.exe')).toBe(false);
  });
});
