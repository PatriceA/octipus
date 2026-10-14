import { describe, expect, test } from 'vitest';
import { AgentManager } from './agent-manager';

/**
 * Disposing has to reach quiescence, not merely request it — and the two
 * callers of `stopAll` want opposite things from the subscriber registry.
 */
type FakeWorker = { getStatus: () => string; isSettling: () => boolean; stop: () => void; getContext: () => { id: string } };

function fakeWorker(id: string, stopsAfterMs: number): FakeWorker {
  let status = 'running';
  let settling = true;
  return {
    getStatus: () => status,
    isSettling: () => settling,
    stop: () => {
      status = 'stopped';
      setTimeout(() => { settling = false; }, stopsAfterMs).unref();
    },
    getContext: () => ({ id }),
  };
}

/** Reach into the private map — the manager has no injection seam for workers. */
function withWorkers(mgr: AgentManager, workers: Record<string, FakeWorker>): void {
  const map = (mgr as unknown as { agents: Map<string, unknown> }).agents;
  for (const [id, w] of Object.entries(workers)) map.set(id, w);
}

describe('AgentManager.stopAll', () => {
  test('waits for a worker that takes a moment to wind down', async () => {
    const mgr = new AgentManager();
    withWorkers(mgr, { a: fakeWorker('a', 120) });
    const started = Date.now();
    const res = await mgr.stopAll();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    // Returning while it was still running is the defect: the rest of the
    // teardown then runs against a worker that is still mid-tool.
    expect(res.stopped).toBe(1);
    expect(res.stillRunning).toBe(0);
  });

  test('gives up on a worker that will not go, rather than hanging shutdown', async () => {
    const mgr = new AgentManager();
    withWorkers(mgr, { b: fakeWorker('b', 60_000) });
    const started = Date.now();
    const res = await mgr.stopAll({ timeoutMs: 200 });
    expect(res.stillRunning).toBe(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('keeps subscribers unless shutdown explicitly silences them', async () => {
    const mgr = new AgentManager();
    let calls = 0;
    mgr.onEvent(() => { calls++; });

    withWorkers(mgr, { c: fakeWorker('c', 10) });
    await mgr.stopAll();
    // The live /stop-all command runs in a process that keeps going; clearing
    // its subscribers would leave the UI event stream dead for good.
    (mgr as unknown as { eventHandlers: Set<(e: unknown) => void> }).eventHandlers
      .forEach((h) => h({} as never));
    expect(calls).toBe(1);

    await mgr.stopAll({ silenceListeners: true });
    expect((mgr as unknown as { eventHandlers: Set<unknown> }).eventHandlers.size).toBe(0);
  });
});

test('removed workers remain visible to shutdown until they settle', async () => {
  const mgr = new AgentManager();
  withWorkers(mgr, { removed: fakeWorker('removed', 120) });
  expect(mgr.remove('removed')).toBe(true);
  const started = Date.now();
  const result = await mgr.stopAll();
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  expect(result.stillRunning).toBe(0);
});

describe('AgentManager.cleanup', () => {
  function worker(id: string, status: string, ageMs: number): FakeWorker {
    return {
      getStatus: () => status,
      isSettling: () => false,
      stop: () => {},
      getContext: () => ({ id, updatedAt: new Date(Date.now() - ageMs) }),
    } as FakeWorker;
  }
  const index = (mgr: AgentManager) => (mgr as unknown as { childrenByParent: Map<string, Set<string>> }).childrenByParent;

  test('drops finished workers after the retention window, with their cascade edges', () => {
    const mgr = new AgentManager();
    withWorkers(mgr, {
      parent: worker('parent', 'running', 0),
      old: worker('old', 'completed', AgentManager.FINISHED_RETENTION_MS + 1_000),
      fresh: worker('fresh', 'completed', 1_000),
    });
    index(mgr).set('parent', new Set(['old', 'fresh']));
    index(mgr).set('old', new Set(['grandchild']));
    expect(mgr.cleanup()).toBe(1);
    expect(mgr.get('old')).toBeUndefined();
    expect(mgr.get('fresh')).toBeDefined();
    expect([...index(mgr).get('parent')!]).toEqual(['fresh']);
    // A cleaned-up parent keeps its edges while a child may still be in memory.
    expect(index(mgr).has('old')).toBe(true);
  });
});
