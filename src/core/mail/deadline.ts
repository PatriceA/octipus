/**
 * A hard upper bound on mail work. The protocol libraries only time out a
 * connection that goes silent; a server that trickles a byte now and then
 * never trips that, and would hold a sync (and with it the sweep) forever.
 */
export class MailDeadlineError extends Error {
  constructor(what: string) {
    super(`${what} took too long and was stopped`);
    this.name = 'MailDeadlineError';
  }
}

/** `work`, or a `MailDeadlineError` after `ms`; `onTimeout` tears the connection down. */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* tearing down anyway */ }
      reject(new MailDeadlineError(what));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
