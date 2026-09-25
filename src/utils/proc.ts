/**
 * Child processes.
 *
 * `spawnProcess` keeps the handle shape the ~25 call sites already use —
 * `exited`, `exitCode`, `stdout`/`stderr` as web streams, `stdin` as a writable
 * one, `kill()` — over `node:child_process`. It is a shape, not a framework:
 * everything below is a direct translation.
 *
 * `runCommand` is the shorter form for the common case, where the caller only
 * wants the output and the exit code.
 */
import { spawn as nodeSpawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

export type StdioMode = 'pipe' | 'ignore' | 'inherit';

export interface SpawnConfig {
  /**
   * The program to run. Its own field, not the head of an argv array: an
   * array's elements are interchangeable to a reader and to a static analysis,
   * so `[binary, ...args]` made every argument look like a candidate for
   * argv[0] (CodeQL alert 15). Separating them means the value that decides
   * WHICH program runs can never come from the values that are merely passed
   * to it.
   */
  command: string;
  /** Arguments. Passed as an array to `spawn`, never through a shell. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: StdioMode;
  stdout?: StdioMode;
  stderr?: StdioMode;
}

/**
 * The type parameters are accepted and ignored: several call sites carry the
 * previous `Subprocess<'ignore', 'pipe', 'pipe'>` annotation, and the stdio
 * modes are already given as arguments to `spawnProcess`.
 */
export interface ChildProcessHandle<_In = unknown, _Out = unknown, _Err = unknown> {
  readonly pid: number | undefined;
  /** Resolves with the exit code once the process is gone. */
  readonly exited: Promise<number>;
  /** The exit code, or null while the process is still running. */
  readonly exitCode: number | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: WritableStream<Uint8Array> | null;
  kill(signal?: NodeJS.Signals | number): void;
}

/**
 * What argv[0] is allowed to look like: a program name or a path to one.
 *
 * Every spawn in the process funnels through here, and the element that lands
 * in argv[0] decides which binary runs. Nothing legitimate needs a shell
 * metacharacter or a leading `-` in that position, while a value that has one
 * is either an injected option or a command line someone hoped would reach a
 * shell. Refusing it is a one-line barrier for all ~25 call sites — cheaper
 * than proving, at each of them, that the name cannot be influenced.
 *
 * Arguments are NOT restricted: they are passed as an array to `spawn` without
 * a shell, so metacharacters in them are inert. Callers that build an argument
 * out of a path should pass an ABSOLUTE one, so it cannot be read as a flag.
 */
const EXECUTABLE_NAME = /^[A-Za-z0-9_./\\:+-]+$/;
/**
 * The same, plus spaces. Windows installs Node at `C:\Program Files\nodejs\
 * node.exe`, and `process.execPath` is how the setup wizard boots the backend.
 * A space is inert without a shell, but it is only accepted for an absolute
 * path that exists, so a command line like `sh -c id` stays refused.
 */
const EXECUTABLE_PATH = /^[A-Za-z0-9_./\\:+ -]+$/;

function safeExecutable(command: string): string {
  if (command.startsWith('-')) {
    throw new Error(`spawnProcess: refusing a command that starts with "-": ${command}`);
  }
  const match =
    EXECUTABLE_NAME.exec(command) ??
    (isAbsolute(command) && existsSync(command) ? EXECUTABLE_PATH.exec(command) : null);
  if (!match) {
    throw new Error(`spawnProcess: refusing a command with unexpected characters: ${command}`);
  }
  // The MATCH is what gets spawned, not the argument — the validated value and
  // the used value are the same object, so no later edit can let one drift
  // from the other (and a taint analysis can see the barrier).
  return match[0];
}

/**
 * Kill a child and everything it started.
 *
 * `process.kill(-pid)` — signal the whole process group — is POSIX only. On
 * Windows it throws, and callers wrap the kill in a `catch` that reads a throw
 * as "already gone", so a deadline that meant to end a tree ended nothing:
 * `sleep 5` under a 300ms timeout ran its full five seconds and reported exit
 * 0. `taskkill /T /F` is the platform's equivalent. Synchronous, because the
 * `exit`-handler reapers that call it cannot await.
 *
 * Requires the child to have been spawned `detached` on POSIX, which is what
 * gives it a group of its own; Windows needs no such arrangement.
 */
export function killProcessTree(pid: number | undefined, child?: { kill: (signal?: NodeJS.Signals) => boolean }): void {
  try {
    if (process.platform === 'win32') {
      // Bounded: this is synchronous and runs on the event loop. A taskkill that
      // fails (missing from the service PATH, access denied) still kills the child.
      const r = pid !== undefined ? spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }) : null;
      if (!r || r.error || r.status !== 0) child?.kill();
      return;
    }
    if (pid !== undefined) process.kill(-pid, 'SIGKILL');
    else child?.kill('SIGKILL');
  } catch {
    // ESRCH / the tree is already gone. Nothing to do, and `exit` handlers
    // must not throw.
  }
}

