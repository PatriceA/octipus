import { expect, test, vi } from 'vitest';
import type { AgentNode, ChildResult, PendingChild } from '@/core/swarm/types';
import type { SwarmSpawner } from '@/core/swarm/spawner';
import { DetachedChildManager } from '@/core/agent-worker/detached-child-manager';
import { createStageDelegation } from './stage-delegation';
import type { AgentContext } from '@/core/types';
import { startCliToolBridge } from '@/core/cli-tool-bridge';

test('pipeline spawn returns a handle before its child settles and keeps registered context reads responsive (#67)', async () => {
  let finish!: (result: ChildResult) => void;
  const completed = new Promise<ChildResult>(resolve => { finish = resolve; });
  const spawner = { spawnChild: vi.fn(async () => completed) } as unknown as SwarmSpawner;
  const parent = { id: 'stage', rootSessionId: 'session', userId: 'u', depth: 1, kind: 'agent', role: 'coding', topicPath: 'pipeline/test', allowedToolIds: new Set(), signal: new AbortController().signal,
    budget: { tokens: { cap: 10000, used: 0 }, wallClockMs: { cap: 600000, startedAt: Date.now() }, fanOut: { cap: 4, used: 0 }, depth: 1 } } as AgentNode;
  const pending = new DetachedChildManager('stage', () => 600000, () => {});
  const wiring = createStageDelegation(parent, false, spawner);
  const register = vi.fn((child: PendingChild) => pending.registerPendingChild(child));
  wiring.bind({ registerPendingChild: register, pendingDetachedCount: () => pending.count(),
    listPendingDetached: () => pending.list(), collectAllDetached: (ms: number) => pending.collectAll(ms),
  } as never);
  const tools = [...wiring.tools, { name: 'filesystem__read_file', description: '', parameters: {}, execute: async () => 'contract context' }];
  const bridge = await startCliToolBridge({ active: () => true, tools: () => tools,
    execute: async (name, args) => ({ content: [{ type: 'text', text: String(await tools.find(tool => tool.name === name)!.execute(args, {} as AgentContext)) }] }) });
  const call = async (name: string, args = {}) => {
    const response = await fetch(bridge.url + '/call', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.key }, body: JSON.stringify({ name, arguments: args }) });
    return response.json() as Promise<{ content: Array<{ text: string }> }>;
  };
  try {
    const handle = await Promise.race([call('spawn_child', { role: 'qa', taskBrief: 'Review the isolated tested change' }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('spawn blocked on child completion')), 1000))]);
    expect(handle.content[0].text).toContain('status="pending"');
    expect(register).toHaveBeenCalledOnce();
    expect(await call('filesystem__read_file')).toMatchObject({ content: [{ text: 'contract context' }] });
    expect(pending.count()).toBe(1);
    finish({ nodeId: 'child', kind: 'subagent', status: 'ok', output: 'review complete', usedTokens: 10, durationMs: 100, spawnedChildren: [] });
    expect((await call('collect_children')).content[0].text).toContain('review complete');
    expect(pending.count()).toBe(0);
  } finally { finish({ nodeId: 'child', kind: 'subagent', status: 'ok', output: '', usedTokens: 0, durationMs: 0, spawnedChildren: [] }); await bridge.close(); }
});
