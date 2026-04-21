/**
 * Unit tests for RedisStorageProvider — uses an in-memory fake that mimics the
 * subset of ioredis methods the provider touches. No real Redis server
 * required.
 */
import { mock } from 'bun:test';

// ── Fake ioredis ──────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private zsets = new Map<string, Array<{ member: string; score: number }>>();
  private listeners = new Map<string, Listener[]>();
  private subscribedChannels = new Set<string>();

  /** Used by the test harness to drive pub/sub message events */
  static instances: FakeRedis[] = [];

  constructor(_url?: string, _opts?: unknown) {
    FakeRedis.instances.push(this);
    // emit connect asynchronously so "connect" handlers registered post-ctor fire
    queueMicrotask(() => this.emit('connect'));
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: 0 });
    return 'OK';
  }

  async setex(key: string, ttl: number, value: string): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key) || this.zsets.delete(key);
    return had ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async incrby(key: string, by: number): Promise<number> {
    const current = await this.get(key);
    const n = (current ? parseInt(current, 10) || 0 : 0) + by;
    this.store.set(key, { value: String(n), expiresAt: 0 });
    return n;
  }

  async expire(key: string, ttl: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + ttl * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === 0) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const list = this.zsets.get(key) ?? [];
    list.push({ member, score });
    list.sort((a, b) => a.score - b.score);
    this.zsets.set(key, list);
    return 1;
  }

  async zpopmin(key: string): Promise<string[]> {
    const list = this.zsets.get(key);
    if (!list || list.length === 0) return [];
    const head = list.shift()!;
    return [head.member, String(head.score)];
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.zsets.get(key) ?? [];
    const slice = list.slice(start, stop + 1);
    return slice.map((e) => e.member);
  }

  async zcard(key: string): Promise<number> {
    return (this.zsets.get(key) ?? []).length;
  }

  async publish(channel: string, message: string): Promise<number> {
    // Dispatch 'message' events on every instance currently subscribed to
    // the channel — this mirrors real Redis pub/sub across connections.
    for (const inst of FakeRedis.instances) {
      if (inst.subscribedChannels.has(channel)) {
        queueMicrotask(() => inst.emit('message', channel, message));
      }
    }
    return 1;
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribedChannels.add(channel);
    return this.subscribedChannels.size;
  }

  async unsubscribe(channel?: string): Promise<number> {
    if (channel) this.subscribedChannels.delete(channel);
    else this.subscribedChannels.clear();
    return this.subscribedChannels.size;
  }

  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    this.subscribedChannels.clear();
    this.listeners.clear();
    return 'OK';
  }
}

// Install mock BEFORE importing the provider so it sees the fake class.
mock.module('ioredis', () => ({
  default: FakeRedis,
}));

// ── Imports (must come after mock.module) ────────────────────

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RedisStorageProvider } from './redis-provider';

// ── Fixtures ──────────────────────────────────────────────────

let provider: RedisStorageProvider;

beforeEach(() => {
  FakeRedis.instances = [];
  provider = new RedisStorageProvider({
    url: 'redis://fake',
    keyPrefix: 'test:',
    maxRetries: 3,
    retryDelay: 10,
  });
});

afterEach(async () => {
  await provider.close();
});

// ── Shape ─────────────────────────────────────────────────────

