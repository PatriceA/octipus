/**
 * Retry keys (docs/plans/orchestration-gaps-2026-11.md §2): one run per
 * (user, scope, key); a finished outcome replays, a running one is joined
 * and then reported in progress with its meta, a different request under the
 * same key is a mismatch, and a failure or an outcome not kept frees the key.
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { closeStorage, getStorageProvider, initializeStorage } from '@/db/storage';
import { _resetIdempotency, runIdempotent } from './idempotency';

beforeAll(() => { initializeStorage({ mode: 'embedded' }); });
afterAll(async () => { await closeStorage(); });
beforeEach(() => { _resetIdempotency(); });

let n = 0;
const fresh = () => `key-${++n}`;

test('a finished call replays its stored outcome without running again', async () => {
  const key = fresh();
  const run = vi.fn(async () => ({ id: 'p1' }));
  expect(await runIdempotent({ userId: 'u', scope: 's', key, run })).toEqual({ kind: 'fresh', value: { id: 'p1' } });
  expect(await runIdempotent({ userId: 'u', scope: 's', key, run })).toEqual({ kind: 'replayed', value: { id: 'p1' } });
  expect(run).toHaveBeenCalledTimes(1);
});

test('keys are per user and per scope', async () => {
  const key = fresh();
  const run = vi.fn(async () => 'x');
  await runIdempotent({ userId: 'a', scope: 's', key, run });
  await runIdempotent({ userId: 'b', scope: 's', key, run });
  await runIdempotent({ userId: 'a', scope: 't', key, run });
  expect(run).toHaveBeenCalledTimes(3);
});

test('a retry while the first call runs joins it and gets its value', async () => {
  const key = fresh();
  let release!: (v: string) => void;
  const first = runIdempotent({ userId: 'u', scope: 's', key, run: () => new Promise<string>(r => { release = r; }) });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const second = vi.fn(async () => 'second');
  const retry = runIdempotent({ userId: 'u', scope: 's', key, run: second, joinWaitMs: 5_000 });
  release('first');
  expect(await first).toEqual({ kind: 'fresh', value: 'first' });
  expect(await retry).toEqual({ kind: 'replayed', value: 'first' });
  expect(second).not.toHaveBeenCalled();
});

test('past the join wait a retry is told the call is in progress, with its meta', async () => {
  const key = fresh();
  let release!: () => void;
  const first = runIdempotent({ userId: 'u', scope: 's', key, run: async (track) => {
    await track.setMeta({ sessionId: 'sess-1' });
    await new Promise<void>(r => { release = r; });
    return 'done';
  } });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(await runIdempotent({ userId: 'u', scope: 's', key, run: async () => 'dup', joinWaitMs: 50 }))
    .toEqual({ kind: 'in_progress', meta: { sessionId: 'sess-1' } });
  release();
  await first;
});

test('the same key for a different request is a mismatch', async () => {
  const key = fresh();
  await runIdempotent({ userId: 'u', scope: 's', key, fingerprint: 'a', run: async () => 1 });
  expect(await runIdempotent({ userId: 'u', scope: 's', key, fingerprint: 'b', run: async () => 2 })).toEqual({ kind: 'mismatch' });
});

test('a failure or an outcome not kept frees the key for a retry', async () => {
  const key = fresh();
  await expect(runIdempotent({ userId: 'u', scope: 's', key, run: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  expect(await runIdempotent({ userId: 'u', scope: 's', key, run: async () => 'bad', keep: () => false }))
    .toEqual({ kind: 'fresh', value: 'bad' });
  expect(await runIdempotent({ userId: 'u', scope: 's', key, run: async () => 'good' })).toEqual({ kind: 'fresh', value: 'good' });
});

test('with the shared store down, dedupe still holds within the process', async () => {
  const provider = getStorageProvider();
  const spies = (['setRawIfAbsent', 'getRaw', 'setRaw', 'delRaw', 'setRawIfAbsentOrEqual'] as const)
    .map(name => vi.spyOn(provider, name).mockRejectedValue(new Error('down')));
  try {
    const key = fresh();
    const run = vi.fn(async () => 'once');
    await runIdempotent({ userId: 'u', scope: 's', key, run });
    expect(await runIdempotent({ userId: 'u', scope: 's', key, run })).toEqual({ kind: 'replayed', value: 'once' });
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
