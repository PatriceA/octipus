import { spawn } from 'child_process';
import { coreLogger } from '@/utils/logger';
import type { ShellExecResult, ShellOperations } from './operations';

const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

// Octipus's own root secrets — never leak these into spawned commands.
const SENSITIVE_ENV_EXACT = new Set([
  'MASTER_KEY',
  'JWT_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'POSTGRES_PASSWORD',
]);
// Provider/channel credentials and anything that smells like a secret.
const SENSITIVE_ENV_PATTERN = /(API_KEY|_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/i;

/**
 * Build the environment for a spawned child. The full `process.env` would
 * otherwise hand every command the master key, JWT/session secrets, the DB URL
 * and every provider API key — so a single `env`-dumping or exfiltrating
 * command could read them. Strip the known-sensitive vars; callers that
 * genuinely need a value still pass it explicitly via `extra`.
 */
function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SENSITIVE_ENV_EXACT.has(k) || SENSITIVE_ENV_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/**
 * Conservative POSIX-ish tokenizer. Splits a command string into argv,
 * stripping single/double quotes. Returns `null` if the command contains
 * any shell metacharacter that would enable command injection or
 * unsupported expansion (`;` `&` `|` `<` `>` `` ` `` `$(` `${` `{,}` newline).
 *
 * The intent is to bypass `sh -c` for well-formed simple commands so a
 * compromised LLM cannot inject extra commands via input. Callers that
 * genuinely need shell features must pass `unsafe: true`.
 */
function tokenizeSafe(cmd: string): string[] | null {
  const META = /[;&|<>`\n]/;
  const tokens: string[] = [];
  let buf = '';
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return null;
      buf += cmd.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = cmd.indexOf('"', i + 1);
      if (end === -1) return null;
      const inside = cmd.slice(i + 1, end);
      if (/\$\(|\$\{|`/.test(inside)) return null;
      buf += inside;
      i = end + 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (buf) { tokens.push(buf); buf = ''; }
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      buf += cmd[i + 1];
      i += 2;
      continue;
    }
    // brace expansion: {a,b}
    if (c === '{' && cmd.slice(i).match(/^\{[^{}]*,[^{}]*\}/)) return null;
    if (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) return null;
    if (META.test(c)) return null;
    buf += c;
    i++;
  }
  if (buf) tokens.push(buf);
  return tokens.length > 0 ? tokens : null;
}

/**
 * Local shell operations using child_process.spawn.
 *
 * Safe by default: simple commands run via `spawn(argv[0], argv.slice(1))`
 * with no shell involvement. Commands containing shell metacharacters (pipes,
 * redirects, command substitution, …) are refused unless the caller passes
 * `unsafe: true`, in which case we fall back to `sh -c` and emit an audit log.
 */
