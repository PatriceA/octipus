/**
 * No sandboxed command reaches the terminal Octipus runs in.
 *
 * A process that can open the controlling terminal can push keystrokes into
 * it with the TIOCSTI ioctl: whatever reads that terminal next (the shell
 * Octipus was started from) runs them, outside any sandbox. So:
 *
 * - bwrap runs the command in a new session (`--new-session`): no
 *   controlling terminal, `/dev/tty` answers ENXIO;
 * - firejail drops every capability, sets no_new_privs and never exposes
 *   $HOME (the command is spawned detached, so it has no terminal either);
 * - the sandbox-exec profile allows nothing on /dev/tty.
 *
 * The end-to-end part runs a wrapped command inside a pseudo-terminal
 * (`script`) and checks that it cannot open /dev/tty and that a TIOCSTI
 * injection never reaches the outer shell. Skipped without bwrap, `script`
 * or python3 (the probe), or where bwrap cannot start a sandbox.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  _forceSandboxRunnerForTests,
  _resetSandboxDetectionForTests,
  buildSeatbeltProfile,
  detectRunner,
  runnerProblem,
  wrapCommand,
} from '@/security/shell-sandbox';

afterEach(() => _resetSandboxDetectionForTests());

const workspace = mkdtempSync(join(tmpdir(), 'octipus-tty-'));

describe('runner flags', () => {
  test('bwrap starts the command in a new session', () => {
    _forceSandboxRunnerForTests('bwrap', '/usr/bin/bwrap');
    const out = wrapCommand(['true'], { workspaceRoot: workspace, mode: 'required' });
    try {
      const flags = out.argv.slice(0, out.argv.indexOf('--'));
      expect(flags).toContain('--new-session');
      // The private /dev stays; no host device node is bound in.
      expect(flags).toContain('--dev');
      expect(flags).not.toContain('--dev-bind');
    } finally { out.cleanup(); }
  });

  test('firejail drops capabilities, sets no_new_privs and hides $HOME', () => {
    _forceSandboxRunnerForTests('firejail', '/usr/bin/firejail');
    const outside = wrapCommand(['true'], { workspaceRoot: '/srv/octipus/ws', mode: 'required', extraReadOnly: ['/opt/x'] });
    const flags = outside.argv.slice(0, outside.argv.indexOf('--'));
    for (const f of ['--noroot', '--caps.drop=all', '--nonewprivs']) expect(flags).toContain(f);
    // Nothing under $HOME whitelisted when the runtime dirs do not exist: an empty private home.
    const whitelistedInHome = flags.some((f) => f.startsWith(`--whitelist=${homedir()}/`));
    expect(flags.includes('--private')).toBe(!whitelistedInHome);
    // A workspace under $HOME is whitelisted, which hides the rest of $HOME; the workspace stays reachable.
    const inside = wrapCommand(['true'], { workspaceRoot: join(homedir(), 'octipus-ws'), mode: 'required' });
    const insideFlags = inside.argv.slice(0, inside.argv.indexOf('--'));
    expect(insideFlags).toContain(`--whitelist=${join(homedir(), 'octipus-ws')}`);
    expect(insideFlags).not.toContain('--private');
  });

  test('the sandbox-exec profile allows nothing on /dev/tty', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: '/srv/ws' }, { scratch: '/private/tmp/x', runtimeDirs: [], cliPaths: [] });
    expect(profile).not.toContain('/dev/tty');
    expect(profile).toContain('(literal "/dev/null")');
  });
});

const bwrap = detectRunner();
const usable = process.platform === 'linux' && bwrap?.runner === 'bwrap' && runnerProblem(bwrap) === null
  && existsSync('/usr/bin/script') && spawnSync('python3', ['-c', 'import termios'], { stdio: 'ignore' }).status === 0;

/** Run `argv` in a pseudo-terminal: `script` gives the outer shell a terminal, as an interactive start of Octipus has. */
function inPty(shellLine: string): string {
  const r = spawnSync('/usr/bin/script', ['-qec', shellLine, '/dev/null'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return `${r.stdout}${r.stderr}`;
}

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!usable)('end to end, bwrap in a terminal', () => {
  test('the wrapped command cannot open /dev/tty (ENXIO)', () => {
    const probe = 'import os\ntry:\n  os.open("/dev/tty", os.O_RDWR); print("TTY-OPENED")\nexcept OSError as e: print("TTY-ERRNO", e.errno)';
    const out = wrapCommand(['python3', '-c', probe], { workspaceRoot: workspace, mode: 'required' });
    try {
      const text = inPty(out.argv.map(quote).join(' '));
      expect(text).toContain('TTY-ERRNO 6');
      expect(text).not.toContain('TTY-OPENED');
    } finally { out.cleanup(); }
  });

  test('a TIOCSTI injection does not reach the outer shell', () => {
    const inject = [
      'import fcntl, termios, os',
      'for path in ["/dev/tty", "/proc/self/fd/0", "/proc/self/fd/1", "/proc/self/fd/2"]:',
      '  try:',
      '    fd = os.open(path, os.O_RDWR)',
      '    for c in "echo INJECTED-BY-SANDBOX\\n": fcntl.ioctl(fd, termios.TIOCSTI, c.encode())',
      '  except OSError: pass',
    ].join('\n');
    const out = wrapCommand(['python3', '-c', inject], { workspaceRoot: workspace, mode: 'required' });
    try {
      // Injected keystrokes land in the terminal's input, and its line discipline echoes them to its output,
      // which `script` hands back: the marker shows up there if any keystroke got through. The command's own
      // output goes to /dev/null, so nothing else can print it.
      const text = inPty(`${out.argv.map(quote).join(' ')} </dev/null >/dev/null 2>&1; echo OUTER-DONE`);
      expect(text).toContain('OUTER-DONE');
      expect(text).not.toContain('INJECTED-BY-SANDBOX');
    } finally { out.cleanup(); }
  });
});
