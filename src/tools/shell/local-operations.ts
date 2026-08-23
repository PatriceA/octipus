import { spawn } from 'child_process';
import { buildChildEnv, isSensitiveEnvName } from '@/security/child-env';
import { coreLogger } from '@/utils/logger';
import { tokenizeSafe } from './policy';
import type { ShellExecResult, ShellOperations } from './operations';

const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

/**
 * PIDs of process GROUPS this process started and has not yet reaped.
 *
 * `detached: true` is what lets a deadline kill a whole tree — without it a
 * backgrounded grandchild keeps the stdio pipes open and `close` never fires.
 * It also means the child no longer shares our process group, so a signal sent
 * to the group on shutdown never reaches it: stop the backend mid-`npm test`
 * and the test run carries on with its pipes attached to a dead parent.
 *
 * So the group we deliberately detached, we deliberately reap. Registered on
 * `exit`, which runs after a SIGTERM/SIGINT handler has done its work, and is
 * synchronous — `process.kill` is too, so this is legal in that handler. It
 * cannot help with SIGKILL or a hard crash; nothing in-process can.
 */
const liveGroups = new Set<number>();
let reaperInstalled = false;

function trackGroup(pid: number | undefined): () => void {
  if (pid === undefined) return () => {};
  liveGroups.add(pid);
  if (!reaperInstalled) {
    reaperInstalled = true;
    process.once('exit', () => {
      for (const gid of liveGroups) {
        try {
          process.kill(-gid, 'SIGKILL');
        } catch {
          // Already gone. Nothing to do, and `exit` handlers must not throw.
        }
      }
      liveGroups.clear();
    });
  }
  return () => liveGroups.delete(pid);
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
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- array-form spawn (no shell); this is the shell tool's own executor, argv already parsed/sandboxed upstream
      // No `timeout` option here on purpose: node's own timer kills with
      // SIGTERM on its own schedule, racing the timer below and landing a kill
      // that sets none of the flags explaining it. One deadline, one owner.
      const child = spawn(finalArgv[0], finalArgv.slice(1), {
        cwd,
        env: buildChildEnv(options.env),
        // Its own process group, so a deadline can kill the whole tree. Killing
        // the direct child alone leaves `sh -c "sleep 10 & sleep 10"` holding
        // the stdio pipes, and `close` — which is what resolves this promise —
        // waits for those: the call sat unresolved long past a 500ms timeout.
        detached: true,
      });

      const untrack = trackGroup(child.pid);
      let stdout = '';
      let stderr = '';
      let killed = false;
      let timedOut = false;
      let aborted = false;

      /** Kill the whole group, falling back to the child if it is already gone. */
      const killTree = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // ESRCH: the group is already gone. Nothing to do.
        }
      };

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
            // `exit` fires before `close`, and the pipes can flush a tick after
            // the deadline. Without this the command that finished in time is
            // reported as having blown its budget, and the model is told to
            // split work that already succeeded.
            if (child.exitCode !== null || child.signalCode !== null) return;
            killed = true;
            timedOut = true;
            killTree();
          }, options.timeout)
        : null;

      const onAbort = (): void => {
        killed = true;
        aborted = true;
        killTree();
      };
      if (options.signal) {
        // A signal that aborted BEFORE this call never fires the event, so the
        // command would run to completion after its run was cancelled — and
        // report `aborted: false` while doing it.
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      /** Runs on either terminal event; `error` may fire without a `close`. */
      const cleanup = (): void => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener('abort', onAbort);
        untrack();
        wrap.cleanup();
      };

      child.on('close', (code, signal) => {
        cleanup();
        resolve({ stdout, stderr, exitCode: code, killed, timedOut, aborted, signal });
      });

      child.on('error', (error) => {
        cleanup();
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

    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- array-form spawn (no shell); this is the shell tool's own detached executor, argv already parsed/sandboxed upstream
    const child = spawn(wrap.argv[0], wrap.argv.slice(1), {
      cwd,
      env: buildChildEnv(options.env),
      detached: true,
      stdio: 'ignore',
    });
    // NOT tracked by `trackGroup`, unlike `exec`. Outliving this process is the
    // whole point here — the caller asked for a background process (a dev
    // server, a watcher) and reaping it at shutdown would defeat the feature.
    // `exec`'s groups are detached only so a deadline can reach the tree, so
    // those get reaped; these are detached because the user said so.
    //
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
      // A credential is no less leaked for having been asked for by name.
      // Stripping these from spawned commands while answering `env MASTER_KEY`
      // in the same process would be a door next to a wall.
      if (isSensitiveEnvName(key)) continue;
      if (key.toUpperCase().includes(upperFilter)) {
        filtered[key] = value;
      }
    }
    return filtered;
  }
}
