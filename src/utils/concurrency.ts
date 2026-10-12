/** `fn` over `items`, at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Per-key serial queues: `run(key, fn)` starts `fn` once every earlier `fn`
 * of the same key settled, so work of one key runs in the order it was
 * queued. A failure goes to `onError` and never stalls the queue. `idle(key)`
 * resolves once the key's queue is empty (tests).
 */
export function serialPerKey(onError: (err: unknown, key: string) => void) {
  const tails = new Map<string, Promise<void>>();
  return {
    run(key: string, fn: () => Promise<unknown>): Promise<void> {
      const next = (tails.get(key) ?? Promise.resolve())
        .then(fn)
        .then(() => undefined, (err: unknown) => onError(err, key));
      tails.set(key, next);
      void next.finally(() => { if (tails.get(key) === next) tails.delete(key); });
      return next;
    },
    async idle(key: string): Promise<void> {
      await tails.get(key);
    },
  };
}
