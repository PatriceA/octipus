import { afterEach, describe, expect, test } from 'vitest';
import { collectStream } from '@/models/stream-collect';
import { leaderFirst, prefixFamilyKey, resetLeaderFirst, takeWarmSignal } from './leader-first';

afterEach(() => resetLeaderFirst());

const key = prefixFamilyKey('parent-1', 'research', 'research');
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('leader-first fan-out', () => {
  test('siblings start once the leader has its first chunk, not before', async () => {
    const started: string[] = [];
    let fire: (() => void) | undefined;
    let finishLeader!: () => void;
    const leader = leaderFirst(key, async () => {
      started.push('leader');
      fire = takeWarmSignal(); // what the leader's worker does when its run starts
      await new Promise<void>((r) => { finishLeader = r; });
    });
    const siblings = [1, 2, 3].map((n) => leaderFirst(key, async () => { started.push(`sibling-${n}`); }));
    await tick();
    expect(started).toEqual(['leader']);
    fire!(); // the first streamed chunk
    await Promise.all(siblings);
    expect(started).toEqual(['leader', 'sibling-1', 'sibling-2', 'sibling-3']);
    finishLeader();
    await leader;
  });

  test('a leader that never streams holds nobody past the wait cap', async () => {
    const started: string[] = [];
    const leader = leaderFirst(key, async () => { started.push('leader'); await new Promise(() => {}); });
    await leaderFirst(key, async () => { started.push('sibling'); }, { waitMs: 10 });
    expect(started).toEqual(['leader', 'sibling']);
    void leader;
  });

  test('a leader that fails or finishes releases its siblings', async () => {
    let failLeader!: (err: Error) => void;
    const leader = leaderFirst(key, () => new Promise<void>((_, reject) => { failLeader = reject; }));
    const sibling = leaderFirst(key, async () => 'ran');
    await tick();
    failLeader(new Error('provider down'));
    await expect(leader).rejects.toThrow('provider down');
    await expect(sibling).resolves.toBe('ran');
  });

  test('a warm family starts later siblings at once; another family has its own leader', async () => {
    await leaderFirst(key, async () => takeWarmSignal()?.());
    const order: string[] = [];
    let release!: () => void;
    const other = prefixFamilyKey('parent-1', 'coding', 'build');
    const otherLeader = leaderFirst(other, () => new Promise<void>((r) => { release = r; order.push('other-leader'); }));
    await leaderFirst(key, async () => { order.push('warm-sibling'); });
    expect(order).toEqual(['other-leader', 'warm-sibling']);
    release();
    await otherLeader;
  });

  test('only the first worker of a leader scope takes the signal; nested spawns open their own', async () => {
    await leaderFirst(key, async () => {
      const first = takeWarmSignal();
      expect(first).toBeTypeOf('function');
      expect(takeWarmSignal()).toBeUndefined(); // a retry's second worker
      await leaderFirst(prefixFamilyKey('child-1', 'research', 'research'), async () => {
        expect(takeWarmSignal()).toBeTypeOf('function'); // the grandchild leads its own family
      });
      first!();
    });
    expect(takeWarmSignal()).toBeUndefined(); // outside any scope
  });

  test('the stream reports its first chunk once', async () => {
    let firsts = 0;
    async function* chunks() { yield { content: 'a' }; yield { content: 'b' }; }
    const result = await collectStream(chunks(), { model: 'm', messages: [] }, 'test', undefined, { chunks: 0, onFirst: () => { firsts++; } });
    expect(result.content).toBe('ab');
    expect(firsts).toBe(1);
  });
});
