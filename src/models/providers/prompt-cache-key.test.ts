import { describe, expect, test } from 'vitest';
import { CacheKeyPartitioner, REQUESTS_PER_MINUTE_PER_KEY, scopeKind } from './prompt-cache-key';

const tool = (name: string) => ({ type: 'function', function: { name, parameters: {} } });
const base = { model: 'gpt-5.6', cacheScope: 'root:g1', tools: [tool('filesystem__read_file'), tool('shell__run')] };

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('the prefix family', () => {
  test('sessions sharing model, agent kind and tools share a key; the user and session are not in it', () => {
    const p = new CacheKeyPartitioner(clock().now);
    const a = p.key({ ...base, sessionId: 's1', userId: 'u1' });
    expect(a).toMatch(/^octi-[0-9a-f]{24}$/);
    expect(p.key({ ...base, sessionId: 's2', userId: 'u2' })).toBe(a);
    // A new generation (a clear) is the same family: it resets the conversation, not the prefix.
    expect(p.key({ ...base, cacheScope: 'root:g2', sessionId: 's1' })).toBe(a);
  });

  test('another model, kind or tool list is another family', () => {
    const p = new CacheKeyPartitioner(clock().now);
    const a = p.key({ ...base, sessionId: 's1' });
    expect(p.key({ ...base, model: 'gpt-5.5', sessionId: 's1' })).not.toBe(a);
    expect(p.key({ ...base, cacheScope: 'child:research', sessionId: 's1' })).not.toBe(a);
    expect(p.key({ ...base, tools: [...base.tools].reverse(), sessionId: 's1' })).not.toBe(a);
  });

  test('no session, no key (as before)', () => {
    expect(new CacheKeyPartitioner().key({ ...base })).toBeUndefined();
  });

  test.each([
    [undefined, 'root'], ['root:abc', 'root'], ['child:research', 'child:research'],
    ['companion:owner:g', 'companion'], ['briefing:g', 'briefing'],
  ])('scopeKind(%s) = %s', (scope, kind) => {
    expect(scopeKind(scope)).toBe(kind);
  });
});

describe('partitioning above the per-key rate', () => {
  const sessions = Array.from({ length: 200 }, (_, i) => `s${i}`);

  test('one key up to the documented rate, stable buckets above it', () => {
    const c = clock();
    const p = new CacheKeyPartitioner(c.now);
    for (let i = 0; i < REQUESTS_PER_MINUTE_PER_KEY; i++) {
      expect(p.key({ ...base, sessionId: sessions[i] })).toMatch(/^octi-[0-9a-f]{24}$/);
      c.advance(1000);
    }
    // 4× the rate inside a minute: four partitions, each session in one of them.
    for (let i = 0; i < REQUESTS_PER_MINUTE_PER_KEY * 3; i++) p.key({ ...base, sessionId: sessions[i % sessions.length] });
    const keys = new Set(sessions.map((s) => p.key({ ...base, sessionId: s })));
    expect(keys.size).toBeGreaterThan(1);
    expect(keys.size).toBeLessThanOrEqual(64);
    // A session stays in its bucket while the partition count holds.
    expect(p.key({ ...base, sessionId: 's7' })).toBe(p.key({ ...base, sessionId: 's7' }));
  });

  test('the first split keeps bucket 0 on the unpartitioned key: about half the sessions do not move', () => {
    const c = clock();
    const p = new CacheKeyPartitioner(c.now);
    const single = p.key({ ...base, sessionId: 's0' });
    for (let i = 0; i < REQUESTS_PER_MINUTE_PER_KEY * 2 - 1; i++) p.key({ ...base, sessionId: sessions[i] });
    // Measuring counts too: at one call every 3 s (20 a minute) the family
    // stays at exactly two partitions while every session is asked.
    c.advance(61_000);
    const keys = sessions.map((s) => { c.advance(3000); return p.key({ ...base, sessionId: s }); });
    expect(new Set(keys).size).toBe(2);
    const unmoved = keys.filter((k) => k === single).length;
    expect(unmoved).toBeGreaterThan(sessions.length * 0.3);
    expect(unmoved).toBeLessThan(sessions.length * 0.7);
  });

  test('a quiet minute does not reshuffle a busy family; a long quiet does', () => {
    const c = clock();
    const p = new CacheKeyPartitioner(c.now);
    // Exactly twice the rate, counting the probe below: two partitions.
    for (let i = 0; i < REQUESTS_PER_MINUTE_PER_KEY * 2 - 1; i++) p.key({ ...base, sessionId: sessions[i] });
    const busy = p.key({ ...base, sessionId: 's3' });
    expect(busy).toMatch(/-\d+$/);
    c.advance(2 * 60_000);
    expect(p.key({ ...base, sessionId: 's3' })).toBe(busy);
    c.advance(10 * 60_000);
    expect(p.key({ ...base, sessionId: 's3' })).toMatch(/^octi-[0-9a-f]{24}$/);
  });
});
