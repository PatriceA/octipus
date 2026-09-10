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
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
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

function safeExecutable(command: string): string {
  if (command.startsWith('-')) {
    throw new Error(`spawnProcess: refusing a command that starts with "-": ${command}`);
  }
  const match = EXECUTABLE_NAME.exec(command);
  if (!match) {
    throw new Error(`spawnProcess: refusing a command with unexpected characters: ${command}`);
  }
  // The MATCH is what gets spawned, not the argument — the validated value and
  // the used value are the same object, so no later edit can let one drift
  // from the other (and a taint analysis can see the barrier).
  return match[0];
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
  const child = nodeSpawn(command, args, {
    cwd: config.cwd,
    env: config.env as NodeJS.ProcessEnv | undefined,
    stdio,
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
export function whichSync(bin: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        accessSync(candidate, constants.X_OK);
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
  return stdout.trim().split('\n')[0] || null;
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
