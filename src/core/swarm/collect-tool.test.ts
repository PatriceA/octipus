import { describe, expect, test } from 'bun:test';
import type { AgentWorker } from '@/core/agent-worker';
import { createCollectChildrenTool, formatCollectedResults } from './collect-tool';
import { getLevelDefault } from './types';
import type { AgentNode, ChildResult, PendingChild } from './types';

function makeAgentParent(): AgentNode {
  return {
    id: 'agent-1',
    rootSessionId: '00000000-0000-0000-0000-000000000000',
    parentNodeId: 'parent-0',
    kind: 'agent',
    depth: 1,
    role: 'research',
    topicPath: 'root/research',
    model: 'test-model',
    budget: {
      tokens: { cap: 80_000, used: 0 },
      wallClockMs: { cap: 240_000, startedAt: Date.now() },
      fanOut: { cap: 4, used: 0 },
      depth: 1,
    },
    allowedToolIds: new Set(['collect_children']),
    signal: new AbortController().signal,
  };
}

/**
 * Small stand-in for an AgentWorker with only the surface the collect tool
 * actually uses. Keeps tests pure — no agentManager, no DB.
 */
function makeWorkerStub(pending: PendingChild[], results: Record<string, ChildResult>): AgentWorker {
  let list = [...pending];
  const collected = new Set<string>();
  const stub = {
    listPendingDetached: () => list.filter((pc) => !collected.has(pc.childId)),
    pendingDetachedCount: () => list.filter((pc) => !collected.has(pc.childId)).length,
    async collectDetached(childId: string): Promise<ChildResult | null> {
      collected.add(childId);
      return results[childId] ?? null;
    },
    async collectAllDetached(_timeoutMs: number): Promise<ChildResult[]> {
      const out: ChildResult[] = [];
      for (const pc of list) {
        if (collected.has(pc.childId)) continue;
        collected.add(pc.childId);
        const r = results[pc.childId];
        if (r) out.push(r);
      }
      list = [];
      return out;
    },
  };
  return stub as unknown as AgentWorker;
}

