/**
 * An in-process mutex per key (single process, D16): `run(key, fn)` waits
 * for every earlier `run` of the same key to settle, then runs `fn`. Used
 * for one note's document init, persist and closed-note writes
 * (docs/plans/coworking-spec.md §7.3) and for one space file's
 * compare-and-write (§7.5).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Whether a `run` of `key` is in flight or queued. */
  isHeld(key: string): boolean {
    return this.tails.has(key);
  }
}
