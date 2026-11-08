import { type ChildProcess, spawn } from 'child_process';
import { mkdir } from 'node:fs/promises';
import { buildChildEnv, buildIsolatedChildEnv } from '@/security/child-env';
import { bridgedArgv, type EgressProxy, proxyEnv, startEgressProxy } from '@/security/egress-proxy';
import { activeSandboxRunner, wrapCommand } from '@/security/shell-sandbox';
import { coreLogger } from '@/utils/logger';
import { killProcessTree, windowsCmdShim } from '@/utils/proc';
import type { CloseHandler, ErrorHandler, MCPTransport, MessageHandler } from './interface';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderrAsError?: boolean;
  /** Hand the child only `env` and a minimal host environment (`buildIsolatedChildEnv`). */
  isolatedEnv?: boolean;
  /**
   * Run the child in the shell sandbox (`security.shellSandbox`), with `root`
   * as its only writable directory — or, with `readOnlyRoot`, read-only and
   * `writable` as the writable ones. With the sandbox off, it runs unwrapped
   * (the mode decides, as for the shell tool).
   *
   * With `egress`, network is limited to its hosts through an in-process
   * proxy (src/security/egress-proxy.ts): enforced when the sandbox wraps the
   * child (Linux: no network namespace route but the proxy; macOS: a Seatbelt
   * profile that allows only the proxy's loopback port), advisory otherwise
   * (only the proxy variables point the child at it). `allowNetwork` is then
   * ignored: direct network stays off whenever the sandbox can turn it off.
   */
  sandbox?: StdioSandbox;
}

export interface StdioSandbox {
  root: string;
  allowNetwork: boolean;
  /** Mount `root` read-only inside the sandbox (a plugin package's files). */
  readOnlyRoot?: boolean;
  /** Writable directories inside the sandbox, created at launch (a package's data directory). */
  writable?: string[];
  /**
   * Per-host egress: who the traffic belongs to, the hosts it may reach, and
   * where the proxy's socket directory goes (`runDir`; not under /tmp, see
   * `EgressProxyOptions.socketParent`).
   */
  egress?: { label: string; hosts: string[]; runDir?: string };
}

/** What `prepareSandboxedLaunch` decided: the argv and env to spawn, and what to clean up. */
export interface SandboxedLaunch {
  argv: string[];
  env: Record<string, string>;
  /** Whether network is actually limited to the egress hosts (or off). */
  networkEnforced: boolean;
  proxy: EgressProxy | null;
  cleanup: () => void;
}

/**
 * Wrap `argv` for the sandbox, starting the egress proxy when the server
 * declares hosts. Exported for tests.
 */
export async function prepareSandboxedLaunch(argv: string[], env: Record<string, string>, sandbox: StdioSandbox): Promise<SandboxedLaunch> {
  const writable = sandbox.writable ?? [];
  for (const dir of writable) await mkdir(dir, { recursive: true });
  const mounts = {
    workspaceRoot: sandbox.root,
    ...(sandbox.readOnlyRoot ? { workspaceReadOnly: true } : {}),
    ...(writable.length > 0 ? { extraReadWrite: writable } : {}),
  };
  const egress = sandbox.egress && sandbox.egress.hosts.length > 0 ? sandbox.egress : null;
  if (!egress) {
    const wrapped = wrapCommand(argv, { ...mounts, allowNetwork: sandbox.allowNetwork, path: env.PATH });
    return { argv: wrapped.argv, env, networkEnforced: wrapped.wrapped, proxy: null, cleanup: wrapped.cleanup };
  }
  // macOS (sandbox-exec): no network namespace to bridge into, so the
  // Seatbelt profile allows outbound TCP to the proxy's own loopback port and
  // nothing else, and the server is pointed at it directly (see
  // buildSeatbeltProfile). Linux runners reach the proxy by its Unix socket.
  const seatbelt = activeSandboxRunner() === 'sandbox-exec';
  const proxy = await startEgressProxy({
    label: egress.label, allowed: egress.hosts, unixSocket: process.platform !== 'win32' && !seatbelt, socketParent: egress.runDir,
  });
  try {
    if (seatbelt) {
      const wrapped = wrapCommand(argv, {
        ...mounts, allowNetwork: false, loopbackPorts: [proxy.port], path: env.PATH, extraReadOnly: [process.execPath],
      });
      if (wrapped.wrapped) {
        return { argv: wrapped.argv, env: { ...env, ...proxyEnv(proxy.url) }, networkEnforced: true, proxy, cleanup: () => { wrapped.cleanup(); void proxy.close(); } };
      }
    } else if (proxy.socketPath && proxy.socketDir) {
      // Inside the sandbox: no network namespace route out, only the proxy
      // socket mounted in and this Node binary to run the launcher.
      const wrapped = wrapCommand(bridgedArgv(argv, proxy.socketPath), {
        ...mounts, allowNetwork: false, path: env.PATH,
        extraReadOnly: [process.execPath], extraReadWrite: [...writable, proxy.socketDir],
      });
      if (wrapped.wrapped) {
        return { argv: wrapped.argv, env, networkEnforced: true, proxy, cleanup: () => { wrapped.cleanup(); void proxy.close(); } };
      }
    }
    // No sandbox (off, no runner, Windows): the proxy is advice only.
    // A client that ignores HTTP(S)_PROXY still connects directly.
    coreLogger.warn({ pkg: egress.label, hosts: egress.hosts },
      'Plugin package network not enforced on this platform: no sandbox wraps the server, so the egress proxy is advisory');
    return { argv, env: { ...env, ...proxyEnv(proxy.url) }, networkEnforced: false, proxy, cleanup: () => { void proxy.close(); } };
  } catch (err) {
    await proxy.close();
    throw err;
  }
}

