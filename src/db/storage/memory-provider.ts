/**
 * In-memory StorageProvider — zero external dependencies.
 * Suitable for single-instance embedded mode.
 */
import { EventEmitter } from 'events';
import { dbLogger } from '@/utils/logger';
import type { StorageProvider, CacheProvider, QueueProvider, PubSubProvider } from './types';

interface CacheEntry {
  value: string;
  expiresAt: number; // epoch ms, 0 = no expiry
}

export class MemoryStorageProvider implements StorageProvider {
  readonly mode = 'embedded' as const;
  private store = new Map<string, CacheEntry>();
  private sweepInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Sweep expired keys every 10 seconds
    this.sweepInterval = setInterval(() => this.sweep(), 10_000);
    dbLogger.info('In-memory storage provider initialized');
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  private getValid(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  createCache(prefix: string, defaultTtl = 3600): CacheProvider {
    const p = prefix ? `${prefix}:` : '';
    const store = this.store;
    const getValid = this.getValid.bind(this);

    return {
      async get<T>(key: string): Promise<T | null> {
        const value = getValid(p + key);
        if (!value) return null;
        try { return JSON.parse(value) as T; } catch { return value as unknown as T; }
      },
      async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
        const ttl = ttlSeconds ?? defaultTtl;
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        store.set(p + key, {
          value: serialized,
          expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
        });
      },
      async delete(key: string): Promise<void> { store.delete(p + key); },
      async exists(key: string): Promise<boolean> { return getValid(p + key) !== null; },
      async increment(key: string, by = 1): Promise<number> {
        const current = getValid(p + key);
        const val = (current ? parseInt(current, 10) || 0 : 0) + by;
        const entry = store.get(p + key);
        store.set(p + key, { value: String(val), expiresAt: entry?.expiresAt ?? 0 });
        return val;
      },
      async expire(key: string, ttlSeconds: number): Promise<void> {
        const entry = store.get(p + key);
        if (entry) {
          entry.expiresAt = Date.now() + ttlSeconds * 1000;
        }
      },
      async ttl(key: string): Promise<number> {
        const entry = store.get(p + key);
        if (!entry) return -2; // key doesn't exist (Redis convention)
        if (entry.expiresAt === 0) return -1; // no expiry
        const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
        return remaining > 0 ? remaining : -2;
      },
    };
  }

  createQueue(name: string): QueueProvider {
    // Sorted array mimicking Redis sorted set
    const items: Array<{ data: string; score: number }> = [];

    return {
      async push(item: unknown, priority = 0): Promise<void> {
        const score = Date.now() - priority * 1000;
        const data = JSON.stringify(item);
        // Insert in sorted order (ascending score)
        const idx = items.findIndex((i) => i.score > score);
        if (idx === -1) items.push({ data, score });
        else items.splice(idx, 0, { data, score });
      },
      async pop(): Promise<unknown | null> {
        const entry = items.shift();
        if (!entry) return null;
        try { return JSON.parse(entry.data); } catch { return entry.data; }
      },
      async peek(): Promise<unknown | null> {
        if (items.length === 0) return null;
        try { return JSON.parse(items[0].data); } catch { return items[0].data; }
      },
      async length(): Promise<number> { return items.length; },
      async clear(): Promise<void> { items.length = 0; },
    };
  }

  createPubSub(): PubSubProvider {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100);

    return {
      async publish(channel: string, message: unknown): Promise<void> {
        const serialized = typeof message === 'string' ? message : JSON.stringify(message);
        // Async dispatch so subscribers don't block the publisher
        queueMicrotask(() => emitter.emit(channel, serialized));
      },
      async subscribe(channel: string, handler: (message: unknown) => void): Promise<void> {
        const wrapper = (raw: string) => {
          try { handler(JSON.parse(raw)); } catch { handler(raw); }
        };
        // Store original handler reference for unsubscribe
        (handler as any).__memWrapper = wrapper;
        emitter.on(channel, wrapper);
      },
      async unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void> {
        if (handler) {
          const wrapper = (handler as any).__memWrapper || handler;
          emitter.off(channel, wrapper);
        } else {
          emitter.removeAllListeners(channel);
        }
      },
    };
  }

  async getRaw(key: string): Promise<string | null> { return this.getValid(key); }
  async setRaw(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  async delRaw(key: string): Promise<void> { this.store.delete(key); }

  async ping(): Promise<boolean> { return true; }

  async close(): Promise<void> {
    clearInterval(this.sweepInterval);
    this.store.clear();
    dbLogger.info('In-memory storage provider closed');
  }
}