describe('RedisStorageProvider', () => {
  test('mode is external', () => {
    expect(provider.mode).toBe('external');
  });

  test('getRedisClient and getRedisSubscriber return distinct instances', () => {
    const a = provider.getRedisClient();
    const b = provider.getRedisSubscriber();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  test('ping returns true when underlying client responds', async () => {
    expect(await provider.ping()).toBe(true);
  });

  test('ping returns false when client rejects', async () => {
    (provider.getRedisClient() as any).ping = async () => {
      throw new Error('down');
    };
    expect(await provider.ping()).toBe(false);
  });
});

// ── Cache ─────────────────────────────────────────────────────

describe('RedisStorageProvider.createCache', () => {
  test('get returns null for missing key', async () => {
    const cache = provider.createCache('');
    expect(await cache.get('missing')).toBeNull();
  });

  test('set + get round-trips JSON objects', async () => {
    const cache = provider.createCache('');
    await cache.set('k', { a: 1 });
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
  });

  test('set with TTL=0 uses SET (no expiry)', async () => {
    const cache = provider.createCache('', 3600);
    await cache.set('k', 'permanent', 0);
    expect(await cache.get<string>('k')).toBe('permanent');
    expect(await cache.ttl('k')).toBe(-1);
  });

  test('set with positive TTL uses SETEX', async () => {
    const cache = provider.createCache('');
    await cache.set('k', 'short', 60);
    const ttl = await cache.ttl('k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test('delete removes the key', async () => {
    const cache = provider.createCache('');
    await cache.set('k', 'v', 10);
    await cache.delete('k');
    expect(await cache.get('k')).toBeNull();
  });

  test('exists reports membership', async () => {
    const cache = provider.createCache('');
    await cache.set('k', 'v', 10);
    expect(await cache.exists('k')).toBe(true);
    expect(await cache.exists('other')).toBe(false);
  });

  test('increment adds and returns the new value', async () => {
    const cache = provider.createCache('');
    expect(await cache.increment('counter', 5)).toBe(5);
    expect(await cache.increment('counter')).toBe(6);
  });

  test('expire updates the TTL of an existing key', async () => {
    const cache = provider.createCache('');
    await cache.set('k', 'v', 10);
    await cache.expire('k', 500);
    const ttl = await cache.ttl('k');
    expect(ttl).toBeGreaterThan(100);
  });

  test('get falls back to raw value when JSON parse fails', async () => {
    const cache = provider.createCache('');
    // Bypass serialization by writing directly via the raw client
    await provider.getRedisClient().set('weird', 'not-json{{');
    expect(await cache.get<string>('weird')).toBe('not-json{{');
  });

  test('cache uses defaultTtl when none is supplied on set', async () => {
    const cache = provider.createCache('', 120);
    await cache.set('k', 'v');
    const ttl = await cache.ttl('k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });
});

// ── Queue ─────────────────────────────────────────────────────

describe('RedisStorageProvider.createQueue', () => {
  test('push + pop round-trips JSON values', async () => {
    const q = provider.createQueue('jobs');
    await q.push({ n: 1 });
    await new Promise((r) => setTimeout(r, 2));
    await q.push({ n: 2 });
    expect(await q.pop()).toEqual({ n: 1 });
    expect(await q.pop()).toEqual({ n: 2 });
  });

  test('pop returns null on empty queue', async () => {
    const q = provider.createQueue('jobs');
    expect(await q.pop()).toBeNull();
  });

  test('peek returns head without removal', async () => {
    const q = provider.createQueue('jobs');
    await q.push({ first: true });
    expect(await q.peek()).toEqual({ first: true });
    expect(await q.length()).toBe(1);
  });

  test('peek returns null on empty queue', async () => {
    const q = provider.createQueue('jobs');
    expect(await q.peek()).toBeNull();
  });

  test('higher priority items are popped first', async () => {
    const q = provider.createQueue('jobs');
    await q.push('low', 0);
    await q.push('urgent', 100);
    expect(await q.pop()).toBe('urgent');
    expect(await q.pop()).toBe('low');
  });

  test('length reports queue size and clear empties it', async () => {
    const q = provider.createQueue('jobs');
    await q.push(1);
    await q.push(2);
    expect(await q.length()).toBe(2);
    await q.clear();
    expect(await q.length()).toBe(0);
  });

  test('pop falls back to raw string when JSON parse fails', async () => {
    const q = provider.createQueue('weird');
    // Directly insert a non-JSON member
    await provider.getRedisClient().zadd('weird', 1, 'not-json{{');
    expect(await q.pop()).toBe('not-json{{');
  });

  test('peek falls back to raw string when JSON parse fails', async () => {
    const q = provider.createQueue('weird');
    await provider.getRedisClient().zadd('weird', 1, 'not-json[[');
    expect(await q.peek()).toBe('not-json[[');
  });
});

// ── PubSub ────────────────────────────────────────────────────

describe('RedisStorageProvider.createPubSub', () => {
  test('subscribe + publish delivers JSON payloads', async () => {
    const ps = provider.createPubSub();
    const received: unknown[] = [];
    await ps.subscribe('chan', (m) => received.push(m));
    await ps.publish('chan', { hi: 'there' });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([{ hi: 'there' }]);
  });

  test('subscribe + publish delivers string payloads', async () => {
    const ps = provider.createPubSub();
    const received: unknown[] = [];
    await ps.subscribe('chan', (m) => received.push(m));
    await ps.publish('chan', 'plain');
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual(['plain']);
  });

  test('second subscriber on same channel reuses the underlying subscribe', async () => {
    const ps = provider.createPubSub();
    const a: unknown[] = [];
    const b: unknown[] = [];
    await ps.subscribe('chan', (m) => a.push(m));
    await ps.subscribe('chan', (m) => b.push(m));
    await ps.publish('chan', 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  test('unsubscribe with handler removes only that handler', async () => {
    const ps = provider.createPubSub();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const hA = (m: unknown) => a.push(m);
    const hB = (m: unknown) => b.push(m);
    await ps.subscribe('chan', hA);
    await ps.subscribe('chan', hB);
    await ps.unsubscribe('chan', hA);
    await ps.publish('chan', 'keep');
    await new Promise((r) => setTimeout(r, 10));
    expect(a).toEqual([]);
    expect(b).toEqual(['keep']);
  });

  test('unsubscribe with no handler detaches the channel entirely', async () => {
    const ps = provider.createPubSub();
    const received: unknown[] = [];
    await ps.subscribe('chan', (m) => received.push(m));
    await ps.unsubscribe('chan');
    await ps.publish('chan', 'dropped');
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([]);
  });

  test('unsubscribe on an unknown channel is a no-op', async () => {
    const ps = provider.createPubSub();
    await expect(ps.unsubscribe('never-subscribed')).resolves.toBeUndefined();
  });
});

// ── Raw ops ───────────────────────────────────────────────────

describe('RedisStorageProvider raw ops', () => {
  test('setRaw + getRaw round-trip', async () => {
    await provider.setRaw('k', 'v', 60);
    expect(await provider.getRaw('k')).toBe('v');
  });

  test('delRaw removes the key', async () => {
    await provider.setRaw('k', 'v', 60);
    await provider.delRaw('k');
    expect(await provider.getRaw('k')).toBeNull();
  });
});
