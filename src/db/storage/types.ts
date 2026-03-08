/**
 * Storage provider interfaces — abstracts Redis behind a common API
 * so both ioredis (external) and in-memory (embedded) backends work.
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

  /** Raw key-value ops (used by oauth.ts, linking.ts) */
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string, ttlSeconds: number): Promise<void>;
  delRaw(key: string): Promise<void>;

  /** Health check */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
