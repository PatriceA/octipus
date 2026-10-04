/**
 * Storage provider interfaces — one API over the two backends: Postgres for
 * `external`, an in-process map for `embedded`.
 */

export interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  increment(key: string, by?: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
}

export interface QueueProvider {
  push(item: unknown, priority?: number): Promise<void>;
  pop(): Promise<unknown | null>;
  peek(): Promise<unknown | null>;
  length(): Promise<number>;
  clear(): Promise<void>;
}

export interface PubSubProvider {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: unknown) => void): Promise<void>;
  unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void>;
}

export interface StorageProvider {
  readonly mode: 'embedded' | 'external';

  createCache(prefix: string, defaultTtl?: number): CacheProvider;
  createQueue(name: string): QueueProvider;
  createPubSub(): PubSubProvider;

  /** Raw key-value ops. Omitting the TTL stores the key without expiry. */
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delRaw(key: string): Promise<void>;
  /**
   * Read and delete `key` in one atomic step (Redis `GETDEL`). Returns the
   * live value, or null when the key is absent or expired. Of two concurrent
   * callers, exactly one gets the value: the redeem primitive for one-time codes.
   */
  takeRaw(key: string): Promise<string | null>;
  /**
   * Set `key` only if it is absent (an expired key counts as absent), with a
   * TTL, in one atomic step. Returns true when this call set it. The claim
   * primitive for work that must run once across processes.
   */
  setRawIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Set `key` (with a TTL) only if it is absent, expired, or already holds
   * exactly `value`, in one atomic step. Returns true when it was set. Renews
   * a claim made with {@link setRawIfAbsent} without overwriting anyone
   * else's value.
   */
  setRawIfAbsentOrEqual(key: string, value: string, ttlSeconds: number): Promise<boolean>;

  /** Health check */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
