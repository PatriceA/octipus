/**
 * Cache, queue and pub/sub, over whichever storage provider is active.
 *
 * Named for what it does rather than for the product that used to back it: the
 * external provider is Postgres now, and the embedded one never was Redis.
 */
import { getStorageProvider } from './storage';
import type { CacheProvider, PubSubProvider, QueueProvider } from './storage/types';

/**
 * Raw string get/set/del, for the three callers that store an opaque value
 * rather than a typed cache entry (OAuth state, device pairing codes, the
 * scheduler heartbeat).
 */
export function rawStore() {
  return {
    get: (key: string) => getStorageProvider().getRaw(key),
    /** Omit the TTL for a key that should not expire (the heartbeat). */
    set: (key: string, value: string, ttlSeconds?: number) =>
      getStorageProvider().setRaw(key, value, ttlSeconds),
    setex: (key: string, ttlSeconds: number, value: string) =>
      getStorageProvider().setRaw(key, value, ttlSeconds),
    del: (key: string) => getStorageProvider().delRaw(key),
  };
}

/** Storage health, for the health and metrics routes. */
export async function checkCacheHealth(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
  const start = Date.now();
  try {
    const ok = await getStorageProvider().ping();
    return { healthy: ok, latency: Date.now() - start };
  } catch (error) {
    return { healthy: false, error: (error as Error).message };
  }
}

export class Cache {
  private _cache: CacheProvider | null = null;
  private defaultTtl: number;

  constructor(ttlSeconds: number = 3600) {
    this.defaultTtl = ttlSeconds;
  }

  private get cache(): CacheProvider {
    if (!this._cache) this._cache = getStorageProvider().createCache('', this.defaultTtl);
    return this._cache;
  }

  get<T>(key: string): Promise<T | null> { return this.cache.get<T>(key); }
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> { return this.cache.set(key, value, ttlSeconds); }
  delete(key: string): Promise<void> { return this.cache.delete(key); }
  exists(key: string): Promise<boolean> { return this.cache.exists(key); }
  increment(key: string, by?: number): Promise<number> { return this.cache.increment(key, by); }
  expire(key: string, ttlSeconds: number): Promise<void> { return this.cache.expire(key, ttlSeconds); }
  ttl(key: string): Promise<number> { return this.cache.ttl(key); }
}

export class Queue {
  private _queue: QueueProvider | null = null;
  private queueName: string;

  constructor(queueName: string) {
    this.queueName = queueName;
  }

  private get queue(): QueueProvider {
    if (!this._queue) this._queue = getStorageProvider().createQueue(this.queueName);
    return this._queue;
  }

  push(item: unknown, priority?: number): Promise<void> { return this.queue.push(item, priority); }
  pop(): Promise<unknown | null> { return this.queue.pop(); }
  peek(): Promise<unknown | null> { return this.queue.peek(); }
  length(): Promise<number> { return this.queue.length(); }
  clear(): Promise<void> { return this.queue.clear(); }
}

export class PubSub {
  private _pubsub: PubSubProvider | null = null;

  private get pubsub(): PubSubProvider {
    if (!this._pubsub) this._pubsub = getStorageProvider().createPubSub();
    return this._pubsub;
  }

  publish(channel: string, message: unknown): Promise<void> { return this.pubsub.publish(channel, message); }
  subscribe(channel: string, handler: (message: unknown) => void): Promise<void> { return this.pubsub.subscribe(channel, handler); }
  unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void> { return this.pubsub.unsubscribe(channel, handler); }
}
