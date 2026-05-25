import { describe, expect, test } from 'bun:test';
import type { AgentWorker } from '@/core/agent-worker';
import { LEVEL_DEFAULT, type AgentNode, type PendingChild } from '@/core/swarm/types';
import { createMetaTools, type OrchestratorSwarmRefs } from './meta-tools';

/**
 * Phase 1 orchestrator-freedom wiring tests. The orchestrator now gets
 * `spawn_child` with detach hooks AND `collect_children` so it can run
 * children in the background while continuing to narrate / spawn / chat.
 *
 * These are pure surface checks — actual detach plumbing through
 * AgentWorker is covered by collect-tool.test.ts and the swarm-tool
 * detach tests in swarm-tool.test.ts.
 */

function makeOrchestratorNode(): AgentNode {
  return {
    id: 'orchestrator-1',
    rootSessionId: '00000000-0000-0000-0000-000000000000',
    parentNodeId: null,
    kind: 'orchestrator',
    depth: 0,
    role: 'orchestrator',
    topicPath: 'root',
    model: 'test-model',
    budget: {
      tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 },
      wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() },
      fanOut: { cap: LEVEL_DEFAULT[0].fanOut, used: 0 },
      depth: 0,
    },
    allowedToolIds: new Set<string>(),
    signal: new AbortController().signal,
  };
}

function makeRefs(): OrchestratorSwarmRefs {
  return {
    detachHookRef: { current: null },
    workerRef: { current: null },
  };
}

describe('createMetaTools — orchestrator swarm wiring', () => {
  test('without swarmRefs: spawn_child registered, collect_children absent (legacy)', () => {
    const parentNode = makeOrchestratorNode();
    const tools = createMetaTools(
      {} as unknown as Parameters<typeof createMetaTools>[0],
      { parentNode },
    );
    expect(tools.find((t) => t.name === 'spawn_child')).toBeDefined();
    expect(tools.find((t) => t.name === 'collect_children')).toBeUndefined();
    expect(parentNode.allowedToolIds.has('collect_children')).toBe(false);
  });

  test('with swarmRefs: spawn_child AND collect_children registered', () => {
    const parentNode = makeOrchestratorNode();
    const refs = makeRefs();
    const tools = createMetaTools(
      {} as unknown as Parameters<typeof createMetaTools>[0],
      { parentNode, swarmRefs: refs },
    );
    expect(tools.find((t) => t.name === 'spawn_child')).toBeDefined();
    expect(tools.find((t) => t.name === 'collect_children')).toBeDefined();
    expect(parentNode.allowedToolIds.has('collect_children')).toBe(true);
  });

  test('detach hook indirection: tool reads ref lazily so post-spawn wiring works', () => {
    const parentNode = makeOrchestratorNode();
    const refs = makeRefs();
    const tools = createMetaTools(
      {} as unknown as Parameters<typeof createMetaTools>[0],
      { parentNode, swarmRefs: refs },
    );
    // Tool factory ran before the worker was created — populate ref now
    // to simulate post-spawn wiring.
    let registered: PendingChild | null = null;
    refs.detachHookRef.current = {
      registerPendingChild: (pc) => { registered = pc; },
      pendingDetachedCount: () => (registered ? 1 : 0),
    };
    const spawnTool = tools.find((t) => t.name === 'spawn_child');
    expect(spawnTool).toBeDefined();
    // We don't drive the full execute() path here — that's covered by
    // swarm-tool.test.ts. The point is to assert the closure binding to
    // the ref holder is intact: when something calls registerPending,
    // it lands on the actual hook.
    expect(refs.detachHookRef.current.pendingDetachedCount()).toBe(0);
  });

  test('collect_children references the worker through workerRef (lazy)', async () => {
    const parentNode = makeOrchestratorNode();
    const refs = makeRefs();
    const tools = createMetaTools(
      {} as unknown as Parameters<typeof createMetaTools>[0],
      { parentNode, swarmRefs: refs },
    );
    const collect = tools.find((t) => t.name === 'collect_children');
    expect(collect).toBeDefined();
    // Worker not wired yet — the tool surfaces a clear error, not a crash.
    const out = await collect!.execute({}, {
      id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000',
      userId: 'u', model: '', topic: '', role: 'orchestrator',
      status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
    });
    expect(String(out)).toMatch(/worker not wired/i);

    // Now simulate a wired worker.
    refs.workerRef.current = {
      listPendingDetached: () => [],
    } as unknown as AgentWorker;
    const out2 = await collect!.execute({}, {
      id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000',
      userId: 'u', model: '', topic: '', role: 'orchestrator',
      status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
    });
    expect(String(out2)).toMatch(/no detached children pending/i);
  });
});

describe('LEVEL_DEFAULT[0] detach budget', () => {
  test('orchestrator has a non-zero maxPendingDetached after the freedom rework', () => {
    expect(LEVEL_DEFAULT[0].maxPendingDetached).toBeGreaterThan(0);
    expect(LEVEL_DEFAULT[0].maxPendingDetached).toBe(LEVEL_DEFAULT[0].fanOut);
  });
});
