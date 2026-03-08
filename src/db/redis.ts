/**
 * Redis compatibility layer — delegates to the active StorageProvider.
 *
 * Existing code that imports RedisCache/RedisQueue/RedisPubSub keeps working.
 * In embedded mode, these use the in-memory provider instead of ioredis.
 */
import type Redis from 'ioredis';
import { getStorageProvider } from './storage';
import { RedisStorageProvider } from './storage/redis-provider';
import type { CacheProvider, QueueProvider, PubSubProvider } from './storage/types';

/**
 * Get raw ioredis instance (external mode only).
 * In embedded mode, throws if caller truly needs ioredis.
 * Most callers should use RedisCache/getStorageProvider() instead.
 */
export function getRedis(): Redis {
  let provider: import('./storage/types').StorageProvider;
  try { provider = getStorageProvider(); } catch {
    // Not yet initialized — return a lazy proxy
    return createLazyProxy() as unknown as Redis;
  }
  if (provider instanceof RedisStorageProvider) {
    return provider.getRedisClient();
  }
  return createRawProxy() as unknown as Redis;
}

/**
 * Get raw ioredis subscriber (external mode only).
 */
export function getRedisSubscriber(): Redis {
  let provider: import('./storage/types').StorageProvider;
  try { provider = getStorageProvider(); } catch {
    return createLazyProxy() as unknown as Redis;
  }
  if (provider instanceof RedisStorageProvider) {
    return provider.getRedisSubscriber();
  }
  return createRawProxy() as unknown as Redis;
}

/**
 * Close all Redis connections (delegates to storage provider).
 */
export async function closeRedis(): Promise<void> {
  // Handled by closeStorage() — this is kept for backward compat
}

/**
 * Check Redis connection health.
 */
export async function checkRedisHealth(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
  const start = Date.now();
  try {
    const provider = getStorageProvider();
    const ok = await provider.ping();
    return { healthy: ok, latency: Date.now() - start };
  } catch (error) {
    return { healthy: false, error: (error as Error).message };
  }
}

/**
 * Create a minimal proxy that covers the raw ioredis methods used
 * by oauth.ts (setex, get, del) and linking.ts (setex, get, del).
 */
function createRawProxy() {
  const provider = getStorageProvider();
  return {
    get: (key: string) => provider.getRaw(key),
    setex: (key: string, ttl: number, value: string) => provider.setRaw(key, value, ttl),
    del: (key: string) => provider.delRaw(key),
    ping: () => provider.ping().then(() => 'PONG'),
    quit: () => Promise.resolve('OK'),
    on: () => {}, // no-op for event handlers
  };
}

/**
 * Lazy proxy for module-level getRedis() calls that happen before storage init.
 * Defers all operations to the real provider once it's available.
 */
function createLazyProxy() {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === 'on' || prop === 'once' || prop === 'removeListener') return () => {};
      // Defer to real provider on actual use
      return (...args: unknown[]) => {
        const real = getRedis();
        const fn = (real as any)[prop];
        if (typeof fn === 'function') return fn.apply(real, args);
        return fn;
      };
    },
  };
  return new Proxy({}, handler);
}

// ── Compatibility wrappers ──
// These classes delegate to the StorageProvider so existing imports keep working.

export class RedisCache {
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

export class RedisQueue {
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

export class RedisPubSub {
  private _pubsub: PubSubProvider | null = null;

  constructor() {}

  private get pubsub(): PubSubProvider {
    if (!this._pubsub) this._pubsub = getStorageProvider().createPubSub();
    return this._pubsub;
  }

  publish(channel: string, message: unknown): Promise<void> { return this.pubsub.publish(channel, message); }
  subscribe(channel: string, handler: (message: unknown) => void): Promise<void> { return this.pubsub.subscribe(channel, handler); }
  unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void> { return this.pubsub.unsubscribe(channel, handler); }
}
