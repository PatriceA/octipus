/**
 * Shell sandbox — Phase 3e multi-user.
 *
 * Wraps shell-tool spawn calls in a process-level sandbox so a
 * compromised or runaway agent can't read/write outside the
 * configured workspace. Two backends supported:
 *
 *   - bubblewrap (`bwrap`) — Linux-only, no setuid required (uses
 *     user namespaces). Preferred when available.
 *   - firejail — also Linux-only, requires setuid binary on most
 *     distros. Fallback.
 *
 * Activation is gated by `config.security.shellSandbox`:
 *
 *   - `'off'` (default) — no wrapping; behavior identical to
 *     pre-Phase-3e. Single-user installs and developers without a
 *     sandbox runner stay on this.
 *   - `'auto'` — wrap when a runner is detected on PATH; fall back
 *     to running directly when not.
 *   - `'required'` — wrap when available; **refuse** to run shell
 *     commands when no runner is found. Operational deployments use
 *     this once they've confirmed bwrap/firejail is installed.
 *
 * The wrapper builds an argv: bwrap/firejail flags first, then the
 * original command. Returns the wrapped argv; the caller still
 * spawns it themselves so we don't take over their stdio plumbing.
 *
 * Profile (bubblewrap):
 *   - read-only bind /usr /lib /lib64 /bin /etc /opt
 *   - read-write bind the workspace root
 *   - read-write bind /tmp/<unique> for transient writes
 *   - drop network namespace by default (--unshare-net)
 *   - new pid + uts namespaces for isolation
 *
 * The profile is conservative — it errs on the side of breaking
 * commands that need the network rather than leaving an escape
 * hatch open. Operators who need the network can pass
 * `allowNetwork: true` in the wrapCommand options (which the shell
 * tool's `useShell` / `unsafe` paths set when the user has opted in
 * to a less-restrictive run).
 */
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';

export type SandboxRunner = 'bwrap' | 'firejail';
export type SandboxMode = 'off' | 'auto' | 'required';

export interface WrapOptions {
  /** Workspace root that should be writable inside the sandbox. */
  workspaceRoot: string;
  /** Allow network access. Defaults to `false` — sandboxed shells
   *  typically don't need network. */
  allowNetwork?: boolean;
  /** Additional read-only paths to expose (e.g. /Users for macOS-style
   *  layouts). Caller's responsibility. */
  extraReadOnly?: string[];
  /** Additional read-write paths. Use sparingly; each one widens
   *  the blast radius of a compromise. */
  extraReadWrite?: string[];
}

export interface WrapResult {
  /** True when the original argv was wrapped; false when the sandbox
   *  is `off` or no runner is available in `auto` mode. */
  wrapped: boolean;
  /** The runner that was selected, or null when not wrapped. */
  runner: SandboxRunner | null;
  /** The argv to spawn — wrapped or original. */
  argv: string[];
  /** Cleanup callback for any temp resources the wrap created
   *  (e.g. a per-spawn /tmp directory). Always safe to call. */
  cleanup: () => void;
}

/**
 * Detect which sandbox runner is available on PATH. Result is
 * cached across calls — we don't expect operators to install/remove
 * sandbox runners while the server is running.
 *
 * Lookup is cheap: check a small set of well-known paths. We
 * deliberately don't shell out to `which` because the whole point
 * of this module is to AVOID running uncontrolled shell commands.
 */
const KNOWN_BWRAP = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];
const KNOWN_FIREJAIL = ['/usr/bin/firejail', '/usr/local/bin/firejail', '/bin/firejail'];

let detectedCache: { runner: SandboxRunner; binary: string } | null | undefined;

export function detectRunner(): { runner: SandboxRunner; binary: string } | null {
  if (detectedCache !== undefined) return detectedCache;
  for (const path of KNOWN_BWRAP) {
    if (existsSync(path)) {
      detectedCache = { runner: 'bwrap', binary: path };
      return detectedCache;
    }
  }
  for (const path of KNOWN_FIREJAIL) {
    if (existsSync(path)) {
      detectedCache = { runner: 'firejail', binary: path };
      return detectedCache;
    }
  }
  detectedCache = null;
  return null;
}

/** Test-only: reset the runner cache so a test can force re-detection. */
export function _resetSandboxDetectionForTests(): void {
  detectedCache = undefined;
}

