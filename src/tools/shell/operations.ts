/**
 * Abstract interface for shell command execution.
 * Implementations can target local processes, SSH, Docker, etc.
 */
export interface ShellOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      timeout?: number;
      env?: Record<string, string>;
      onData?: (stream: 'stdout' | 'stderr', data: Buffer) => void;
      signal?: AbortSignal;
      /**
       * Opt-in to `sh -c` execution for commands that need shell features
       * (pipes, redirects, command substitution). Defaults to false; safe
       * commands are tokenized and spawned without a shell. Audited.
       */
      unsafe?: boolean;
    },
  ): Promise<ShellExecResult>;

  which(command: string): Promise<string | null>;

  getEnv(filter?: string): Promise<Record<string, string>>;
}

export interface ShellExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}
