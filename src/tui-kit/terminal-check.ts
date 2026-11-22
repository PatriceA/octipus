/**
 * Whether this process has a terminal the full-screen clients can draw on.
 *
 * Both clients address the cursor, switch to the alternate screen and read
 * keys in raw mode. Without a terminal (output piped to a file, input from a
 * pipe) or on one that declares it cannot move the cursor (`TERM=dumb`: an
 * Emacs shell buffer, some CI logs) they used to start anyway and fill the
 * output with escape sequences. They now refuse before writing anything, and
 * say why.
 *
 * Only `dumb` is refused by name: pi-tui writes ANSI sequences without
 * consulting terminfo, and every other TERM in use (xterm*, screen*, tmux*,
 * linux, vt220 and up, Windows Terminal with TERM unset) understands them.
 */
export interface TerminalFacts {
  term: string | undefined;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export function currentTerminal(): TerminalFacts {
  return { term: process.env.TERM, stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true };
}

/** A message for the user when `command` cannot run here, else null. */
export function terminalProblem(command: string, facts: TerminalFacts = currentTerminal()): string | null {
  const missing = [!facts.stdinIsTTY && 'input', !facts.stdoutIsTTY && 'output'].filter(Boolean);
  if (missing.length) {
    return `${command} draws a full-screen interface and needs a terminal, but its ${missing.join(' and ')} `
      + `${missing.length > 1 ? 'are' : 'is'} not one (piped or redirected). Run it directly in a terminal.`;
  }
  if (facts.term === 'dumb') {
    return `${command} needs a terminal that can move the cursor, and TERM is "dumb" (an Emacs shell buffer, a CI log). `
      + 'Run it in a terminal emulator, or in Emacs under vterm or ansi-term; if your terminal is capable, set TERM to match it (xterm-256color).';
  }
  return null;
}
