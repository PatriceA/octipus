import { type ChildProcess, spawn } from 'child_process';
import { buildChildEnv, buildIsolatedChildEnv } from '@/security/child-env';
import { bridgedArgv, type EgressProxy, proxyEnv, startEgressProxy } from '@/security/egress-proxy';
import { wrapCommand } from '@/security/shell-sandbox';
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
   * as its only writable directory. With the sandbox off, it runs unwrapped
   * (the mode decides, as for the shell tool).
   *
   * With `egress`, network is limited to its hosts through an in-process
   * proxy (src/security/egress-proxy.ts): enforced when the sandbox wraps the
   * child (no network namespace route but the proxy), advisory otherwise
   * (only the proxy variables point the child at it). `allowNetwork` is then
   * ignored: direct network stays off whenever the sandbox can turn it off.
   */
  sandbox?: StdioSandbox;
}

export interface StdioSandbox {
  root: string;
  allowNetwork: boolean;
  /** Per-host egress: who the traffic belongs to and the hosts it may reach. */
  egress?: { label: string; hosts: string[] };
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
  const egress = sandbox.egress && sandbox.egress.hosts.length > 0 ? sandbox.egress : null;
  if (!egress) {
    const wrapped = wrapCommand(argv, { workspaceRoot: sandbox.root, allowNetwork: sandbox.allowNetwork, path: env.PATH });
    return { argv: wrapped.argv, env, networkEnforced: wrapped.wrapped, proxy: null, cleanup: wrapped.cleanup };
  }
  const proxy = await startEgressProxy({ label: egress.label, allowed: egress.hosts, unixSocket: process.platform !== 'win32' });
  try {
    if (proxy.socketPath && proxy.socketDir) {
      // Inside the sandbox: no network namespace route out, only the proxy
      // socket mounted in and this Node binary to run the launcher.
      const wrapped = wrapCommand(bridgedArgv(argv, proxy.socketPath), {
        workspaceRoot: sandbox.root, allowNetwork: false, path: env.PATH,
        extraReadOnly: [process.execPath], extraReadWrite: [proxy.socketDir],
      });
      if (wrapped.wrapped) {
        return { argv: wrapped.argv, env, networkEnforced: true, proxy, cleanup: () => { wrapped.cleanup(); void proxy.close(); } };
      }
    }
    // No sandbox (off, no runner, macOS, Windows): the proxy is advice only.
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
