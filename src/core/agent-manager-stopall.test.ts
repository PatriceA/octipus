import { describe, expect, test } from 'bun:test';
import { AgentManager } from './agent-manager';

/**
 * Disposing has to reach quiescence, not merely request it — and the two
 * callers of `stopAll` want opposite things from the subscriber registry.
 */
type FakeWorker = { getStatus: () => string; stop: () => void; getContext: () => { id: string } };

function fakeWorker(id: string, stopsAfterMs: number): FakeWorker {
  let status = 'running';
  return {
    getStatus: () => status,
    stop: () => {
      setTimeout(() => { status = 'stopped'; }, stopsAfterMs);
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
    const res = await mgr.stopAll();
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
