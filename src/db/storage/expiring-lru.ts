/**
 * A bounded in-process map whose entries expire: the best-effort fallback the
 * claim stores (webhook delivery ids, idempotency keys) use while the shared
 * kv store errors. Insertion order is LRU order; past `maxEntries` the oldest
 * entry is dropped, so a flood of keys can't grow memory.
 */
export class ExpiringLru<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V, ttlSeconds: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
