import Redis from 'ioredis';
import { getConfig } from '@/config';
import { dbLogger } from '@/utils/logger';

let redis: Redis | null = null;
let subscriber: Redis | null = null;

/**
 * Get or create Redis connection
 */
export function getRedis(): Redis {
  if (redis) {
    return redis;
  }

  const config = getConfig();

  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: config.redis.maxRetries,
    retryStrategy: (times) => {
      if (times > config.redis.maxRetries) {
        return null; // Stop retrying
      }
      return Math.min(times * config.redis.retryDelay, 5000);
    },
    keyPrefix: config.redis.keyPrefix,
  });

  redis.on('connect', () => {
    dbLogger.info('Redis connection established');
  });

  redis.on('error', (error) => {
    dbLogger.error({ error }, 'Redis error');
  });

  redis.on('close', () => {
    dbLogger.info('Redis connection closed');
  });

  return redis;
}

/**
 * Get or create Redis subscriber (for pub/sub)
 */
export function getRedisSubscriber(): Redis {
  if (subscriber) {
    return subscriber;
  }

  const config = getConfig();

  subscriber = new Redis(config.redis.url, {
    maxRetriesPerRequest: config.redis.maxRetries,
    keyPrefix: config.redis.keyPrefix,
  });

  subscriber.on('connect', () => {
    dbLogger.info('Redis subscriber connection established');
  });

  return subscriber;
}

/**
 * Close all Redis connections
 */
export async function closeRedis() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
  dbLogger.info('All Redis connections closed');
}

/**
 * Check Redis connection health
 */
export async function checkRedisHealth(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
  const start = Date.now();
  try {
    const r = getRedis();
    await r.ping();
    return { healthy: true, latency: Date.now() - start };
  } catch (error) {
    return { healthy: false, error: (error as Error).message };
  }
}

// Cache helper functions
export class RedisCache {
  private redis: Redis;
  private defaultTtl: number;

  constructor(ttlSeconds: number = 3600) {
    this.redis = getRedis();
    this.defaultTtl = ttlSeconds;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtl;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttl > 0) {
      await this.redis.setex(key, ttl, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  async increment(key: string, by: number = 1): Promise<number> {
    return this.redis.incrby(key, by);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }
}

// Queue helper for task scheduling
export class RedisQueue {
  private redis: Redis;
  private queueName: string;

  constructor(queueName: string) {
    this.redis = getRedis();
    this.queueName = queueName;
  }

  async push(item: unknown, priority: number = 0): Promise<void> {
    const score = Date.now() - priority * 1000; // Lower score = higher priority
    await this.redis.zadd(this.queueName, score, JSON.stringify(item));
  }

  async pop(): Promise<unknown | null> {
    const result = await this.redis.zpopmin(this.queueName);
    if (!result || result.length === 0) return null;
    try {
      return JSON.parse(result[0]);
    } catch {
      return result[0];
    }
  }

  async peek(): Promise<unknown | null> {
    const result = await this.redis.zrange(this.queueName, 0, 0);
    if (!result || result.length === 0) return null;
    try {
      return JSON.parse(result[0]);
    } catch {
      return result[0];
    }
  }

  async length(): Promise<number> {
    return this.redis.zcard(this.queueName);
  }

  async clear(): Promise<void> {
    await this.redis.del(this.queueName);
  }
}

// Pub/Sub helper
export class RedisPubSub {
  private publisher: Redis;
  private subscriber: Redis;
  private handlers: Map<string, Set<(message: unknown) => void>>;

  constructor() {
    this.publisher = getRedis();
    this.subscriber = getRedisSubscriber();
    this.handlers = new Map();

    this.subscriber.on('message', (channel, message) => {
      const handlers = this.handlers.get(channel);
      if (handlers) {
        try {
          const parsed = JSON.parse(message);
          handlers.forEach((handler) => handler(parsed));
        } catch {
          handlers.forEach((handler) => handler(message));
        }
      }
    });
  }

  async publish(channel: string, message: unknown): Promise<void> {
    const serialized = typeof message === 'string' ? message : JSON.stringify(message);
    await this.publisher.publish(channel, serialized);
  }

  async subscribe(channel: string, handler: (message: unknown) => void): Promise<void> {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await this.subscriber.subscribe(channel);
    }
    this.handlers.get(channel)!.add(handler);
  }

  async unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void> {
    const handlers = this.handlers.get(channel);
    if (handlers) {
      if (handler) {
        handlers.delete(handler);
      }
      if (!handler || handlers.size === 0) {
        this.handlers.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    }
  }
}
