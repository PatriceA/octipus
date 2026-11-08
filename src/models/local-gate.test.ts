import { describe, expect, test } from 'vitest';
import { LocalModelGate, localRunnerKey } from './local-gate';
import { requestPriority } from './rate-limiter';

describe('requestPriority', () => {
  test('nobody-waiting request types are background; everything else interactive', () => {
    for (const requestType of ['compaction', 'compaction-map', 'memory_extraction', 'learning-review']) {
      expect(requestPriority({ requestType })).toBe('background');
    }
    for (const requestType of ['chat', 'embedding', 'toolshim', 'decision', undefined]) {
      expect(requestPriority({ requestType })).toBe('interactive');
    }
    expect(requestPriority({ requestType: 'chat', priority: 'background' })).toBe('background');
  });
});

describe('LocalModelGate', () => {
  test('only local runners are gated, one key per endpoint', () => {
    expect(localRunnerKey('ollama', 'http://gpu-a:11434')).toBe('ollama:http://gpu-a:11434');
    expect(localRunnerKey('ollama')).toBe('ollama:default');
    expect(localRunnerKey('anthropic')).toBeUndefined();
  });

  test('interactive calls never wait, even while background work runs', async () => {
    const gate = new LocalModelGate({ quietMs: 50 });
    const bg = await gate.enter('r', 'background');
    const started = Date.now();
    const release = await gate.enter('r', 'interactive');
    expect(Date.now() - started).toBeLessThan(20);
    release(); bg();
  });

  test('a background call waits for the foreground to finish and stay quiet', async () => {
    const gate = new LocalModelGate({ quietMs: 40 });
    const fg = await gate.enter('r', 'interactive');
    let entered = 0;
    const bg = gate.enter('r', 'background').then((release) => { entered = Date.now(); return release; });
    await new Promise((r) => setTimeout(r, 30));
    expect(entered).toBe(0);
    const endedAt = Date.now();
    fg();
    (await bg)();
    expect(entered - endedAt).toBeGreaterThanOrEqual(35);
  });

  test('another runner does not hold it back, and the wait is bounded', async () => {
    const gate = new LocalModelGate({ quietMs: 10_000, maxWaitMs: 30 });
    const other = await gate.enter('other', 'interactive');
    const t0 = Date.now();
    (await gate.enter('r', 'background'))();
    expect(Date.now() - t0).toBeLessThan(20);
    const fg = await gate.enter('r', 'interactive');
    const t1 = Date.now();
    (await gate.enter('r', 'background'))();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(25);
    fg(); other();
  });

  test('an aborted background call stops waiting', async () => {
    const gate = new LocalModelGate({ quietMs: 10_000 });
    const fg = await gate.enter('r', 'interactive');
    const ac = new AbortController();
    const waiting = gate.enter('r', 'background', ac.signal);
    ac.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    fg();
  });
});
