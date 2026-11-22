import { describe, expect, test } from 'vitest';
import { terminalProblem } from './terminal-check';

const tty = { term: 'xterm-256color', stdinIsTTY: true, stdoutIsTTY: true };

describe('terminalProblem', () => {
  test('a terminal that moves the cursor is fine, whatever it calls itself', () => {
    for (const term of ['xterm-256color', 'screen-256color', 'tmux-256color', 'linux', 'vt220', undefined]) {
      expect(terminalProblem('octi tui', { ...tty, term })).toBeNull();
    }
  });

  test('TERM=dumb is refused with what to do instead', () => {
    expect(terminalProblem('octi edit', { ...tty, term: 'dumb' })).toMatch(/^octi edit needs a terminal that can move the cursor.*vterm/);
  });

  test('piped output or input is refused, naming which', () => {
    expect(terminalProblem('octi tui', { ...tty, stdoutIsTTY: false })).toMatch(/its output is not one/);
    expect(terminalProblem('octi tui', { ...tty, stdinIsTTY: false })).toMatch(/its input is not one/);
    expect(terminalProblem('octi tui', { ...tty, stdinIsTTY: false, stdoutIsTTY: false })).toMatch(/its input and output are not one/);
  });
});
