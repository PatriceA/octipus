import { windowsSandboxBinary, wrapWindowsPluginCommand } from './windows-plugin-sandbox';
import { approvedCliRuntimes } from './cli-runtimes';
import type { ShellSshAgent } from './shell-ssh-agent';
import { androidSdkPaths, browserRuntimeMounts, browserRuntimePaths, runtimePath } from './runtime-path';
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
 *   - sandbox-exec — macOS only: `/usr/bin/sandbox-exec` with a Seatbelt
 *     (SBPL) profile generated per spawn (`buildSeatbeltProfile`). Used for
 *     plugin package servers under `auto`/`required` (`allowSeatbelt`), and
 *     for everything else (the shell tool) only under `required`: under
 *     `auto`, macOS shell commands still run unwrapped as before. Apple
 *     marks sandbox-exec deprecated, but it still ships with every macOS
 *     release and is what the system's own services use underneath; if a
 *     release ever drops it, detection finds nothing and `auto` falls back
 *     to unwrapped (and `required` refuses), as on a Linux host without
 *     bwrap.
 *   - appcontainer — native Windows plugin-only helper; no capabilities, a
 *     kill-on-close Job object, and a private pipe to the host egress proxy.
 *     General shell tools do not opt into this runner.
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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';

export type SandboxRunner = 'bwrap' | 'firejail' | 'sandbox-exec' | 'appcontainer';
export type SandboxMode = 'off' | 'auto' | 'required';

