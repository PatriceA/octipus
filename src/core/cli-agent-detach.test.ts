/**
 * CLI workers own a detached-child manager like native workers, so spawn_child
 * can detach for them and collect_children / auto-collect have something to
 * collect. Without this, spawn_child always awaited and collect_children
 * answered "worker not wired".
 */
import { describe, expect, test, vi } from 'vitest';
import type { ChildResult } from './swarm/types';

vi.mock('@/db/repositories/work-plan-repository', () => ({ workPlanRepository: { read: async () => ({ current: null, revision: 0 }) } }));
vi.mock('./agent/work-plan-context', () => ({ formatWorkPlanContext: () => 'no plan' }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ cancelWaits: () => {}, onWaitStateChange: () => () => {} }) }));

import { CLIAgentWorker } from './cli-agent-worker';

const context = () => ({ id: 'cli-parent', sessionId: 's', userId: 'u', root: true, model: 'cli/claude-code', role: 'general', topic: '', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} }) as unknown as ConstructorParameters<typeof CLIAgentWorker>[0];
const config = { maxIterations: 5, maxTokenBudget: 10_000, timeout: 600_000, contextWindowSize: 10_000 };
const result = (nodeId: string): ChildResult => ({ nodeId, status: 'ok', output: `done ${nodeId}`, usedTokens: 1, durationMs: 1, spawnedChildren: [] } as unknown as ChildResult);

describe('CLIAgentWorker detached children', () => {
  test('registers, lists, and collects detached children like the native worker', async () => {
    const worker = new CLIAgentWorker(context(), config);
    worker.registerPendingChild({ childId: 'c1', startedAt: Date.now(), taskBrief: 'x', topic: 'research', promise: Promise.resolve(result('c1')) });
    expect(worker.pendingDetachedCount()).toBe(1);
    expect(worker.listPendingDetached().map(p => p.childId)).toEqual(['c1']);
    const collected = await worker.collectAllDetached(1_000);
    expect(collected.map(r => r.nodeId)).toEqual(['c1']);
    expect(worker.pendingDetachedCount()).toBe(0);
  });

  test('the run context tells the CLI which children are still pending', async () => {
    const worker = new CLIAgentWorker(context(), config);
    worker.registerPendingChild({ childId: 'c2', startedAt: Date.now() - 500, taskBrief: 'x', topic: 'coding', promise: new Promise(() => {}) });
    const ctx = JSON.parse(await (worker as unknown as { controlContext(): Promise<string> }).controlContext());
    expect(ctx.detachedChildren).toEqual([expect.objectContaining({ childId: 'c2', topic: 'coding' })]);
    expect(ctx.detachedChildrenNote).toContain('collect_children');
  });

  test('stop() cancels children still pending', () => {
    const worker = new CLIAgentWorker(context(), config);
    worker.registerPendingChild({ childId: 'c3', startedAt: Date.now(), taskBrief: 'x', topic: 'qa', promise: new Promise(() => {}) });
    worker.stop();
    expect(worker.pendingDetachedCount()).toBe(0);
  });
});

vi.mock('./swarm/node-repository', () => ({ swarmNodeRepository: { markCollected: async () => {} } }));

describe('settleDetachedChildren (auto-collect at run end)', () => {
  // Private surface under test, addressed structurally so the class's own
  // `private` members do not collapse the type.
  type Priv = { settleDetachedChildren(result: string, buffered: boolean): Promise<string>; executeCLI(): Promise<string>; runStartedAt: number };
  const make = () => {
    const worker = new CLIAgentWorker(context(), config);
    const priv = worker as unknown as Priv;
    priv.runStartedAt = Date.now(); // a run in progress with the full wall budget left
    worker.registerPendingChild({ childId: 'c1', startedAt: Date.now(), taskBrief: 'x', topic: 'research', promise: Promise.resolve(result('c1')) });
    return { worker, priv };
  };

  test('streams: one merge turn produces the final answer', async () => {
    const { worker, priv } = make();
    const merge = vi.spyOn(priv, 'executeCLI').mockResolvedValue('merged answer');
    expect(await priv.settleDetachedChildren('draft', false)).toBe('merged answer');
    expect(merge).toHaveBeenCalledOnce();
    expect(worker.pendingDetachedCount()).toBe(0);
  });

  test('buffered adapter: results are appended, no merge turn', async () => {
    const { priv } = make();
    const merge = vi.spyOn(priv, 'executeCLI');
    const out = await priv.settleDetachedChildren('draft', true);
    expect(out).toContain('draft');
    expect(out).toContain('done c1');
    expect(merge).not.toHaveBeenCalled();
  });

  test('a failing merge turn falls back to appending the collected results', async () => {
    const { priv } = make();
    vi.spyOn(priv, 'executeCLI').mockRejectedValue(new Error('quota'));
    const out = await priv.settleDetachedChildren('draft', false);
    expect(out).toContain('done c1');
    expect(out).toContain('not merged');
  });
});
