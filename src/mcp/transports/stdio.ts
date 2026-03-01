import { spawn, type ChildProcess } from 'child_process';
import type { MCPTransport, MessageHandler, ErrorHandler, CloseHandler } from './interface';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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

  constructor(options: StdioTransportOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.process = spawn(this.options.command, this.options.args || [], {
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
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
      for (const handler of this.errorHandlers) {
        handler(new Error(data.toString()));
      }
    });

    this.process.on('close', () => {
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
      this.process.kill();
      this.process = null;
    }
  }
}
