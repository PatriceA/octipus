import { describe, expect, test } from 'bun:test';
import type { AgentWorker } from '@/core/agent-worker';
import { createCollectChildrenTool, formatCollectedResults } from './collect-tool';
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
    expect(out).toContain('<notes>wall timeout</notes>');
  });
});