/**
 * Stdio-based transport — spawns a child process and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null;
  private options: StdioTransportOptions;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private closeHandlers: CloseHandler[] = [];
  private buffer = '';
  private sandboxCleanup: (() => void) | null = null;

  constructor(options: StdioTransportOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const env = this.options.isolatedEnv ? buildIsolatedChildEnv(this.options.env) : buildChildEnv(this.options.env);
    let argv = [this.options.command, ...(this.options.args || [])];
    let childEnv = env;
    if (this.options.sandbox) {
      const launch = await prepareSandboxedLaunch(argv, env, this.options.sandbox);
      argv = launch.argv;
      childEnv = launch.env;
      this.sandboxCleanup = launch.cleanup;
    }
    const run = windowsCmdShim(argv, childEnv, process.platform, this.options.cwd);
    try {
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- operator-configured MCP server; shell only for a Windows .cmd with every arg quoted (windowsCmdShim)
      this.process = spawn(run.argv[0], run.argv.slice(1), {
        cwd: this.options.cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: run.shell,
        windowsHide: true,
      });
    } catch (err) {
      this.sandboxCleanup?.();
      this.sandboxCleanup = null;
      throw err;
    }

    this.process.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          for (const handler of this.messageHandlers) {
            handler(line);
          }
        }
      }
    });

    this.process.stderr!.on('data', (data: Buffer) => {
      if (this.options.stderrAsError === false) return;
      for (const handler of this.errorHandlers) {
        handler(new Error(data.toString()));
      }
    });

    this.process.on('close', () => {
      this.sandboxCleanup?.();
      this.sandboxCleanup = null;
      for (const handler of this.closeHandlers) {
        handler();
      }
    });

    this.process.on('error', (error) => {
      for (const handler of this.errorHandlers) {
        handler(error);
      }
    });
  }

  send(message: string): void {
    if (!this.process) {
      throw new Error('Transport not connected');
    }
    this.process.stdin!.write(message + '\n');
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: CloseHandler): void {
    this.closeHandlers.push(handler);
  }

  /**
   * Close, then wait for the child to exit: SIGKILL after `graceMs` if the
   * terminate signal was not enough, and give up waiting (logged) shortly
   * after that.
   */
  async closeAndWait(graceMs = 3000): Promise<void> {
    const child = this.process;
    this.close();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<boolean>((done) => {
      child.once('exit', () => done(true));
      child.once('error', () => done(true));
    });
    const within = (ms: number) => Promise.race([exited, new Promise<boolean>((done) => setTimeout(() => done(false), ms).unref())]);
    if (await within(graceMs)) return;
    if (process.platform === 'win32') killProcessTree(child.pid, child);
    else child.kill('SIGKILL');
    if (!(await within(2000))) coreLogger.warn({ pid: child.pid, command: this.options.command }, 'MCP server process did not exit after SIGKILL');
  }

  close(): void {
    if (this.process) {
      // Windows: taskkill /T, or the cmd.exe wrapper of an `npx` server dies
      // and its node.exe lives on. Posix: this child is no group leader, so a
      // group kill would miss it — signal it directly.
      if (process.platform === 'win32') killProcessTree(this.process.pid, this.process);
      else this.process.kill();
      this.process = null;
    }
  }
}