export interface WrapOptions {
  /** Trusted server-resolved environment override. Never a tool argument. */
  mode?: SandboxMode;
  /** Server-resolved opt-in; never a whole ~/.ssh mount. */
  sshAgent?: ShellSshAgent;
  /** Workspace root that should be writable inside the sandbox. */
  workspaceRoot: string;
  /** Mount the workspace root read-only instead (a plugin package's own
   *  files: it writes only to the `extraReadWrite` data directory). */
  workspaceReadOnly?: boolean;
  /** Allow network access. Defaults to `false` — sandboxed shells
   *  typically don't need network. */
  allowNetwork?: boolean;
  /**
   * With network otherwise off, TCP ports on loopback the command may still
   * connect to: the egress proxy's listener on macOS, which has no network
   * namespace to bridge into (see `buildSeatbeltProfile`). Only sandbox-exec
   * honours it; bwrap and firejail reach the proxy through its Unix socket.
   */
  loopbackPorts?: number[];
  /**
   * May sandbox-exec (macOS) wrap this command even under `auto`? Plugin
   * package servers set it. The shell tool does not: its Seatbelt use is
   * limited to `required`, where it would otherwise refuse to run, so `auto`
   * on macOS keeps running shell commands unwrapped as it always has.
   */
  allowSeatbelt?: boolean;
  /** Native Windows runner: plugin transports only, never general shell tools. */
  allowAppContainer?: boolean;
  /** Server-authorized host USB access for device tests; not implied by network access. */
  allowHostUsb?: boolean;
  /** Additional read-only paths to expose (e.g. /Users for macOS-style
   *  layouts). Caller's responsibility. */
  extraReadOnly?: string[];
  /** Additional read-write paths. Use sparingly; each one widens
   *  the blast radius of a compromise. */
  extraReadWrite?: string[];
  /** Command environment PATH, before adding the mounted user executables. */
  path?: string;
  /** Server-owned private broker, never a plugin/tool argument. */
  windowsBroker?: { pipe?: string; proxyPort?: number; authority: string };
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
/** Only the system copy: a sandbox-exec found anywhere else is not Apple's. */
const KNOWN_SANDBOX_EXEC = ['/usr/bin/sandbox-exec'];

type Detected = { runner: SandboxRunner; binary: string };
/** One cache per `allowSeatbelt` value. */
const detectedCache = new Map<string, Detected | null>();

export interface DetectOptions {
  /**
   * Also consider sandbox-exec (macOS only). Off by default, so every caller
   * that asks "is there a runner?" without saying so — the shell tool under
   * `auto`, scorers, tests keyed off `detectRunner() !== null` — sees on macOS
   * what it saw before sandbox-exec support existed: none.
   */
  allowSeatbelt?: boolean;
  /** Native Windows runner: plugin transports only, never general shell tools. */
  allowAppContainer?: boolean;
}

export function detectRunner(options: DetectOptions = {}): Detected | null {
  const allowSeatbelt = options.allowSeatbelt === true;
  const key = `${allowSeatbelt}:${options.allowAppContainer === true}`;
  const cached = detectedCache.get(key);
  if (cached !== undefined) return cached;
  // macOS first looks for Seatbelt when allowed; elsewhere sandbox-exec is
  // never used. Windows finds none of these paths, so nothing wraps there.
  const windowsBinary = process.platform === 'win32' && options.allowAppContainer ? windowsSandboxBinary() : null;
  const candidates: Array<[SandboxRunner, string[]]> = [
    ...(windowsBinary ? [['appcontainer', [windowsBinary]] as [SandboxRunner, string[]]] : []),
    ...(allowSeatbelt && process.platform === 'darwin' ? [['sandbox-exec', KNOWN_SANDBOX_EXEC] as [SandboxRunner, string[]]] : []),
    ['bwrap', KNOWN_BWRAP],
    ['firejail', KNOWN_FIREJAIL],
  ];
  for (const [runner, paths] of candidates) {
    const binary = paths.find((path) => existsSync(path));
    if (binary) {
      const found = { runner, binary };
      detectedCache.set(key, found);
      return found;
    }
  }
  detectedCache.set(key, null);
  return null;
}

/**
 * Whether sandbox-exec may be used: when the caller allows it (plugin
 * package servers), or under `required`, where the alternative is refusing.
 */
function seatbeltAllowed(mode: SandboxMode, allowSeatbelt: boolean | undefined): boolean {
  return allowSeatbelt === true || mode === 'required';
}

/** Test-only: reset the runner cache so a test can force re-detection. */
export function _resetSandboxDetectionForTests(): void {
  detectedCache.clear();
  probeCache.clear();
  forced = false;
}

/** Why a runner binary cannot start a sandbox here (or null: it can), by binary. */
const probeCache = new Map<string, string | null>();
/** A test forced the runner (`_forceSandboxRunnerForTests`): it is taken to work. */
let forced = false;

/**
 * Whether `detected` can actually start a sandbox on this host: null when it
 * can, else why not. Only bwrap is probed (`bwrap --ro-bind / / --new-session
 * true`, once per process): it is found on hosts where unprivileged user
 * namespaces are off (a default Docker seccomp profile, a hardened kernel),
 * and then every wrapped start would fail. firejail (setuid) and sandbox-exec
 * need nothing of the kind.
 */
export function runnerProblem(detected: Detected): string | null {
  if (forced || (detected.runner !== 'bwrap' && detected.runner !== 'appcontainer')) return null;
  const cached = probeCache.get(detected.binary);
  if (cached !== undefined) return cached;
  let problem: string | null = null;
  try {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- fixed argv of a runner found at a known system path
    const r = spawnSync(detected.binary, detected.runner === 'appcontainer' ? ['--probe'] : ['--ro-bind', '/', '/', '--new-session', 'true'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (r.error || r.status !== 0) {
      const why = (r.error?.message ?? r.stderr ?? '').trim().split('\n')[0]?.slice(0, 200) || `exit ${r.status}`;
      problem = detected.runner === 'appcontainer'
        ? `${detected.binary} cannot initialize AppContainer (${why}); rebuild with npm run build:sandbox:windows`
        : `${detected.binary} is installed but cannot start a sandbox here (${why}); it needs unprivileged user namespaces (check: bwrap --ro-bind / / true)`;
    }
  } catch (err) {
    problem = `${detected.binary} could not be run (${(err as Error).message})`;
  }
  if (problem) coreLogger.warn({ runner: detected.runner, binary: detected.binary, problem }, 'Sandbox runner found but not working');
  probeCache.set(detected.binary, problem);
  return problem;
}

/**
 * Test-only: make detection return `runner` at `binary` (both cache entries)
 * until the next `_resetSandboxDetectionForTests`. Detection itself prefers
 * bwrap over firejail; the Linux end-to-end test uses this to run each
 * installed runner in turn. Production never calls it.
 */
export function _forceSandboxRunnerForTests(runner: SandboxRunner, binary: string): void {
  for (const a of [false, true]) for (const b of [false, true]) detectedCache.set(`${a}:${b}`, { runner, binary });
  forced = true;
}

/** Test-only: make detection find no runner at all (both cache entries). */
export function _forceNoSandboxRunnerForTests(): void {
  for (const a of [false, true]) for (const b of [false, true]) detectedCache.set(`${a}:${b}`, null);
}

/** The runner a plugin package server would run in here, found and working, or why there is none. */
export interface PluginRunnerState {
  runner: SandboxRunner | null;
  binary: string | null;
  /** Why no runner works here (none found, or found and not working); null when one does. */
  problem: string | null;
}

/** How to get a runner on this platform, for refusals and the admin page. */
export function sandboxRunnerHelp(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'install the native Windows plugin runner with npm run build:sandbox:windows (Rust and Visual Studio C++ Build Tools required); it uses AppContainer and a Job object without administrator privileges';
  }
  if (platform === 'darwin') return '/usr/bin/sandbox-exec, which ships with macOS, was not found';
  return 'install bubblewrap (apt-get install bubblewrap, dnf install bubblewrap or apk add bubblewrap; it needs unprivileged user namespaces, check with: bwrap --ro-bind / / true) or firejail';
}

/**
 * The runner plugin package servers use, independent of `security.shellSandbox`
 * (which governs agent shells): bwrap or firejail on Linux, sandbox-exec on
 * macOS, found at its system path and (bwrap) able to start a sandbox here.
 */
export function pluginRunnerState(): PluginRunnerState {
  const detected = detectRunner({ allowSeatbelt: true, allowAppContainer: true });
  if (!detected) return { runner: null, binary: null, problem: `no sandbox runner found: ${sandboxRunnerHelp()}` };
  const problem = runnerProblem(detected);
  if (problem) return { runner: null, binary: detected.binary, problem: detected.runner === 'appcontainer' ? problem : `${problem}; or install firejail` };
  return { runner: detected.runner, binary: detected.binary, problem: null };
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
  const androidSdk = androidSdkPaths()[0];
  const projectBin = join(options.workspaceRoot, '.venv', 'bin');
  const cliTools = approvedCliRuntimes();
  const commandPath = [cliTools.length ? '/tmp/octipus-cli-bin' : '', existsSync(projectBin) ? projectBin : '', runtimePath(options.path)].filter(Boolean).join(':');
  const args: string[] = [
    binary,
    // New mount namespace + tmp root.
    '--die-with-parent',
    // A new session (setsid): the command has no controlling terminal, so it
    // cannot open /dev/tty or push keystrokes into the terminal Octipus was
    // started from (TIOCSTI). The private /dev below has no host tty either.
    '--new-session',
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
    // User-installed command entry points and Python user-site packages.
    // Expose only these runtime directories, never the whole home directory.
    '--ro-bind-try', join(homedir(), '.local', 'bin'), join(homedir(), '.local', 'bin'),
    '--ro-bind-try', join(homedir(), '.local', 'lib'), join(homedir(), '.local', 'lib'),
    // uv tool entry points are symlinks to venvs whose interpreters can
    // themselves live in uv's managed Python directory. Both are runtime-only.
    '--ro-bind-try', join(homedir(), '.local/share/uv/tools'), join(homedir(), '.local/share/uv/tools'),
    '--ro-bind-try', join(homedir(), '.local/share/uv/python'), join(homedir(), '.local/share/uv/python'),
    // npm's user prefix: bin entries are symlinks into lib/node_modules.
    // Mount both read-only; never expose the prefix root or ~/.npmrc.
    '--ro-bind-try', join(homedir(), '.npm-global/bin'), join(homedir(), '.npm-global/bin'),
    '--ro-bind-try', join(homedir(), '.npm-global/lib/node_modules'), join(homedir(), '.npm-global/lib/node_modules'),
    // Go needs the distribution (GOROOT), plus installed Go tools.
    '--ro-bind-try', join(homedir(), '.local/go'), join(homedir(), '.local/go'),
    '--ro-bind-try', join(homedir(), 'go/bin'), join(homedir(), 'go/bin'),
    '--setenv', 'PATH', commandPath,
    // The private /tmp below is the only scratch there is: a host TMPDIR
    // (e.g. under /run/user or $HOME) is not mounted, and the read-only root
    // would refuse writes to it (seen in shell-sandbox.linux.e2e.test.ts).
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PLAYWRIGHT_BROWSERS_PATH', process.env.PLAYWRIGHT_BROWSERS_PATH ?? browserRuntimePaths()[0],
    ...(androidSdk ? ['--setenv', 'ANDROID_HOME', androidSdk, '--setenv', 'ANDROID_SDK_ROOT', androidSdk] : []),
    // Per-spawn scratch (the legacy /tmp/assistant- prefix lives here).
    // Bound BEFORE the workspace so that workspaces under /tmp aren't
    // shadowed by this overlay — order matters in bwrap.
    '--bind', scratch, '/tmp',
    // Read-write the workspace root (read-only when asked).
    options.workspaceReadOnly ? '--ro-bind' : '--bind', options.workspaceRoot, options.workspaceRoot,
    // Standard pseudo filesystems.
    '--proc', '/proc',
    '--dev', '/dev',
    // Make the cwd inside the workspace.
    '--chdir', options.workspaceRoot,
  ];
  for (const p of options.extraReadOnly ?? []) {
    args.push('--ro-bind-try', p, p);
  }
  // Bound by path after the /tmp scratch, so a path anywhere (the egress
  // proxy's socket directory under the workspace, a package's data
  // directory) shows up as itself, read-write.
  for (const p of options.extraReadWrite ?? []) {
    args.push('--bind-try', p, p);
  }
  if (options.allowHostUsb) {
    // Ordinary bind mounts are nodev. USB needs a device bind, after the
    // private /dev, plus read-only sysfs topology for libusb discovery.
    args.push('--dev-bind-try', '/dev/bus/usb', '/dev/bus/usb',
      '--ro-bind-try', '/sys/bus/usb', '/sys/bus/usb',
      '--ro-bind-try', '/sys/devices', '/sys/devices');
  }
  for (const tool of cliTools) {
    args.push('--ro-bind', tool.resolvedPath, `/tmp/octipus-cli-bin/${tool.name}`);
  }
  if (options.sshAgent) {
    // Some hosts expose root-owned SSH include files as unmapped users inside
    // a user namespace. OpenSSH refuses those before contacting the agent.
    // Keep host verification and the main config; hide only optional includes.
    if (existsSync('/etc/ssh/ssh_config.d')) args.push('--tmpfs', '/etc/ssh/ssh_config.d');
    args.push('--ro-bind', options.sshAgent.socket, options.sshAgent.socket, '--setenv', 'SSH_AUTH_SOCK', options.sshAgent.socket);
    if (options.sshAgent.knownHosts) args.push('--ro-bind', options.sshAgent.knownHosts, options.sshAgent.knownHosts);
  }
  // Sentinel separator so the original command isn't confused with
  // bwrap's own flags.
  // Synthetic parent directories are not host mounts. Keep them read-only:
  // otherwise a git worktree can leave persistent .git metadata pointing at
  // files created only in this command's disposable mount namespace.
  args.push('--remount-ro', '/', '--');
  return args;
}

/**
 * Build the firejail flags. Less granular than bwrap but closer to
 * a single-flag approach. The whitelist model is opt-in: we
 * blacklist most of the FS and whitelist only the workspace.
 */
function buildFirejailArgs(binary: string, options: WrapOptions): string[] {
  const androidSdk = androidSdkPaths()[0];
  const cliTools = approvedCliRuntimes();
  const args: string[] = [
    binary,
    '--quiet',
    '--noprofile',
    '--private-tmp',
    '--private-dev',
    // Firejail's private-dev retains USB by default; make the opt-in explicit.
    ...(options.allowHostUsb ? ['--read-only=/sys/bus/usb', '--read-only=/sys/devices'] : ['--blacklist=/dev/bus/usb']),
    '--noroot',
    '--seccomp',
    '--caps.drop=all',
    '--nonewprivs',
    `--whitelist=${options.workspaceRoot}`,
    ...(options.workspaceReadOnly ? [`--read-only=${options.workspaceRoot}`] : []),
  ];
  if (!options.allowNetwork) {
    args.push('--net=none');
  }
  const runtimeDirs = ['.local/bin', '.local/lib', '.local/share/uv/tools', '.local/share/uv/python',
    '.npm-global/bin', '.npm-global/lib/node_modules', '.local/go', 'go/bin'].map(path => join(homedir(), path));
  for (const p of [...runtimeDirs, ...(options.extraReadOnly ?? [])].filter(path => existsSync(path))) {
    args.push(`--whitelist=${p}`, `--read-only=${p}`);
  }
  for (const tool of cliTools) {
    for (const path of new Set([tool.path, tool.resolvedPath])) args.push(`--whitelist=${path}`, `--read-only=${path}`);
  }
  const cliPath = [...new Set(cliTools.map(tool => tool.path.slice(0, tool.path.lastIndexOf('/'))))];
  // TMPDIR: the private /tmp, as with bwrap; a host TMPDIR outside it would
  // land in firejail's throwaway home or not exist at all.
  args.push(`--env=PATH=${[...cliPath, runtimePath(options.path)].join(':')}`, '--env=TMPDIR=/tmp', `--env=PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? browserRuntimePaths()[0]}`);
  if (androidSdk) args.push(`--env=ANDROID_HOME=${androidSdk}`, `--env=ANDROID_SDK_ROOT=${androidSdk}`);
  // Whitelisted, not bound: firejail shows these only where its whitelist
  // reaches (home, /run/user, /srv, /opt, /var, ...). Never put one under
  // /tmp: `--private-tmp` above hides the host's /tmp whatever is listed.
  for (const p of options.extraReadWrite ?? []) {
    args.push(`--whitelist=${p}`);
  }
  if (options.sshAgent) {
    for (const path of [options.sshAgent.socket, options.sshAgent.knownHosts].filter((path): path is string => !!path)) {
      args.push(`--whitelist=${path}`, `--read-only=${path}`);
    }
    args.push(`--env=SSH_AUTH_SOCK=${options.sshAgent.socket}`);
  }
  // $HOME is never exposed. A whitelisted path under it already turns the
  // home directory into a tmpfs that shows only the whitelisted entries; when
  // none is, nothing would hide it (--noprofile loads no profile that does),
  // so it is replaced by an empty temporary one. The whitelisted workspace
  // and data directories outside it are not affected.
  const home = homedir();
  const whitelisted = args.filter((a) => a.startsWith('--whitelist=')).map((a) => a.slice('--whitelist='.length));
  if (!whitelisted.some((p) => p === home || p.startsWith(`${home}/`))) args.push('--private');
  // firejail uses `--` to separate flags from the command.
  args.push('--');
  return args;
}

/**
 * Quote `value` as an SBPL string literal. SBPL is read by a Scheme reader:
 * a string is `"..."` in which `\` and `"` must be escaped, and `\n`, `\r`
 * and `\t` stand for those characters. Any other control character is
 * refused rather than passed through, so a path can never end the literal
 * and add a rule of its own.
 */
export function sbplString(value: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`Sandbox path contains a control character: ${JSON.stringify(value)}`);
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** `path` with its symbolic links resolved, or as given when it does not exist. */
function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Every spelling of `path` Seatbelt may see. Seatbelt matches the resolved
 * path of the file, so `/tmp/x` is `/private/tmp/x` and `/var/folders/...`
 * is `/private/var/folders/...`: list the given form, the resolved form and,
 * for a path that does not exist yet, the `/private` form of those macOS
 * top-level links.
 */
function seatbeltPaths(path: string): string[] {
  const forms = [path, realpathOr(path)];
  if (/^\/(?:tmp|var|etc)(?:\/|$)/.test(path)) forms.push(`/private${path}`);
  return [...new Set(forms)];
}

const subpaths = (paths: string[]) => [...new Set(paths.flatMap(seatbeltPaths))].map((p) => `(subpath ${sbplString(p)})`).join(' ');
const literals = (paths: string[]) => [...new Set(paths.flatMap(seatbeltPaths))].map((p) => `(literal ${sbplString(p)})`).join(' ');

/** Package-manager prefixes: Homebrew (Apple silicon, Intel) and MacPorts. */
const SEATBELT_PREFIXES = ['/opt/homebrew', '/usr/local', '/opt/local'];

/**
 * System and runtime directories any sandboxed command may read (and map
 * executable code from): the macOS counterpart of bwrap's read-only /usr,
 * /lib, /bin and /etc. `/System` includes the dyld shared cache on current
 * releases (under /System/Volumes/Preboot/Cryptexes); /private/var/db/dyld
 * holds it on older ones. /private/var/db/timezone holds the zoneinfo
 * /etc/localtime points into, and /private/var/select the /bin/sh selection.
 *
 * Not all of /usr or /opt: under a package-manager prefix only the program
 * directories are listed (`bin`, `sbin`, `lib`, `libexec`, `share`, `opt`,
 * `Cellar`, `Frameworks`), never `var` or `etc` — that is where Homebrew
 * keeps Postgres, MySQL and Redis data and service configs with passwords
 * (`SEATBELT_PREFIX_DENY` denies them again explicitly).
 */
const SEATBELT_SYSTEM_READ = [
  '/System', '/bin', '/sbin',
  '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/standalone',
  ...SEATBELT_PREFIXES.flatMap((prefix) => ['bin', 'sbin', 'lib', 'libexec', 'share', 'opt', 'Cellar', 'Frameworks'].map((dir) => `${prefix}/${dir}`)),
  '/Library/Apple', '/Library/Frameworks', '/Library/Developer/CommandLineTools',
  '/Applications/Xcode.app/Contents/Developer',
  '/private/etc', '/private/var/db/timezone', '/private/var/db/dyld', '/private/var/select',
];

/**
 * Denied after the allows above (SBPL applies the last matching rule), in
 * case a link or a later release puts them under an allowed path: a prefix's
 * `var` (databases, logs) and `etc` (service configs).
 */
const SEATBELT_PREFIX_DENY = SEATBELT_PREFIXES.flatMap((prefix) => [`${prefix}/var`, `${prefix}/etc`]);

/**
 * Inside a prefix's `etc`, the public CA bundles only, so TLS in a
 * Homebrew-linked tool (curl, Python) still verifies certificates when
 * network is allowed. Allowed after the deny.
 */
const SEATBELT_PREFIX_CERTS = SEATBELT_PREFIXES.flatMap((prefix) => [
  `${prefix}/etc/ca-certificates`, `${prefix}/etc/openssl@3/cert.pem`, `${prefix}/etc/openssl@3/certs`,
  `${prefix}/etc/openssl@1.1/cert.pem`, `${prefix}/etc/openssl@1.1/certs`,
]);

/**
 * Mach services every process needs to start and look up its own user:
 * directory services (getpwuid), the notification center and logging,
 * preferences. Deliberately short: a mach service runs outside the sandbox,
 * and some (nsurlsessiond, for one) would make network requests for the
 * caller. With network on, the DNS and network-configuration services are
 * added — DNS answers can carry data out, so they stay off otherwise.
 */
const SEATBELT_MACH_BASE = [
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.DirectoryService.libinfo_v1',
  'com.apple.system.notification_center', 'com.apple.system.logger', 'com.apple.logd',
  'com.apple.cfprefsd.daemon', 'com.apple.cfprefsd.agent',
];
const SEATBELT_MACH_NETWORK = [
  'com.apple.dnssd.service', 'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration', 'com.apple.trustd', 'com.apple.trustd.agent',
];

/** What `buildSeatbeltProfile` needs beyond `WrapOptions`. */
export interface SeatbeltInputs {
  /** The per-spawn scratch directory (the command's TMPDIR), writable. */
  scratch: string;
  /** User-level runtime directories to expose read-only (as bwrap does). */
  runtimeDirs: string[];
  /** Approved CLI runtimes' paths (`approvedCliRuntimes`), read-only. */
  cliPaths: string[];
}

/**
 * The Seatbelt (SBPL) profile sandbox-exec runs a command under on macOS.
 *
 * Everything is denied (`deny default`), then allowed back:
 *
 * - **Processes:** exec, fork, signals and process info within the sandbox,
 *   sysctl reads and the short mach-service list above. Preferences: only
 *   the global domain (`kCFPreferencesAnyApplication`: locale, measurement
 *   units, the settings CoreFoundation reads for any process), never
 *   another app's domain, some of which hold tokens. Node itself does not
 *   read preferences; nothing else is known to be needed, so no further
 *   domain is listed.
 * - **Reading:** file *metadata* anywhere (path resolution — realpath, the
 *   module lookup that walks up parent directories — stats every ancestor;
 *   this reveals names, sizes and times, never contents). File *contents*
 *   only under the system directories above (with package-manager `var` and
 *   `etc` denied, but for CA bundles), the user runtime directories,
 *   `extraReadOnly`, the workspace, the writable directories and a few
 *   devices (/dev/null, /dev/zero, /dev/random, /dev/urandom, /dev/fd;
 *   never /dev/tty, so no ioctl such as TIOCSTI reaches the terminal).
 *   The rest of the home directory, ~/.ssh included, is unreadable.
 * - **Writing:** only the scratch directory, `extraReadWrite`, the
 *   workspace unless `workspaceReadOnly`, and the character devices above.
 *   A read-only workspace also gets an explicit `deny file-write*`, placed
 *   before the writable paths' allow (SBPL applies the last matching rule):
 *   a writable directory inside the workspace stays writable, as a later
 *   `--bind` inside a `--ro-bind` does with bwrap.
 * - **Network:** none at all by default — no TCP, no UDP, no Unix socket,
 *   no DNS. `allowNetwork` allows all of it. `loopbackPorts` allows outbound
 *   TCP to exactly those ports on localhost and nothing else.
 *
 * Why the egress proxy is reached by TCP port here and not, as on Linux,
 * through its Unix socket and a bridge: macOS has no network namespace, so
 * a bridge's "127.0.0.1" inside the sandbox is the host's loopback. The
 * bridge would need a listening port of its own, and the profile — written
 * before the bridge picks one — could only allow loopback broadly, letting
 * the server reach any local service. Allowing only the proxy's port is
 * narrower and needs no launcher: direct egress to anything else, the
 * internet or another local port, is refused by the kernel.
 */
export function buildSeatbeltProfile(options: WrapOptions, inputs: SeatbeltInputs): string {
  const readOnly = [...inputs.runtimeDirs, ...inputs.cliPaths, ...(options.extraReadOnly ?? [])];
  const writable = [inputs.scratch, ...(options.extraReadWrite ?? [])];
  const mach = [...SEATBELT_MACH_BASE, ...(options.allowNetwork ? SEATBELT_MACH_NETWORK : [])];
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    // Processes: run programs, but touch only processes in this sandbox.
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow user-preference-read (preference-domain "kCFPreferencesAnyApplication"))',
    `(allow mach-lookup ${mach.map((n) => `(global-name ${sbplString(n)})`).join(' ')})`,
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    // Files: metadata anywhere, contents only where listed.
    '(allow file-read-metadata)',
    // The root directory itself (a literal: nothing under it). dyld reads it
    // while starting every process; denied, each one aborts (SIGABRT) before
    // main — seen on the macOS CI runner for /bin/echo and node alike.
    '(allow file-read-data (literal "/"))',
    `(allow file-read* file-map-executable ${subpaths(SEATBELT_SYSTEM_READ)})`,
    // Package-manager data and configs stay closed, but for public CA bundles.
    `(deny file-read* file-map-executable file-write* ${subpaths(SEATBELT_PREFIX_DENY)})`,
    `(allow file-read* ${subpaths(SEATBELT_PREFIX_CERTS)})`,
    // Paths the caller asked for come after the deny, so they win.
    ...(readOnly.length > 0 ? [`(allow file-read* file-map-executable ${subpaths(readOnly)})`] : []),
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))',
    // No /dev/tty: a sandboxed command never reaches the terminal Octipus
    // runs in (no ioctl such as TIOCSTI, no reads or writes).
    '(allow file-read* file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (subpath "/dev/fd"))',
    options.workspaceReadOnly
      ? `(allow file-read* file-map-executable ${subpaths([options.workspaceRoot])})`
      : `(allow file-read* file-write* file-map-executable ${subpaths([options.workspaceRoot])})`,
    // A read-only workspace: deny writes, then allow the writable paths, so
    // one inside the workspace stays writable (as with bwrap).
    ...(options.workspaceReadOnly ? [`(deny file-write* ${subpaths([options.workspaceRoot])})`] : []),
    `(allow file-read* file-write* file-map-executable ${subpaths(writable)})`,
  ];
  if (options.allowNetwork) {
    lines.push('(allow network*)');
  } else {
    // Nothing but these loopback ports (the egress proxy).
    for (const port of options.loopbackPorts ?? []) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid loopback port for the sandbox: ${port}`);
      lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
    }
  }
  if (options.sshAgent) {
    // The agent socket only: connecting to a Unix socket is network-outbound.
    lines.push(`(allow network-outbound ${seatbeltPaths(options.sshAgent.socket).map((p) => `(remote unix-socket (path-literal ${sbplString(p)}))`).join(' ')})`);
    lines.push(`(allow file-read* file-write-data ${literals([options.sshAgent.socket])})`);
    if (options.sshAgent.knownHosts) lines.push(`(allow file-read* ${literals([options.sshAgent.knownHosts])})`);
  }
  if (options.allowHostUsb) {
    // USB devices are reached through IOKit user clients.
    lines.push('(allow iokit-open)');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * sandbox-exec argv: the generated profile, then `/usr/bin/env` to set what
 * bwrap's `--setenv` sets (PATH, TMPDIR pointing at the scratch directory —
 * there is no private /tmp to mount over — and the runtime variables). The
 * command follows; a command name containing `=` would be read by env as an
 * assignment, which no real executable path does.
 */
function buildSandboxExecArgs(binary: string, options: WrapOptions, scratch: string): string[] {
  const androidSdk = androidSdkPaths()[0];
  const cliTools = approvedCliRuntimes();
  const runtimeDirs = ['.local/bin', '.local/lib', '.local/share/uv/tools', '.local/share/uv/python',
    '.npm-global/bin', '.npm-global/lib/node_modules', '.local/go', 'go/bin'].map((path) => join(homedir(), path));
  const projectBin = join(options.workspaceRoot, '.venv', 'bin');
  const cliPath = [...new Set(cliTools.map((tool) => dirname(tool.path)))];
  const commandPath = [...cliPath, existsSync(projectBin) ? projectBin : '', runtimePath(options.path)].filter(Boolean).join(':');
  const profile = buildSeatbeltProfile(options, {
    scratch, runtimeDirs, cliPaths: cliTools.flatMap((tool) => [tool.path, tool.resolvedPath]),
  });
  return [
    binary, '-p', profile,
    '/usr/bin/env',
    `PATH=${commandPath}`,
    `TMPDIR=${scratch}/`,
    `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? browserRuntimePaths()[0]}`,
    ...(androidSdk ? [`ANDROID_HOME=${androidSdk}`, `ANDROID_SDK_ROOT=${androidSdk}`] : []),
    ...(options.sshAgent ? [`SSH_AUTH_SOCK=${options.sshAgent.socket}`] : []),
  ];
}

/**
 * The runner `wrapCommand` would use right now, or null when it would run
 * the command unwrapped (sandbox `off`, or `auto` with no runner found). In
 * `required` mode with no runner it is null too: `wrapCommand` then throws.
 */
export function activeSandboxRunner(options: DetectOptions & { mode?: SandboxMode } = {}): SandboxRunner | null {
  const mode = options.mode ?? getSandboxMode();
  if (mode === 'off') return null;
  return detectRunner({ allowSeatbelt: seatbeltAllowed(mode, options.allowSeatbelt), allowAppContainer: options.allowAppContainer })?.runner ?? null;
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
  if (process.platform !== 'win32') options = { ...options, extraReadOnly: [...new Set([...(options.extraReadOnly ?? []), ...browserRuntimeMounts(), ...androidSdkPaths()])] };
  const mode = options.mode ?? getSandboxMode();
  if (mode === 'off') {
    return { wrapped: false, runner: null, argv, cleanup: () => {} };
  }

  const detected = detectRunner({ allowSeatbelt: seatbeltAllowed(mode, options.allowSeatbelt), allowAppContainer: options.allowAppContainer });
  if (!detected) {
    if (mode === 'required') {
      throw new Error(
        'security.shellSandbox=required but no sandbox runner (bwrap or firejail on Linux, /usr/bin/sandbox-exec on macOS) was found',
      );
    }
    coreLogger.warn(
      { mode },
      'security.shellSandbox=auto: no sandbox runner (bwrap/firejail/sandbox-exec) found; running unsandboxed',
    );
    return { wrapped: false, runner: null, argv, cleanup: () => {} };
  }

  if (detected.runner === 'appcontainer') return wrapWindowsPluginCommand(detected.binary, argv, options, options.windowsBroker);

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

  if (detected.runner === 'sandbox-exec') {
    const scratch = realpathOr(mkdtempSync(join(tmpdir(), 'octipus-shell-')));
    return {
      wrapped: true,
      runner: 'sandbox-exec',
      argv: [...buildSandboxExecArgs(detected.binary, options, scratch), ...argv],
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
