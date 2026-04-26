import { describe, test, expect } from 'bun:test';
import { AgentManager } from '@/core/agent-manager';

/**
 * Verify that `AgentManager.stop(id, {cascade:true})` aborts the
 * in-memory children index transitively. We don't use the real spawn
 * path (that requires DB + LLM wiring); instead we inject a dummy worker
 * into the manager via a narrowly-typed cast.
 *
 * Keeps the test hermetic while exercising:
 *  - stop(id, {cascade:true}) pathway
 *  - childrenByParent traversal
 *  - AbortController firing on each descendant
 */

interface StubWorker {
  id: string;
  stopped: boolean;
  abortFired: boolean;
  abortController: AbortController;
}

function makeStubWorker(id: string): StubWorker {
  const ctrl = new AbortController();
  return {
    id,
    stopped: false,
    abortFired: false,
    abortController: ctrl,
  };
}

function attachStub(mgr: AgentManager, stub: StubWorker, parentAgentId?: string): void {
  // Inject into the private agents map + optional parent→child edge.
  const m = mgr as unknown as {
    agents: Map<string, unknown>;
    childrenByParent: Map<string, Set<string>>;
  };
  m.agents.set(stub.id, {
    getStatus: () => 'running',
    stop: () => {
      stub.stopped = true;
      stub.abortController.abort('stop-called');
    },
    getContext: () => ({ id: stub.id, sessionId: 'sess', userId: 'u', topic: '', model: '', role: 'research', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} }),
  });
  stub.abortController.signal.addEventListener('abort', () => { stub.abortFired = true; });
  if (parentAgentId) {
    let set = m.childrenByParent.get(parentAgentId);
    if (!set) {
      set = new Set<string>();
      m.childrenByParent.set(parentAgentId, set);
    }
    set.add(stub.id);
  }
}

describe('AgentManager.stop({cascade:true}) — Phase 2', () => {
  test('stops root + direct children + grandchildren', () => {
    const mgr = new AgentManager();
    const root = makeStubWorker('root');
    const child1 = makeStubWorker('c1');
    const child2 = makeStubWorker('c2');
    const grand = makeStubWorker('g1');

    attachStub(mgr, root);
    attachStub(mgr, child1, 'root');
    attachStub(mgr, child2, 'root');
    attachStub(mgr, grand, 'c1');

    const ok = mgr.stop('root', { cascade: true });
    expect(ok).toBe(true);
    expect(root.stopped).toBe(true);
    expect(child1.stopped).toBe(true);
    expect(child2.stopped).toBe(true);
    expect(grand.stopped).toBe(true);
    expect(root.abortFired).toBe(true);
    expect(child1.abortFired).toBe(true);
    expect(child2.abortFired).toBe(true);
    expect(grand.abortFired).toBe(true);
  });

  test('cascade:false stops only the target', () => {
    const mgr = new AgentManager();
    const root = makeStubWorker('root2');
    const child = makeStubWorker('c');
    attachStub(mgr, root);
    attachStub(mgr, child, 'root2');

    mgr.stop('root2'); // default cascade:false
    expect(root.stopped).toBe(true);
    expect(child.stopped).toBe(false);
  });

  test('stopping a leaf is safe (no descendants)', () => {
    const mgr = new AgentManager();
    const leaf = makeStubWorker('leaf');
    attachStub(mgr, leaf);
    expect(() => mgr.stop('leaf', { cascade: true })).not.toThrow();
    expect(leaf.stopped).toBe(true);
  });
});

describe('parent AbortSignal wiring — construction path', () => {
  test('AgentWorker constructor accepts parentSignal; abort cascades into internal controller', async () => {
    // Dynamic import to avoid loading heavy deps at module scan time.
    const { AgentWorker } = await import('@/core/agent-worker');
    const parent = new AbortController();
    const worker = new AgentWorker(
      {
        id: 'w-x',
        sessionId: '00000000-0000-0000-0000-000000000000',
        userId: 'u',
        topic: '',
        model: 'm',
        role: 'research',
        status: 'idle',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      { maxIterations: 1, contextWindowSize: 1000, timeout: 1000, maxTokenBudget: 1000 },
      { parentSignal: parent.signal },
    );

    const internal = worker.getAbortSignal();
    expect(internal.aborted).toBe(false);
    parent.abort('parent-stop');
    // queueMicrotask / synchronous event dispatch — await a tick.
    await new Promise((r) => setImmediate(r));
    expect(internal.aborted).toBe(true);
  });

  test('AgentWorker constructed with already-aborted parent signal aborts on next tick', async () => {
    const { AgentWorker } = await import('@/core/agent-worker');
    const parent = new AbortController();
    parent.abort('pre-aborted');
    const worker = new AgentWorker(
      {
        id: 'w-y',
        sessionId: '00000000-0000-0000-0000-000000000000',
        userId: 'u',
        topic: '',
        model: 'm',
        role: 'research',
        status: 'idle',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      { maxIterations: 1, contextWindowSize: 1000, timeout: 1000, maxTokenBudget: 1000 },
      { parentSignal: parent.signal },
    );
    await new Promise((r) => setImmediate(r));
    expect(worker.getAbortSignal().aborted).toBe(true);
  });
});

describe('CLIAgentWorker — parent AbortSignal wiring (Phase 3 polish)', () => {
  test('CLIAgentWorker constructor accepts parentSignal; abort triggers stop()', async () => {
    const { CLIAgentWorker } = await import('@/core/cli-agent-worker');
    const parent = new AbortController();
    const worker = new CLIAgentWorker(
      {
        id: 'cli-x',
        sessionId: '00000000-0000-0000-0000-000000000000',
        userId: 'u',
        topic: '',
        model: 'cli/claude',
        role: 'research',
        status: 'idle',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      { maxIterations: 1, contextWindowSize: 1000, timeout: 1000, maxTokenBudget: 1000 },
      { parentSignal: parent.signal },
    );

    // Sanity: aborted flag is private — read it via cast, same pattern as
    // the AgentWorker tests above. Status is the public observable.
    expect((worker as unknown as { aborted: boolean }).aborted).toBe(false);
    parent.abort('parent-stop');
    await new Promise((r) => setImmediate(r));
    expect((worker as unknown as { aborted: boolean }).aborted).toBe(true);
  });

  test('CLIAgentWorker constructed with already-aborted parent signal stops on next tick', async () => {
    const { CLIAgentWorker } = await import('@/core/cli-agent-worker');
    const parent = new AbortController();
    parent.abort('pre-aborted');
    const worker = new CLIAgentWorker(
      {
        id: 'cli-y',
        sessionId: '00000000-0000-0000-0000-000000000000',
        userId: 'u',
        topic: '',
        model: 'cli/claude',
        role: 'research',
        status: 'idle',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      { maxIterations: 1, contextWindowSize: 1000, timeout: 1000, maxTokenBudget: 1000 },
      { parentSignal: parent.signal },
    );
    await new Promise((r) => setImmediate(r));
    expect((worker as unknown as { aborted: boolean }).aborted).toBe(true);
  });
});
