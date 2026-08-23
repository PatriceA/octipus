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
  cmd?: string[];
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

/** `spawnProcess(['ls'], opts)` and `spawnProcess({ cmd: ['ls'], ...opts })`. */
export function spawnProcess(first: string[] | SpawnConfig, options: SpawnConfig = {}): ChildProcessHandle {
  const config: SpawnConfig = Array.isArray(first) ? { ...options, cmd: first } : first;
  const [command, ...args] = config.cmd ?? [];
  if (!command) throw new Error('spawnProcess: no command given');

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
export async function runCommand(cmd: string[], options: SpawnConfig = {}): Promise<CommandResult> {
  const proc = spawnProcess(cmd, { ...options, stdout: 'pipe', stderr: 'pipe' });
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
  const { exitCode, stdout } = await runCommand([finder, bin]);
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
