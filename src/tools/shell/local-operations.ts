import { spawn } from 'child_process';
import type { ShellOperations, ShellExecResult } from './operations';

const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

/**
 * Local shell operations using child_process.spawn.
 * Executes commands on the host machine via `sh -c`.
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
    } = {},
  ): Promise<ShellExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], {
        cwd,
        env: { ...process.env, ...options.env },
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

      // Support external abort signals
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
        resolve({ stdout, stderr, exitCode: code, killed });
      });

      child.on('error', (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(error);
      });
    });
  }

  async which(command: string): Promise<string | null> {
    try {
      const result = await this.exec(`which ${command}`, process.cwd(), { timeout: 5000 });
      const path = result.stdout.trim();
      return path || null;
    } catch {
      return null;
    }
  }

  async getEnv(filter?: string): Promise<Record<string, string>> {
    const env = { ...process.env } as Record<string, string>;

    if (filter) {
      const upperFilter = filter.toUpperCase();
      const filtered: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (key.toUpperCase().includes(upperFilter)) {
          filtered[key] = value;
        }
      }
      return filtered;
    }

    return env;
  }
}