export class LocalShellOperations implements ShellOperations {
  async exec(
    command: string,
    cwd: string,
    options: {
      timeout?: number;
      env?: Record<string, string>;
      onData?: (stream: 'stdout' | 'stderr', data: Buffer) => void;
      signal?: AbortSignal;
      unsafe?: boolean;
    } = {},
  ): Promise<ShellExecResult> {
    const argv = options.unsafe ? null : tokenizeSafe(command);

    if (!options.unsafe && argv === null) {
      throw new Error(
        `Shell command rejected — contains metacharacters (;, &, |, <, >, $(), \`, newline, brace expansion). ` +
          `Pass unsafe: true to bypass and run via sh -c. Refused command (truncated): ${command.slice(0, 80)}`,
      );
    }

    if (options.unsafe) {
      coreLogger.warn(
        { cmdPreview: command.slice(0, 120), cwd },
        'shell.exec: unsafe sh -c invocation — caller opted in',
      );
    }

    // Phase 3e — optional process-level sandbox. The wrapper is a
    // no-op when security.shellSandbox is 'off' (default) or when
    // the runner isn't installed in 'auto' mode. In 'required' mode
    // it throws if no runner is available; that surfaces here as a
    // rejected promise so the agent sees a clear error.
    const baseArgv: string[] = options.unsafe
      ? ['sh', '-c', command]
      : [argv![0], ...argv!.slice(1)];

    const { wrapCommand } = await import('@/security/shell-sandbox');
    const wrap = wrapCommand(baseArgv, {
      workspaceRoot: cwd,
      // The shell tool's `unsafe` path opts the user into a less
      // restrictive run; allow network there to keep behavior parity
      // (curl/wget often hide behind unsafe sh -c). Safe-mode shells
      // stay network-isolated.
      allowNetwork: !!options.unsafe,
    });
    const finalArgv = wrap.argv;
    if (wrap.wrapped) {
      coreLogger.debug(
        { runner: wrap.runner, head: finalArgv.slice(0, 4) },
        'shell.exec: wrapped in process sandbox',
      );
    }

    return new Promise((resolve, reject) => {
      const child = spawn(finalArgv[0], finalArgv.slice(1), {
        cwd,
        env: buildChildEnv(options.env),
        timeout: options.timeout,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length <= MAX_OUTPUT_SIZE) {
          stdout += chunk;
        }
        options.onData?.('stdout', data);
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length <= MAX_OUTPUT_SIZE) {
          stderr += chunk;
        }
        options.onData?.('stderr', data);
      });

      const timeoutHandle = options.timeout
        ? setTimeout(() => {
            killed = true;
            child.kill('SIGKILL');
          }, options.timeout)
        : null;

      if (options.signal) {
        const onAbort = () => {
          killed = true;
          child.kill('SIGKILL');
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', () => options.signal!.removeEventListener('abort', onAbort));
      }

      child.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        wrap.cleanup();
        resolve({ stdout, stderr, exitCode: code, killed });
      });

      child.on('error', (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        wrap.cleanup();
        reject(error);
      });
    });
  }

  async spawnBackground(
    command: string,
    cwd: string,
    options: { env?: Record<string, string>; unsafe?: boolean } = {},
  ): Promise<{ pid: number | undefined }> {
    const argv = options.unsafe ? null : tokenizeSafe(command);

    if (!options.unsafe && argv === null) {
      throw new Error(
        `Background command rejected — contains metacharacters (;, &, |, <, >, $(), \`, newline, brace expansion). ` +
          `Pass useShell: true to bypass and run via sh -c. Refused command (truncated): ${command.slice(0, 80)}`,
      );
    }

    if (options.unsafe) {
      coreLogger.warn(
        { cmdPreview: command.slice(0, 120), cwd },
        'shell.spawnBackground: unsafe sh -c invocation — caller opted in',
      );
    }

    const baseArgv: string[] = options.unsafe
      ? ['sh', '-c', command]
      : [argv![0], ...argv!.slice(1)];

    const { wrapCommand } = await import('@/security/shell-sandbox');
    const wrap = wrapCommand(baseArgv, {
      workspaceRoot: cwd,
      allowNetwork: !!options.unsafe,
    });

    const child = spawn(wrap.argv[0], wrap.argv.slice(1), {
      cwd,
      env: buildChildEnv(options.env),
      detached: true,
      stdio: 'ignore',
    });
    // Detached process is fire-and-forget; release the sandbox handle once the
    // child has exited so we don't leak any wrapper state.
    child.on('close', () => wrap.cleanup());
    child.on('error', () => wrap.cleanup());
    child.unref();

    return { pid: child.pid };
  }

  async which(command: string): Promise<string | null> {
    // Reject anything that could break out of the single-arg invocation.
    if (!/^[a-zA-Z0-9_.\-/]+$/.test(command)) return null;
    try {
      const result = await this.exec(`which ${command}`, process.cwd(), { timeout: 5000 });
      const path = result.stdout.trim();
      return path || null;
    } catch {
      return null;
    }
  }

  async getEnv(filter?: string): Promise<Record<string, string>> {
    if (!filter) {
      // Default-deny: refuse to dump full process.env. Caller must
      // request a specific name or substring filter.
      return {};
    }

    const env = { ...process.env } as Record<string, string>;
    const upperFilter = filter.toUpperCase();
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (key.toUpperCase().includes(upperFilter)) {
        filtered[key] = value;
      }
    }
    return filtered;
  }
}