describe('collect_children', () => {
  test('no pending → friendly message, no repo calls', async () => {
    const parent = makeAgentParent();
    const worker = makeWorkerStub([], {});
    const tool = createCollectChildrenTool(parent, { current: worker });
    const out = await tool.execute({}, {
      id: 'ctx', sessionId: parent.rootSessionId, userId: 'u', model: '',
      topic: '', role: 'research', status: 'running',
      createdAt: new Date(), updatedAt: new Date(), metadata: {},
    });
    expect(String(out)).toContain('no detached children pending');
  });

  test('collects all pending and emits envelope with count', async () => {
    const parent = makeAgentParent();
    const pending: PendingChild[] = [
      { childId: 'c1', startedAt: Date.now(), taskBrief: 't', topic: 'research', subtopic: 'p1', promise: Promise.resolve({} as ChildResult) },
      { childId: 'c2', startedAt: Date.now(), taskBrief: 't', topic: 'research', subtopic: 'p2', promise: Promise.resolve({} as ChildResult) },
    ];
    const results: Record<string, ChildResult> = {
      c1: { nodeId: 'n1', kind: 'subagent', status: 'ok', output: 'first', usedTokens: 10, durationMs: 50, spawnedChildren: [] },
      c2: { nodeId: 'n2', kind: 'subagent', status: 'ok', output: 'second', usedTokens: 20, durationMs: 60, spawnedChildren: [] },
    };
    const worker = makeWorkerStub(pending, results);
    const tool = createCollectChildrenTool(parent, { current: worker });
    const out = await tool.execute({}, {
      id: 'ctx', sessionId: parent.rootSessionId, userId: 'u', model: '',
      topic: '', role: 'research', status: 'running',
      createdAt: new Date(), updatedAt: new Date(), metadata: {},
    });
    const str = String(out);
    expect(str).toContain('count="2"');
    expect(str).toContain('<output>first</output>');
    expect(str).toContain('<output>second</output>');
  });

  const captureTimeout = async (parent: AgentNode): Promise<number> => {
    let captured = -1;
    const pending: PendingChild[] = [
      { childId: 'c1', startedAt: Date.now(), taskBrief: 't', topic: 'research', promise: Promise.resolve({} as ChildResult) },
    ];
    const worker = {
      listPendingDetached: () => pending,
      async collectAllDetached(timeoutMs: number): Promise<ChildResult[]> {
        captured = timeoutMs;
        return [];
      },
    } as unknown as AgentWorker;
    const tool = createCollectChildrenTool(parent, { current: worker });
    await tool.execute({}, {
      id: 'ctx', sessionId: parent.rootSessionId, userId: 'u', model: '',
      topic: '', role: 'research', status: 'running',
      createdAt: new Date(), updatedAt: new Date(), metadata: {},
    });
    return captured;
  };

  test('when parent has ample wall, default timeout equals the full child wall budget', async () => {
    // Regression: the default per-child wait used to be min(120s, remaining/2),
    // dropping completed work from children that run past 120s. With ample
    // parent wall (remaining > childWall) the target = childWall + margin must
    // dominate — this genuinely exercises the child-wall branch (not the
    // remaining bound).
    const childWall = getLevelDefault(1).wallMs;
    const parent = makeAgentParent();
    parent.budget.wallClockMs = { cap: childWall * 3, startedAt: Date.now() }; // remaining >> childWall
    const captured = await captureTimeout(parent);
    expect(captured).toBe(childWall + 5_000);
    expect(captured).toBeGreaterThan(120_000); // old clamp is gone
  });

  test('when parent wall is tighter than the child wall, timeout is bounded by parent remaining', async () => {
    const childWall = getLevelDefault(1).wallMs;
    const parent = makeAgentParent();
    const remaining = Math.floor(childWall / 2);
    parent.budget.wallClockMs = { cap: remaining, startedAt: Date.now() };
    const captured = await captureTimeout(parent);
    // Bounded by parent remaining (~childWall/2), not the full target.
    expect(captured).toBeLessThanOrEqual(remaining);
    expect(captured).toBeGreaterThan(remaining - 5_000);
  });

  test('explicit timeoutMs override is honored (clamped to [1s, 600s])', async () => {
    const parent = makeAgentParent();
    let captured = -1;
    const pending: PendingChild[] = [
      { childId: 'c1', startedAt: Date.now(), taskBrief: 't', topic: 'research', promise: Promise.resolve({} as ChildResult) },
    ];
    const worker = {
      listPendingDetached: () => pending,
      async collectAllDetached(timeoutMs: number): Promise<ChildResult[]> {
        captured = timeoutMs;
        return [];
      },
    } as unknown as AgentWorker;
    const tool = createCollectChildrenTool(parent, { current: worker });
    await tool.execute({ timeoutMs: 30_000 }, {
      id: 'ctx', sessionId: parent.rootSessionId, userId: 'u', model: '',
      topic: '', role: 'research', status: 'running',
      createdAt: new Date(), updatedAt: new Date(), metadata: {},
    });
    expect(captured).toBe(30_000);
  });

  test('no worker ref → internal-error message, not a throw', async () => {
    const parent = makeAgentParent();
    const tool = createCollectChildrenTool(parent, { current: null });
    const out = await tool.execute({}, {
      id: 'ctx', sessionId: parent.rootSessionId, userId: 'u', model: '',
      topic: '', role: 'research', status: 'running',
      createdAt: new Date(), updatedAt: new Date(), metadata: {},
    });
    expect(String(out)).toContain('internal error');
  });

  test('formatCollectedResults: empty → self-closing envelope', () => {
    expect(formatCollectedResults([])).toBe('<CollectChildren count="0" />');
  });

  test('formatCollectedResults: failure entries include notes', () => {
    const out = formatCollectedResults([
      { nodeId: 'n1', kind: 'subagent', status: 'timeout', output: null, usedTokens: 0, durationMs: 30_000, spawnedChildren: [], notes: 'wall timeout' },
    ]);
    expect(out).toContain('status="timeout"');
    // Child exhausted its OWN wall budget (terminal) — keep its own notes.
    expect(out).toContain('<notes>wall timeout</notes>');
  });

  test('formatCollectedResults: a collect-path timeout says STILL RUNNING (do not re-spawn)', () => {
    const out = formatCollectedResults([
      { nodeId: 'n1', kind: 'subagent', status: 'timeout', output: null, usedTokens: 0, durationMs: 5_000, spawnedChildren: [], notes: 'collect_children timeout after 5000ms' },
    ]);
    expect(out).toContain('STILL RUNNING');
    expect(out).toContain('Do NOT spawn a retry');
    // The raw "collect_children timeout" note is replaced by the guidance.
    expect(out).not.toContain('collect_children timeout after 5000ms');
  });
});
