/**
 * The harness itself: a machine that cannot run the PTY relay fails the suite
 * at once with a message naming what is missing, instead of crashing the
 * worker (no `python3`) or waiting out every `waitFor` (no `os.forkpty`).
 */
import { describe, expect, test } from 'vitest';
import { ptyRelayProblem, TuiHarness } from './harness';

describe('the PTY relay check', () => {
  test('a missing Python is named, and the harness refuses to start', async () => {
    expect(ptyRelayProblem('no-such-python-for-octipus-tests', 'linux')).toMatch(/not on PATH.*TUI_PTY_PYTHON/);
    await expect(TuiHarness.start('src/tui-pi/index.ts', 80, 24, [], { python: 'no-such-python-for-octipus-tests' }))
      .rejects.toThrow(/PTY relay .*not on PATH/);
  });

  test('a program that is not a Python with forkpty is refused with its own error', () => {
    // `false` runs and exits 1: a binary that exists but cannot be the relay.
    expect(ptyRelayProblem('false', 'linux')).toMatch(/cannot run the PTY relay.*exit 1/);
  });

  test('Windows is refused up front and pointed at WSL', () => {
    expect(ptyRelayProblem('python3', 'win32')).toMatch(/POSIX pseudo-terminal.*WSL/);
  });

  test.skipIf(process.platform === 'win32')('this machine can run the relay', () => {
    expect(ptyRelayProblem(process.env.TUI_PTY_PYTHON ?? 'python3')).toBeNull();
  });
});