/** Read the configured sandbox mode. Defaults to 'off' if config
 *  isn't loaded. */
export function getSandboxMode(): SandboxMode {
  try {
    const v = getConfig().security.shellSandbox;
    if (v === 'auto' || v === 'required') return v;
    return 'off';
  } catch {
    return 'off';
  }
}

/**
 * Build the argv flags for bubblewrap. Reasonably conservative
 * profile — read-only OS dirs, read-write workspace + per-spawn
 * /tmp scratch, no network unless asked.
 */
function buildBwrapArgs(binary: string, options: WrapOptions, scratch: string): string[] {
  const args: string[] = [
    binary,
    // New mount namespace + tmp root.
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--unshare-cgroup-try',
    // Default: drop network. Override below.
    ...(options.allowNetwork ? [] : ['--unshare-net']),
    // Read-only OS dirs the typical shell command needs.
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/etc', '/etc',
    '--ro-bind-try', '/opt', '/opt',
    // Per-spawn scratch (the legacy /tmp/assistant- prefix lives here).
    // Bound BEFORE the workspace so that workspaces under /tmp aren't
    // shadowed by this overlay — order matters in bwrap.
    '--bind', scratch, '/tmp',
    // Read-write the workspace root.
    '--bind', options.workspaceRoot, options.workspaceRoot,
    // Standard pseudo filesystems.
    '--proc', '/proc',
    '--dev', '/dev',
    // Make the cwd inside the workspace.
    '--chdir', options.workspaceRoot,
  ];
  for (const p of options.extraReadOnly ?? []) {
    args.push('--ro-bind-try', p, p);
  }
  for (const p of options.extraReadWrite ?? []) {
    args.push('--bind-try', p, p);
  }
  // Sentinel separator so the original command isn't confused with
  // bwrap's own flags.
  args.push('--');
  return args;
}

/**
 * Build the firejail flags. Less granular than bwrap but closer to
 * a single-flag approach. The whitelist model is opt-in: we
 * blacklist most of the FS and whitelist only the workspace.
 */
function buildFirejailArgs(binary: string, options: WrapOptions): string[] {
  const args: string[] = [
    binary,
    '--quiet',
    '--noprofile',
    '--private-tmp',
    '--private-dev',
    '--noroot',
    '--seccomp',
    `--whitelist=${options.workspaceRoot}`,
  ];
  if (!options.allowNetwork) {
    args.push('--net=none');
  }
  for (const p of options.extraReadWrite ?? []) {
    args.push(`--whitelist=${p}`);
  }
  // firejail uses `--` to separate flags from the command.
  args.push('--');
  return args;
}

/**
 * Wrap an `argv` array in the configured sandbox. When the sandbox
 * is `off`, returns the original argv with `wrapped: false`. When
 * `required` and no runner is available, throws — the caller should
 * surface this to the user as "sandbox required but unavailable".
 *
 * The returned `cleanup` callback removes any per-spawn temp
 * resources. Call it after the spawned process exits (success or
 * failure).
 */
export function wrapCommand(argv: string[], options: WrapOptions): WrapResult {
  const mode = getSandboxMode();
  if (mode === 'off') {
    return { wrapped: false, runner: null, argv, cleanup: () => {} };
  }

  const detected = detectRunner();
  if (!detected) {
    if (mode === 'required') {
      throw new Error(
        'security.shellSandbox=required but no sandbox runner (bwrap or firejail) was found on PATH',
      );
    }
    coreLogger.warn(
      { mode },
      'security.shellSandbox=auto: no bwrap/firejail found; running unsandboxed',
    );
    return { wrapped: false, runner: null, argv, cleanup: () => {} };
  }

  if (detected.runner === 'bwrap') {
    const scratch = mkdtempSync(join(tmpdir(), 'octipus-shell-'));
    const sbArgs = buildBwrapArgs(detected.binary, options, scratch);
    return {
      wrapped: true,
      runner: 'bwrap',
      argv: [...sbArgs, ...argv],
      cleanup: () => {
        try { require('node:fs').rmSync(scratch, { recursive: true, force: true }); }
        catch { /* best effort */ }
      },
    };
  }

  // firejail
  const sbArgs = buildFirejailArgs(detected.binary, options);
  return {
    wrapped: true,
    runner: 'firejail',
    argv: [...sbArgs, ...argv],
    cleanup: () => {},
  };
}
