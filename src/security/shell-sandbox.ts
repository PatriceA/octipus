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
 *     bwrap. Windows has no comparable built-in runner (AppContainer and
 *     job objects need a native helper), so nothing wraps there.
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
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';

export type SandboxRunner = 'bwrap' | 'firejail' | 'sandbox-exec';
export type SandboxMode = 'off' | 'auto' | 'required';

export interface WrapOptions {
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
const detectedCache = new Map<boolean, Detected | null>();

export interface DetectOptions {
  /**
   * Also consider sandbox-exec (macOS only). Off by default, so every caller
   * that asks "is there a runner?" without saying so — the shell tool under
   * `auto`, scorers, tests keyed off `detectRunner() !== null` — sees on macOS
   * what it saw before sandbox-exec support existed: none.
   */
  allowSeatbelt?: boolean;
}

export function detectRunner(options: DetectOptions = {}): Detected | null {
  const allowSeatbelt = options.allowSeatbelt === true;
  const cached = detectedCache.get(allowSeatbelt);
  if (cached !== undefined) return cached;
  // macOS first looks for Seatbelt when allowed; elsewhere sandbox-exec is
  // never used. Windows finds none of these paths, so nothing wraps there.
  const candidates: Array<[SandboxRunner, string[]]> = [
    ...(allowSeatbelt && process.platform === 'darwin' ? [['sandbox-exec', KNOWN_SANDBOX_EXEC] as [SandboxRunner, string[]]] : []),
    ['bwrap', KNOWN_BWRAP],
    ['firejail', KNOWN_FIREJAIL],
  ];
  for (const [runner, paths] of candidates) {
    const binary = paths.find((path) => existsSync(path));
    if (binary) {
      const found = { runner, binary };
      detectedCache.set(allowSeatbelt, found);
      return found;
    }
  }
  detectedCache.set(allowSeatbelt, null);
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
  args.push(`--env=PATH=${[...cliPath, runtimePath(options.path)].join(':')}`, `--env=PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? browserRuntimePaths()[0]}`);
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

/**
 * System and runtime directories any sandboxed command may read (and map
 * executable code from): the macOS counterpart of bwrap's read-only /usr,
 * /lib, /bin, /etc and /opt. `/System` includes the dyld shared cache on
 * current releases (under /System/Volumes/Preboot/Cryptexes);
 * /private/var/db/dyld holds it on older ones. /private/var/db/timezone
 * holds the zoneinfo /etc/localtime points into, and /private/var/select the
 * /bin/sh selection. Homebrew lives in /opt/homebrew (Apple silicon) or
 * /usr/local (Intel), both covered.
 */
const SEATBELT_SYSTEM_READ = [
  '/System', '/usr', '/bin', '/sbin', '/opt',
  '/Library/Apple', '/Library/Frameworks', '/Library/Developer/CommandLineTools',
  '/Applications/Xcode.app/Contents/Developer',
  '/private/etc', '/private/var/db/timezone', '/private/var/db/dyld', '/private/var/select',
];

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
 *   sysctl reads, preference reads, and the short mach-service list above.
 * - **Reading:** file *metadata* anywhere (path resolution — realpath, the
 *   module lookup that walks up parent directories — stats every ancestor;
 *   this reveals names, sizes and times, never contents). File *contents*
 *   only under the system directories above, the user runtime directories,
 *   `extraReadOnly`, the workspace, the writable directories and a few
 *   devices (/dev/null, /dev/zero, /dev/random, /dev/urandom, /dev/tty,
 *   /dev/fd). The rest of the home directory, ~/.ssh included, is unreadable.
 * - **Writing:** only the scratch directory, `extraReadWrite`, the
 *   workspace unless `workspaceReadOnly`, and the character devices above.
 *   A read-only workspace also gets an explicit `deny file-write*` as the
 *   last rule (SBPL applies the last matching rule), so it stays read-only
 *   even if a writable path contains it.
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
  const readOnly = [...SEATBELT_SYSTEM_READ, ...inputs.runtimeDirs, ...inputs.cliPaths, ...(options.extraReadOnly ?? [])];
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
    '(allow user-preference-read)',
    `(allow mach-lookup ${mach.map((n) => `(global-name ${sbplString(n)})`).join(' ')})`,
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    // Files: metadata anywhere, contents only where listed.
    '(allow file-read-metadata)',
    `(allow file-read* file-map-executable ${subpaths(readOnly)})`,
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-read* file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (subpath "/dev/fd"))',
    `(allow file-read* file-write* file-map-executable ${subpaths(writable)})`,
    options.workspaceReadOnly
      ? `(allow file-read* file-map-executable ${subpaths([options.workspaceRoot])})`
      : `(allow file-read* file-write* file-map-executable ${subpaths([options.workspaceRoot])})`,
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
  if (options.workspaceReadOnly) {
    // Last, so it wins over any writable path that contains the workspace.
    lines.push(`(deny file-write* ${subpaths([options.workspaceRoot])})`);
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
export function activeSandboxRunner(options: DetectOptions = {}): SandboxRunner | null {
  const mode = getSandboxMode();
  if (mode === 'off') return null;
  return detectRunner({ allowSeatbelt: seatbeltAllowed(mode, options.allowSeatbelt) })?.runner ?? null;
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
  options = { ...options, extraReadOnly: [...new Set([...(options.extraReadOnly ?? []), ...browserRuntimeMounts(), ...androidSdkPaths()])] };
  const mode = getSandboxMode();
  if (mode === 'off') {
    return { wrapped: false, runner: null, argv, cleanup: () => {} };
  }

  const detected = detectRunner({ allowSeatbelt: seatbeltAllowed(mode, options.allowSeatbelt) });
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
