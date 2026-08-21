/**
 * Redis-backed StorageProvider — wraps ioredis for external mode.
 */
import Redis from 'ioredis';
import { dbLogger } from '@/utils/logger';
import type { CacheProvider, PubSubProvider, QueueProvider, StorageProvider } from './types';

export interface RedisProviderConfig {
  url: string;
  keyPrefix: string;
  maxRetries: number;
  retryDelay: number;
}

export class RedisStorageProvider implements StorageProvider {
  readonly mode = 'external' as const;
  private redis: Redis;
  private subscriber: Redis;

  constructor(config: RedisProviderConfig) {
    this.redis = new Redis(config.url, {
      maxRetriesPerRequest: config.maxRetries,
      retryStrategy: (times) => {
        if (times > config.maxRetries) return null;
        return Math.min(times * config.retryDelay, 5000);
      },
      keyPrefix: config.keyPrefix,
    });

    this.subscriber = new Redis(config.url, {
      maxRetriesPerRequest: config.maxRetries,
      keyPrefix: config.keyPrefix,
    });

    this.redis.on('connect', () => dbLogger.info('Redis connection established'));
    this.redis.on('error', (error) => dbLogger.error({ error }, 'Redis error'));
    this.redis.on('close', () => dbLogger.info('Redis connection closed'));
    this.subscriber.on('connect', () => dbLogger.info('Redis subscriber connection established'));
  }

  /** Expose raw Redis instance for backward compat (getRedis()) */
  getRedisClient(): Redis { return this.redis; }
  getRedisSubscriber(): Redis { return this.subscriber; }

  createCache(_prefix: string, defaultTtl = 3600): CacheProvider {
    const redis = this.redis;
    return {
      async get<T>(key: string): Promise<T | null> {
        const value = await redis.get(key);
        if (!value) return null;
        try { return JSON.parse(value) as T; } catch { return value as unknown as T; }
      },
      async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
        const ttl = ttlSeconds ?? defaultTtl;
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (ttl > 0) { await redis.setex(key, ttl, serialized); }
        else { await redis.set(key, serialized); }
      },
      async delete(key: string): Promise<void> { await redis.del(key); },
      async exists(key: string): Promise<boolean> { return (await redis.exists(key)) === 1; },
      async increment(key: string, by = 1): Promise<number> { return redis.incrby(key, by); },
      async expire(key: string, ttlSeconds: number): Promise<void> { await redis.expire(key, ttlSeconds); },
      async ttl(key: string): Promise<number> { return redis.ttl(key); },
    };
  }

  createQueue(queueName: string): QueueProvider {
    const redis = this.redis;
    return {
      async push(item: unknown, priority = 0): Promise<void> {
        const score = Date.now() - priority * 1000;
        // ioredis 6 types the sorted-set score and range bounds as
        // `string | Buffer`; the wire protocol has always sent them as strings,
        // so this is the same command with the coercion made explicit.
        await redis.zadd(queueName, String(score), JSON.stringify(item));
      },
      async pop(): Promise<unknown | null> {
        const result = await redis.zpopmin(queueName);
        if (!result || result.length === 0) return null;
        try { return JSON.parse(result[0]); } catch { return result[0]; }
      },
      async peek(): Promise<unknown | null> {
        const result = await redis.zrange(queueName, 0, '0');
        if (!result || result.length === 0) return null;
        try { return JSON.parse(result[0]); } catch { return result[0]; }
      },
      async length(): Promise<number> { return redis.zcard(queueName); },
      async clear(): Promise<void> { await redis.del(queueName); },
    };
  }

  createPubSub(): PubSubProvider {
    const publisher = this.redis;
    const subscriber = this.subscriber;
    const handlers = new Map<string, Set<(message: unknown) => void>>();

    subscriber.on('message', (channel, message) => {
      const set = handlers.get(channel);
      if (set) {
        try {
          const parsed = JSON.parse(message);
          set.forEach((h) => h(parsed));
        } catch {
          set.forEach((h) => h(message));
        }
      }
    });

    return {
      async publish(channel: string, message: unknown): Promise<void> {
        const serialized = typeof message === 'string' ? message : JSON.stringify(message);
        await publisher.publish(channel, serialized);
      },
      async subscribe(channel: string, handler: (message: unknown) => void): Promise<void> {
        if (!handlers.has(channel)) {
          handlers.set(channel, new Set());
          await subscriber.subscribe(channel);
        }
        handlers.get(channel)!.add(handler);
      },
      async unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void> {
        const set = handlers.get(channel);
        if (set) {
          if (handler) set.delete(handler);
          if (!handler || set.size === 0) {
            handlers.delete(channel);
            await subscriber.unsubscribe(channel);
          }
        }
      },
    };
  }

  async getRaw(key: string): Promise<string | null> { return this.redis.get(key); }
  async setRaw(key: string, value: string, ttlSeconds: number): Promise<void> { await this.redis.setex(key, ttlSeconds, value); }
  async delRaw(key: string): Promise<void> { await this.redis.del(key); }

  async ping(): Promise<boolean> {
    try { await this.redis.ping(); return true; } catch { return false; }
  }

  async close(): Promise<void> {
    await this.redis.quit();
    await this.subscriber.quit();
    dbLogger.info('All Redis connections closed');
  }
}
