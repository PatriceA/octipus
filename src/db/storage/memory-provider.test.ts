import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorageProvider } from './memory-provider';

// ── Fixtures ──────────────────────────────────────────────────

let provider: MemoryStorageProvider;

beforeEach(() => {
  provider = new MemoryStorageProvider();
});

afterEach(async () => {
  await provider.close();
});

// ── Provider shape ────────────────────────────────────────────

describe('MemoryStorageProvider', () => {
  test('mode is embedded', () => {
    expect(provider.mode).toBe('embedded');
  });

  test('ping returns true', async () => {
    expect(await provider.ping()).toBe(true);
  });
});

// ── Cache ─────────────────────────────────────────────────────

describe('MemoryStorageProvider.createCache', () => {
  test('get returns null for missing key', async () => {
    const cache = provider.createCache('test');
    expect(await cache.get('missing')).toBeNull();
  });

  test('set + get round-trips JSON values', async () => {
    const cache = provider.createCache('test');
    await cache.set('foo', { a: 1, b: [2, 3] });
    expect(await cache.get<{ a: number; b: number[] }>('foo')).toEqual({ a: 1, b: [2, 3] });
  });

  test('set + get round-trips string values', async () => {
    const cache = provider.createCache('test');
    await cache.set('greet', 'hello');
    expect(await cache.get<string>('greet')).toBe('hello');
  });

  test('delete removes a key', async () => {
    const cache = provider.createCache('test');
    await cache.set('k', 'v');
    await cache.delete('k');
    expect(await cache.get('k')).toBeNull();
  });

  test('exists returns true for existing keys and false otherwise', async () => {
    const cache = provider.createCache('test');
    await cache.set('k', 'v');
    expect(await cache.exists('k')).toBe(true);
    expect(await cache.exists('other')).toBe(false);
  });

  test('increment starts at by-value for missing keys and accumulates', async () => {
    const cache = provider.createCache('test');
    expect(await cache.increment('counter')).toBe(1);
    expect(await cache.increment('counter', 5)).toBe(6);
    expect(await cache.increment('counter', -2)).toBe(4);
  });

  test('prefix isolates keys across caches', async () => {
    const a = provider.createCache('nsA');
    const b = provider.createCache('nsB');
    await a.set('k', 'valueA');
    await b.set('k', 'valueB');
    expect(await a.get<string>('k')).toBe('valueA');
    expect(await b.get<string>('k')).toBe('valueB');
  });

  test('empty prefix does not produce key prefix', async () => {
    const cache = provider.createCache('');
    await cache.set('raw', 'value');
    // getRaw should find the un-prefixed key
    expect(await provider.getRaw('raw')).toBe('value');
  });

  test('ttl returns -2 for missing key (Redis convention)', async () => {
    const cache = provider.createCache('test');
    expect(await cache.ttl('missing')).toBe(-2);
  });

  test('ttl returns -1 for key without expiry', async () => {
    const cache = provider.createCache('test');
    await cache.set('k', 'v', 0); // 0 = no expiry
    expect(await cache.ttl('k')).toBe(-1);
  });

  test('ttl returns positive seconds for key with expiry', async () => {
    const cache = provider.createCache('test');
    await cache.set('k', 'v', 60);
    const ttl = await cache.ttl('k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test('expired keys return null', async () => {
    const cache = provider.createCache('test');
    await cache.set('k', 'v', 1);
    // Force-expire by manipulating the internal store via raw access
    const store = (provider as any).store as Map<string, { value: string; expiresAt: number }>;
    const entry = store.get('test:k');
    expect(entry).toBeDefined();
    entry!.expiresAt = Date.now() - 1000;
    expect(await cache.get('k')).toBeNull();
    expect(await cache.exists('k')).toBe(false);
  });

  test('expire updates ttl of existing key', async () => {
    const cache = provider.createCache('test');
    await cache.set('k', 'v', 10);
    await cache.expire('k', 100);
    const ttl = await cache.ttl('k');
    expect(ttl).toBeGreaterThan(60);
  });

  test('get gracefully falls back to raw string when JSON parse fails', async () => {
    // Write a non-JSON value into a cache-prefixed key directly
    const cache = provider.createCache('test');
    const store = (provider as any).store as Map<string, { value: string; expiresAt: number }>;
    store.set('test:weird', { value: 'not-json{{', expiresAt: 0 });
    expect(await cache.get<string>('weird')).toBe('not-json{{');
  });
});

// ── Queue ─────────────────────────────────────────────────────

describe('MemoryStorageProvider.createQueue', () => {
  test('push + pop round-trips values in FIFO order (default priority)', async () => {
    const q = provider.createQueue('q1');
    await q.push({ n: 1 });
    // tiny pause so time advances and scores differ
    await new Promise((r) => setTimeout(r, 2));
    await q.push({ n: 2 });
    expect(await q.pop()).toEqual({ n: 1 });
    expect(await q.pop()).toEqual({ n: 2 });
  });

  test('pop returns null on empty queue', async () => {
    const q = provider.createQueue('q1');
    expect(await q.pop()).toBeNull();
  });

  test('peek returns null on empty queue', async () => {
    const q = provider.createQueue('q1');
    expect(await q.peek()).toBeNull();
  });

  test('peek does not remove the head', async () => {
    const q = provider.createQueue('q1');
    await q.push({ n: 1 });
    expect(await q.peek()).toEqual({ n: 1 });
    expect(await q.length()).toBe(1);
  });

  test('higher priority items are popped first', async () => {
    const q = provider.createQueue('q1');
    await q.push({ tag: 'low' }, 0);
    await q.push({ tag: 'high' }, 100);
    expect(await q.pop()).toEqual({ tag: 'high' });
    expect(await q.pop()).toEqual({ tag: 'low' });
  });

  test('clear empties the queue', async () => {
    const q = provider.createQueue('q1');
    await q.push('a');
    await q.push('b');
    await q.clear();
    expect(await q.length()).toBe(0);
    expect(await q.pop()).toBeNull();
  });

  test('length reports current size', async () => {
    const q = provider.createQueue('q1');
    expect(await q.length()).toBe(0);
    await q.push(1);
    await q.push(2);
    expect(await q.length()).toBe(2);
  });
});

// ── PubSub ────────────────────────────────────────────────────

describe('MemoryStorageProvider.createPubSub', () => {
  test('subscribe + publish delivers JSON messages', async () => {
    const ps = provider.createPubSub();
    const received: unknown[] = [];
    await ps.subscribe('chan', (msg) => received.push(msg));
    await ps.publish('chan', { hello: 'world' });
    // queueMicrotask dispatch — wait a tick
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toEqual([{ hello: 'world' }]);
  });

  test('subscribe + publish delivers string messages', async () => {
    const ps = provider.createPubSub();
    const received: unknown[] = [];
    await ps.subscribe('chan', (msg) => received.push(msg));
    await ps.publish('chan', 'plain-text');
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toEqual(['plain-text']);
  });

  test('unsubscribe with handler stops delivery for that handler', async () => {
    const ps = provider.createPubSub();
    const received: unknown[] = [];
    const handler = (msg: unknown) => received.push(msg);
    await ps.subscribe('chan', handler);
    await ps.unsubscribe('chan', handler);
    await ps.publish('chan', 'ignored');
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toEqual([]);
  });

  test('unsubscribe without handler clears all subscribers on a channel', async () => {
    const ps = provider.createPubSub();
    const received: unknown[] = [];
    await ps.subscribe('chan', (m) => received.push(['a', m]));
    await ps.subscribe('chan', (m) => received.push(['b', m]));
    await ps.unsubscribe('chan');
    await ps.publish('chan', 'dropped');
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toEqual([]);
  });
});

// ── Raw ops ───────────────────────────────────────────────────

describe('MemoryStorageProvider raw ops', () => {
  test('getRaw returns null for missing key', async () => {
    expect(await provider.getRaw('none')).toBeNull();
  });

  test('setRaw + getRaw round-trips a string', async () => {
    await provider.setRaw('k', 'value', 60);
    expect(await provider.getRaw('k')).toBe('value');
  });

  test('delRaw removes a key', async () => {
    await provider.setRaw('k', 'value', 60);
    await provider.delRaw('k');
    expect(await provider.getRaw('k')).toBeNull();
  });

  test('setRaw respects TTL', async () => {
    await provider.setRaw('k', 'v', 60);
    const store = (provider as any).store as Map<string, { value: string; expiresAt: number }>;
    const entry = store.get('k');
    expect(entry?.expiresAt).toBeGreaterThan(Date.now());
  });
});

// ── Close + lifecycle ─────────────────────────────────────────

describe('MemoryStorageProvider.close', () => {
  test('close clears store and stops sweep interval', async () => {
    const p = new MemoryStorageProvider();
    await p.setRaw('k', 'v', 60);
    await p.close();
    const store = (p as any).store as Map<string, unknown>;
    expect(store.size).toBe(0);
  });
});