/** `spawnProcess({ command: 'ls', args: ['-la'] })`. */
export function spawnProcess(config: SpawnConfig): ChildProcessHandle {
  if (!config.command) throw new Error('spawnProcess: no command given');
  const command = safeExecutable(config.command);
  const args = config.args ?? [];

  const stdio: SpawnOptions['stdio'] = [
    config.stdin ?? 'ignore',
    config.stdout ?? 'pipe',
    config.stderr ?? 'pipe',
  ];
  // Every capability installer hit the .cmd problem (see windowsCmdShim) and
  // setup reported "install failed" on Windows.
  const run = windowsCmdShim([command, ...args], config.env ?? process.env, process.platform, config.cwd);
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- array-form spawn; shell only for a Windows .cmd with every arg quoted and cmd-expanding chars refused (windowsCmdShim)
  const child = nodeSpawn(run.argv[0], run.argv.slice(1), {
    cwd: config.cwd,
    env: config.env as NodeJS.ProcessEnv | undefined,
    stdio,
    shell: run.shell,
    windowsHide: true,
  });

  let settled: number | null = null;
  const exited = new Promise<number>((resolve) => {
    child.on('close', (code, signal) => {
      // A signalled process has no exit code; report the conventional 128+n so
      // callers comparing against zero see a failure rather than `null`.
      settled = code ?? (signal ? 128 : 1);
      resolve(settled);
    });
    child.on('error', () => {
      settled = 1;
      resolve(1);
    });
  });

  return {
    get pid() { return child.pid; },
    exited,
    get exitCode() { return settled; },
    stdout: child.stdout ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>) : null,
    stderr: child.stderr ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>) : null,
    stdin: child.stdin ? (Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>) : null,
    kill(signal) { child.kill(signal as NodeJS.Signals | undefined); },
  };
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run to completion and collect both streams. */
export async function runCommand(config: SpawnConfig): Promise<CommandResult> {
  const proc = spawnProcess({ ...config, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Resolve a binary on PATH without spawning anything.
 *
 * A PATH walk is what `which` does, and doing it in-process keeps the
 * synchronous callers synchronous.
 */
export function whichSync(bin: string, env: Record<string, string | undefined> = process.env, platform = process.platform, cwd?: string): string | null {
  const win = platform === 'win32';
  // A name that already has an extension (`npm.cmd`) is checked as given; one
  // with a path is resolved against the CHILD's cwd, not this process's.
  const exts = win && !extname(bin) ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasPath = /[\\/]/.test(bin);
  const dirs = hasPath ? [resolve(cwd ?? '.')] : (env.PATH ?? env.Path ?? '').split(win ? ';' : delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = hasPath ? resolve(dir, bin + ext) : join(dir, bin + ext);
      try {
        // Windows has no exec bit; existence is what CreateProcess needs.
        accessSync(candidate, win ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Resolve a binary on PATH, or null. */
export async function which(bin: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const { exitCode, stdout } = await runCommand({ command: finder, args: [bin] });
  if (exitCode !== 0) return null;
  return stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
}

/**
 * Windows: route a `.cmd`/`.bat` target (npm, npx, pnpm, yarn…) through cmd.exe.
 *
 * Node's shell-free spawn applies no PATHEXT, so `npx` is `spawn npx ENOENT`,
 * and it refuses to launch a .cmd directly (EINVAL, CVE-2024-27980). Coder
 * agents could not run tests. cmd.exe re-parses the line, so every argument is
 * quoted (`&|<>^` inert) and `"`/`%`/`!` — which escape or expand inside
 * quotes — are refused outright.
 */
export function windowsCmdShim(argv: string[], env: Record<string, string | undefined> = process.env, platform = process.platform, cwd?: string): { argv: string[]; shell: boolean } {
  if (platform !== 'win32' || !argv.length) return { argv, shell: false };
  const [cmd] = argv;
  const target = /\.(cmd|bat)$/i.test(cmd) ? cmd : whichSync(cmd, env, platform, cwd);
  if (!target || !/\.(cmd|bat)$/i.test(target)) return { argv, shell: false };
  const bad = argv.find((a) => /["%!\r\n]/.test(a));
  if (bad !== undefined) {
    throw new Error(`Argument ${JSON.stringify(bad.slice(0, 80))} contains a character cmd.exe expands (" % !); ${cmd} is a .cmd script and runs through cmd.exe.`);
  }
  // The resolved path, not the bare name: cmd.exe running a quoted bare `"npx"` hands the
  // script the CWD as %~dp0, so npx.cmd looks for <cwd>\node_modules\npm and dies.
  return { argv: [target, ...argv.slice(1)].map((a) => `"${a.replace(/(\\+)$/, '$1$1')}"`), shell: true };
}

/**
 * argv that runs `command` through a POSIX shell: `sh -c` everywhere but Windows.
 *
 * Windows has no `sh` on PATH, so every `useShell: true` command and every wake
 * gate was `spawn sh ENOENT`. Git for Windows ships bash, found from git.exe
 * (`<root>\cmd`, `<root>\bin` or `<root>\mingw64\bin`) because its bin dir is
 * rarely on PATH itself. A `bash` on PATH is taken only outside System32 and
 * WindowsApps: those are the WSL launcher, which fails with 0x80070569 when no
 * distro is set up and otherwise runs the command in a different filesystem.
 * cmd.exe is the last resort — not POSIX, but `a && b` and `x > f` still work.
 */
const shellCache = new Map<string, string[]>();

export function posixShellArgv(command: string, env: Record<string, string | undefined> = process.env, platform = process.platform): string[] {
  if (platform !== 'win32') return ['sh', '-c', command];
  // Two PATH walks per call otherwise, on every useShell command and wake gate.
  const key = `${env.PATH ?? env.Path}|${env.PATHEXT}|${env.SystemRoot}|${env.ComSpec}`;
  let shell = shellCache.get(key);
  if (!shell) shellCache.set(key, shell = resolvePosixShell(env, platform));
  return [...shell, command];
}

function resolvePosixShell(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const git = whichSync('git', env, platform);
  const root = git && dirname(git).replace(/[\\/](mingw64[\\/]bin|cmd|bin)$/i, '');
  const sys = join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32').toLowerCase();
  const pathBash = whichSync('bash', env, platform);
  const wslBash = pathBash && (pathBash.toLowerCase().startsWith(sys) || /[\\/]WindowsApps[\\/]/i.test(pathBash));
  const bash = [root && join(root, 'bin', 'bash.exe'), wslBash ? null : pathBash].find((p) => p && existsSync(p));
  // ponytail: Node quotes the cmd.exe arg with \" escapes cmd doesn't read, so a
  // command with inner quotes breaks there; install Git for Windows if it matters.
  return bash ? [bash, '-c'] : [env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', '/d', '/s', '/c'];
}

export async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
