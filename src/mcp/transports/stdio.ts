import { type ChildProcess, spawn } from 'child_process';
import { buildChildEnv, buildIsolatedChildEnv } from '@/security/child-env';
import { wrapCommand } from '@/security/shell-sandbox';
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
   */
  sandbox?: { root: string; allowNetwork: boolean };
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
    if (this.options.sandbox) {
      const wrapped = wrapCommand(argv, { workspaceRoot: this.options.sandbox.root, allowNetwork: this.options.sandbox.allowNetwork, path: env.PATH });
      argv = wrapped.argv;
      this.sandboxCleanup = wrapped.cleanup;
    }
    const run = windowsCmdShim(argv, env, process.platform, this.options.cwd);
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- operator-configured MCP server; shell only for a Windows .cmd with every arg quoted (windowsCmdShim)
    this.process = spawn(run.argv[0], run.argv.slice(1), {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: run.shell,
      windowsHide: true,
    });

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
