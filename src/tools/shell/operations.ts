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

  /**
   * Spawn a detached, fire-and-forget background process. Subject to the same
   * safety contract as {@link exec}: simple commands are tokenized and spawned
   * with no shell; commands containing shell metacharacters are refused unless
   * `unsafe: true` is passed (audited).
   */
  spawnBackground(
    command: string,
    cwd: string,
    options?: { env?: Record<string, string>; unsafe?: boolean },
  ): Promise<{ pid: number | undefined }>;

  which(command: string): Promise<string | null>;

  getEnv(filter?: string): Promise<Record<string, string>>;
}

export interface ShellExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True if we killed it — for either reason below. Kept for callers that
   *  only care that the command did not finish on its own. */
  killed: boolean;
  /**
   * Why it was killed, reported independently rather than nested inside one
   * another: a command can hit its deadline AND still exit zero (it trapped
   * the signal, or finished in the same tick), and a caller told only
   * "killed" cannot tell a blown deadline from a user cancelling the run.
   */
  timedOut: boolean;
  aborted: boolean;
  /** The signal the process died from, when it died from one. */
  signal: string | null;
}
