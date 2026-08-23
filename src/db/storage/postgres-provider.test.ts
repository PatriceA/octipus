/**
 * The Postgres storage provider, against a real Postgres.
 *
 * Skipped outside the integration lane: the whole point is that the semantics
 * come from the database, so a fake would only assert the fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration } from '@/test-helpers/integration';
import { queryRaw } from '@/db/postgres';
import { PostgresStorageProvider } from './postgres-provider';

describe.skipIf(!isIntegration)('PostgresStorageProvider (Integration)', () => {
  let provider: PostgresStorageProvider;

  beforeAll(async () => {
    await setupIntegrationDb();
    provider = new PostgresStorageProvider();
  });

  afterAll(async () => {
    await provider.close();
    await teardownIntegration();
  });

  beforeEach(async () => {
    await queryRaw('DELETE FROM kv_store');
    await queryRaw('DELETE FROM kv_queue');
  });

  describe('cache', () => {
    test('round-trips a value and reports its presence', async () => {
      const cache = provider.createCache('t');
      await cache.set('k', { a: 1 });
      expect(await cache.get('k')).toEqual({ a: 1 });
      expect(await cache.exists('k')).toBe(true);
      await cache.delete('k');
      expect(await cache.get('k')).toBeNull();
      expect(await cache.exists('k')).toBe(false);
    });

    test('the prefix scopes keys, so two caches do not collide', async () => {
      const a = provider.createCache('a');
      const b = provider.createCache('b');
      await a.set('same', 'from-a');
      await b.set('same', 'from-b');
      expect(await a.get('same')).toBe('from-a');
      expect(await b.get('same')).toBe('from-b');
    });

    test('an expired key is invisible before the sweep runs', async () => {
      const cache = provider.createCache('t');
      await cache.set('gone', 'value', 60);
      // Expire it in the past without touching the sweep — the read filter is
      // what has to enforce this, because the sweep is only reclaiming space.
      await queryRaw(`UPDATE kv_store SET expires_at = now() - interval '1 second' WHERE key = 't:gone'`);
      expect(await cache.get('gone')).toBeNull();
      expect(await cache.exists('gone')).toBe(false);
      expect(await cache.ttl('gone')).toBe(-2);
      const { rows } = await queryRaw(`SELECT 1 FROM kv_store WHERE key = 't:gone'`);
      expect(rows.length).toBe(1); // still on disk, and still not readable
    });

    test('ttl reports -1 without an expiry and -2 for an absent key', async () => {
      const cache = provider.createCache('t');
      await cache.set('forever', 'v', 0);
      expect(await cache.ttl('forever')).toBe(-1);
      expect(await cache.ttl('never-written')).toBe(-2);
      await cache.set('soon', 'v', 100);
      expect(await cache.ttl('soon')).toBeGreaterThan(90);
    });

    test('expire sets a TTL on an existing key', async () => {
      const cache = provider.createCache('t');
      await cache.set('k', 'v', 0);
      await cache.expire('k', 50);
      expect(await cache.ttl('k')).toBeGreaterThan(40);
    });

    test('concurrent increments do not lose one another', async () => {
      const cache = provider.createCache('t');
      // The read-modify-write shape this replaces would settle well under 50.
      await Promise.all(Array.from({ length: 50 }, () => cache.increment('hits')));
      expect(await cache.increment('hits', 0)).toBe(50);
    });

    test('increment on an expired counter restarts from zero', async () => {
      const cache = provider.createCache('t');
      await cache.increment('c', 7);
      await queryRaw(`UPDATE kv_store SET expires_at = now() - interval '1 second' WHERE key = 't:c'`);
      expect(await cache.increment('c', 1)).toBe(1);
    });
  });

  describe('queue', () => {
    test('pops in push order, including within one millisecond', async () => {
      // Twenty in a tight loop share a millisecond, so `score` ties for most of
      // them. Without an insertion-order tiebreak the order fell back to a
      // random uuid and the queue was FIFO only by accident.
      const q = provider.createQueue('jobs');
      for (let n = 0; n < 20; n++) await q.push({ n });
      expect(await q.length()).toBe(20);
      expect(await q.peek()).toEqual({ n: 0 });
      const popped: number[] = [];
      for (let i = 0; i < 20; i++) popped.push((await q.pop() as { n: number }).n);
      expect(popped).toEqual([...Array(20).keys()]);
      expect(await q.pop()).toBeNull();
    });

    test('a higher priority sorts ahead of an earlier push', async () => {
      const q = provider.createQueue('jobs');
      await q.push({ n: 'normal' });
      await q.push({ n: 'urgent' }, 10);
      expect(await q.pop()).toEqual({ n: 'urgent' });
    });

    test('two poppers take different items rather than the same one', async () => {
      const q = provider.createQueue('jobs');
      for (let i = 0; i < 20; i++) await q.push({ i });
      const taken = await Promise.all(Array.from({ length: 20 }, () => q.pop()));
      const ids = taken.map((t) => (t as { i: number }).i).sort((a, b) => a - b);
      expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(await q.length()).toBe(0);
    });

    test('queues are independent and clear only removes their own', async () => {
      const a = provider.createQueue('a');
      const b = provider.createQueue('b');
      await a.push(1);
      await b.push(2);
      await a.clear();
      expect(await a.length()).toBe(0);
      expect(await b.length()).toBe(1);
    });
  });

  describe('pub/sub', () => {
    const settle = () => new Promise((r) => setTimeout(r, 300));

    test('a subscriber receives a published message', async () => {
      const ps = provider.createPubSub();
      const seen: unknown[] = [];
      await ps.subscribe('chan', (m) => seen.push(m));
      await ps.publish('chan', { hello: 'world' });
      await settle();
      expect(seen).toEqual([{ hello: 'world' }]);
      await ps.unsubscribe('chan');
    });

    test('a message too large for NOTIFY still arrives whole', async () => {
      // NOTIFY caps the payload at 8000 bytes. The spill path is the reason a
      // large message is delivered rather than dropped or throwing.
      const ps = provider.createPubSub();
      const big = { body: 'x'.repeat(20_000) };
      const seen: unknown[] = [];
      await ps.subscribe('big', (m) => seen.push(m));
      await ps.publish('big', big);
      await settle();
      expect(seen).toEqual([big]);
      await ps.unsubscribe('big');
    });

    test('unsubscribe stops delivery to that handler only', async () => {
      const ps = provider.createPubSub();
      const a: unknown[] = [];
      const b: unknown[] = [];
      const handlerA = (m: unknown) => a.push(m);
      await ps.subscribe('chan', handlerA);
      await ps.subscribe('chan', (m) => b.push(m));
      await ps.unsubscribe('chan', handlerA);
      await ps.publish('chan', 'ping');
      await settle();
      expect(a).toEqual([]);
      expect(b).toEqual(['ping']);
      await ps.unsubscribe('chan');
    });

    test('concurrent subscribes on one channel both keep working', async () => {
      // Both callers used to miss the map, both LISTEN, and the second write
      // stranded the first handler set — so unsubscribe was a no-op for it and
      // it kept firing forever.
      const ps = provider.createPubSub();
      const a: unknown[] = [];
      const b: unknown[] = [];
      const handlerA = (m: unknown) => a.push(m);
      const handlerB = (m: unknown) => b.push(m);
      await Promise.all([ps.subscribe('race', handlerA), ps.subscribe('race', handlerB)]);

      await ps.publish('race', 'one');
      await settle();
      expect(a).toEqual(['one']);
      expect(b).toEqual(['one']);

      await ps.unsubscribe('race', handlerA);
      await ps.publish('race', 'two');
      await settle();
      expect(a).toEqual(['one']); // actually unsubscribed
      expect(b).toEqual(['one', 'two']);
      await ps.unsubscribe('race');
    });

    test('a throwing subscriber does not stop the others', async () => {
      const ps = provider.createPubSub();
      const seen: unknown[] = [];
      await ps.subscribe('chan', () => { throw new Error('bad subscriber'); });
      await ps.subscribe('chan', (m) => seen.push(m));
      await ps.publish('chan', 'still-delivered');
      await settle();
      expect(seen).toEqual(['still-delivered']);
      await ps.unsubscribe('chan');
    });
  });

  describe('raw keys', () => {
    test('set without a TTL persists, set with one expires', async () => {
      await provider.setRaw('plain', 'v');
      expect(await provider.getRaw('plain')).toBe('v');
      // Asserted through the API rather than the column, so the check does not
      // depend on how the driver spells `expires_at`. -1 is "no expiry".
      expect(await provider.createCache('').ttl('plain')).toBe(-1);

      await provider.setRaw('temp', 'v', 60);
      await queryRaw(`UPDATE kv_store SET expires_at = now() - interval '1 second' WHERE key = 'temp'`);
      expect(await provider.getRaw('temp')).toBeNull();

      await provider.delRaw('plain');
      expect(await provider.getRaw('plain')).toBeNull();
    });
  });

  test('ping succeeds against a live database', async () => {
    expect(await provider.ping()).toBe(true);
  });
});
