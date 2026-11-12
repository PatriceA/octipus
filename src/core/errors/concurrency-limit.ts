/**
 * The global concurrent-agent cap (`agent.maxConcurrentAgents`) refused a
 * spawn before any worker existed. Distinct from a user quota
 * (`QuotaExceededError`): this one is the whole server being busy. The
 * message text is unchanged from the plain Error it replaces.
 */
export class ConcurrencyLimitError extends Error {
  readonly code = 'CONCURRENCY_LIMIT';
  readonly max: number;
  constructor(max: number) {
    super(`Maximum concurrent agents (${max}) reached`);
    this.name = 'ConcurrencyLimitError';
    this.max = max;
  }
}

/** True for a {@link ConcurrencyLimitError}, also across module copies (matched by name). */
export function isConcurrencyLimitError(err: unknown): err is ConcurrencyLimitError {
  return err instanceof ConcurrencyLimitError || (err instanceof Error && err.name === 'ConcurrencyLimitError');
}
