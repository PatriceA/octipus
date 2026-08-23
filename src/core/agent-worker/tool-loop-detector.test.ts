/**
 * The run-wide redundant-call check.
 *
 * Both pre-existing checks are consecutive-only, so an alternating A,B,A,B,A
 * sequence — the same file read three times with a write in between — trips
 * neither. That is the shape behind the measured tool-call variance (2 calls
 * one run, 14 the next), so the case is pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_TOTAL_REPEATS, ToolLoopDetector } from './tool-loop-detector';

const call = (name: string, args: unknown) => [{ id: name, name, arguments: args } as never];

describe('checkRedundant', () => {
  test('an alternating repeat trips, where the consecutive checks do not', () => {
    const d = new ToolLoopDetector();
    const read = () => call('filesystem__read', { path: '/a.ts' });
    const write = () => call('filesystem__write', { path: '/b.ts' });

    expect(d.checkRedundant(read()).tripped).toBe(false);
    expect(d.checkRedundant(write()).tripped).toBe(false);
    expect(d.checkRedundant(read()).tripped).toBe(false); // re-read after a write
    expect(d.checkRedundant(write()).tripped).toBe(false);
    expect(d.checkRedundant(read()).tripped).toBe(false); // verify-after-fix
    expect(d.checkRedundant(write()).tripped).toBe(false);

    const fourth = d.checkRedundant(read());
    expect(fourth.tripped).toBe(true);
    expect(fourth.signature).toBe('filesystem__read');
    expect(fourth.count).toBe(4);

    // The consecutive checks saw nothing wrong with any of it.
    const c = new ToolLoopDetector();
    for (const t of [read(), write(), read(), write(), read(), write(), read()]) {
      expect(c.checkRepeat(t).tripped).toBe(false);
    }
  });

  test('different arguments are different questions', () => {
    const d = new ToolLoopDetector();
    for (const p of ['/a.ts', '/b.ts', '/c.ts', '/d.ts', '/e.ts']) {
      expect(d.checkRedundant(call('filesystem__read', { path: p })).tripped).toBe(false);
    }
  });

  test('the loser of a same-iteration tie is still reported later', () => {
    const d = new ToolLoopDetector();
    const a = { id: 'a', name: 'filesystem__read', arguments: { path: '/a.ts' } } as never;
    const b = { id: 'b', name: 'filesystem__read', arguments: { path: '/b.ts' } } as never;

    // A parallel batch: both signatures reach the threshold on the same call,
    // so only one can be reported. The other must not be recorded as nudged —
    // it never was — or it can never be reported for the rest of the run.
    for (let i = 1; i < MAX_TOTAL_REPEATS; i++) {
      expect(d.checkRedundant([a, b]).tripped).toBe(false);
    }
    // Both cross on this call; one is reported.
    expect(d.checkRedundant([a, b]).tripped).toBe(true);
    // The one that lost is still eligible, so the next call reports it.
    expect(d.checkRedundant([a, b]).tripped).toBe(true);
    // And now both have been reported, so it goes quiet again.
    expect(d.checkRedundant([a, b]).tripped).toBe(false);
  });

  test('a signature is nudged once, not on every further repeat', () => {
    const d = new ToolLoopDetector();
    const c = () => call('shell__exec', { cmd: 'ls' });
    expect(d.checkRedundant(c()).tripped).toBe(false);
    expect(d.checkRedundant(c()).tripped).toBe(false);
    expect(d.checkRedundant(c()).tripped).toBe(false);
    expect(d.checkRedundant(c()).tripped).toBe(true);
    expect(d.checkRedundant(c()).tripped).toBe(false);
    expect(d.checkRedundant(c()).tripped).toBe(false);
  });
});
