/**
 * Orchestrator-hardening behaviours on AgentWorker:
 *  - P1.7  stopped worker emits a complete-shaped terminal event + reason
 *  - P1.2/1.3  auto-collect relays full child content (no 500-char stub) and the
 *              deterministic relay fallback appends it when the model stubs out
 *  - 2.2   a child (non-root) that overruns its wall throws ChildTimeoutError
 *          (→ ChildResult status='timeout') while the parent survives a
 *          timed-out child; the root orchestrator instead exits gracefully
 *  - 3.5   iteration-budget exhaustion runs one final no-tools summary turn
 *
 * Driven with instance-level overrides of the private `getCompletion`, the same
 * hermetic pattern used by budget-enforcement.test.ts (no DB / no real LLM).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { AgentWorker } from '@/core/agent-worker';
import type { AgentEvent } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import { agentRepository } from '@/db/repositories/agent-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import type { CompletionResult } from '@/models/litellm-client';
import { CascadedCancellationError, ChildTimeoutError, classifyChildError } from './swarm/errors';
import type { ChildResult, PendingChild } from './swarm/types';

const mkCtx = (over: Partial<AgentContext> = {}): AgentContext => ({
  id: 'hw-1',
  sessionId: '00000000-0000-0000-0000-000000000000',
  userId: 'local',
  topic: 'test',
  model: 'test-model',
  role: 'research',
  status: 'idle',
  createdAt: new Date(),
  updatedAt: new Date(),
  metadata: {},
  ...over,
});

const cfg = (over: Partial<{ maxIterations: number; timeout: number }> = {}) => ({
  maxIterations: 10,
  contextWindowSize: 100_000,
  timeout: 600_000,
  maxTokenBudget: 1_000_000,
  // Provided so the loop's compaction path never falls through to getConfig()
  // (which validates the full app config — unavailable in this unit test).
  toolOutputSoftCap: 1_000,
  ...over,
});

const completion = (content: string): CompletionResult => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
  model: 'test-model',
  latencyMs: 1,
});

const pending = (id: string, result: ChildResult): PendingChild => ({
  childId: id,
  startedAt: Date.now(),
  taskBrief: 't',
  topic: 'research',
  promise: Promise.resolve(result),
});

describe('AgentWorker.stop — terminal events (P1.7)', () => {
  test('emits status_change:stopped AND a complete-shaped terminal event with the reason', () => {
    const worker = new AgentWorker(mkCtx(), cfg());
    const events: AgentEvent[] = [];
    worker.onEvent((e) => events.push(e));

    worker.stop('cascade_cancelled_from_ancestor');

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    const data = complete!.data as { stopped?: boolean; reason?: string };
    expect(data.stopped).toBe(true);
    expect(data.reason).toBe('cascade_cancelled_from_ancestor');

    const stopped = events.find(
      (e) => e.type === 'status_change' && (e.data as { status?: string }).status === 'stopped',
    );
    expect(stopped).toBeDefined();
    expect(worker.getStatus()).toBe('stopped');
  });

  test('a second stop() after terminal does not double-fire complete', () => {
    const worker = new AgentWorker(mkCtx(), cfg());
    const events: AgentEvent[] = [];
    worker.onEvent((e) => events.push(e));
    worker.stop('manual stop');
    worker.stop('manual stop again');
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);
  });

  test('a cascaded stop maps to a structured ChildResult (cancelled/stopped) for the parent', () => {
    expect(classifyChildError(new CascadedCancellationError({ agentId: 'x', reason: 'stop' }))).toBe('cancelled');
  });
});

describe('AgentWorker auto-collect relay fidelity (P1.2 / P1.3)', () => {
  let auditSpy: ReturnType<typeof spyOn>;
  let updateSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    auditSpy = spyOn(auditRepository, 'logAgentCompleted').mockResolvedValue(undefined as never);
    updateSpy = spyOn(agentRepository, 'updateStatus').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    auditSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test('two 5k-char child outputs survive to the final message even when the model stubs', async () => {
    const childA = `ALPHA_MARKER ${'alpha detail line. '.repeat(320)}`; // ~6k chars
    const childB = `BETA_MARKER ${'beta detail line. '.repeat(320)}`;
    expect(childA.length).toBeGreaterThan(5000);
    expect(childB.length).toBeGreaterThan(5000);

    const worker = new AgentWorker(mkCtx({ role: 'research' }), cfg());
    const priv = worker as unknown as {
      getCompletion: () => Promise<CompletionResult>;
      messages: Array<{ role: string; content: string }>;
    };
    // The model stubs out — never relays the child content itself.
    priv.getCompletion = async () => completion('I have gathered the results and updated the summary.');

    worker.registerPendingChild(
      pending('c-a', { nodeId: 'c-a', kind: 'subagent', status: 'ok', output: childA, usedTokens: 10, durationMs: 5, spawnedChildren: [] }),
    );
    worker.registerPendingChild(
      pending('c-b', { nodeId: 'c-b', kind: 'subagent', status: 'ok', output: childB, usedTokens: 10, durationMs: 5, spawnedChildren: [] }),
    );

    const finalResult = await worker.run('do the thing');

    // Relay fallback appended the verbatim child results (≥N chars of each).
    expect(finalResult).toContain(childA.slice(0, 4500));
    expect(finalResult).toContain(childB.slice(0, 4500));

    // And the auto-collect summary handed to the model carried the full content,
    // not a 500-char stub — the per-child budget fix.
    const autoMsg = priv.messages.find((m) => m.role === 'system' && m.content.includes('detached subagent'));
    expect(autoMsg).toBeDefined();
    expect(autoMsg!.content).toContain(childA.slice(0, 4500));
    expect(autoMsg!.content).toContain(childB.slice(0, 4500));
  });
});

describe('AgentWorker child-aware timeout (2.2) + graceful exit (3.5)', () => {
  test('a child (non-root) overrun throws ChildTimeoutError → status timeout', async () => {
    const child = new AgentWorker(mkCtx({ role: 'research', id: 'child-1' }), cfg({ timeout: 10 }));
    const priv = child as unknown as { startTime: number; loop: () => Promise<string>; getCompletion: () => Promise<never> };
    priv.startTime = Date.now() - 1_000; // 1s elapsed ≫ 10ms cap
    priv.getCompletion = async () => { throw new Error('LLM must not be reached'); };

    let thrown: unknown;
    try { await priv.loop(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ChildTimeoutError);
    expect(classifyChildError(thrown)).toBe('timeout');
  });

  test('the parent survives a timed-out child — collect returns status=timeout, no abort', async () => {
    const parent = new AgentWorker(mkCtx({ role: 'orchestrator', id: 'parent-1' }), cfg());
    (parent as unknown as { startTime: number }).startTime = Date.now();
    parent.registerPendingChild(
      pending('c-t', { nodeId: 'c-t', kind: 'subagent', status: 'timeout', output: 'partial work', usedTokens: 3, durationMs: 10, spawnedChildren: [] }),
    );
    const collected = await parent.collectAllDetached(1_000);
    expect(collected).toHaveLength(1);
    expect(collected[0].status).toBe('timeout');
    expect(parent.getAbortSignal().aborted).toBe(false);
  });

  test('the root orchestrator exits gracefully on wall-clock overrun instead of throwing', async () => {
    const orch = new AgentWorker(mkCtx({ role: 'orchestrator', id: 'orch-1' }), cfg({ timeout: 10 }));
    const priv = orch as unknown as { startTime: number; loop: () => Promise<string>; getCompletion: () => Promise<CompletionResult> };
    priv.startTime = Date.now() - 1_000;
    let calls = 0;
    priv.getCompletion = async () => { calls++; return completion('Progress summary: fetched data; export step remains.'); };

    const result = await priv.loop();
    expect(result).toContain('Progress summary');
    expect(calls).toBe(1); // exactly one final no-tools turn
  });

  test('iteration-budget exhaustion runs one final no-tools summary turn (3.5)', async () => {
    const worker = new AgentWorker(mkCtx({ role: 'research', id: 'budget-1' }), cfg({ maxIterations: 2 }));
    const priv = worker as unknown as {
      iteration: number;
      loop: () => Promise<string>;
      getCompletion: () => Promise<CompletionResult>;
      toolExecutor: { toolsDisabled: boolean };
    };
    priv.iteration = 2; // already at the budget → loop body is skipped
    let calls = 0;
    priv.getCompletion = async () => { calls++; return completion('SUMMARY: I indexed the files; the report write-up remains.'); };

    const result = await priv.loop();
    expect(calls).toBe(1);
    expect(result).toContain('SUMMARY');
    expect(priv.toolExecutor.toolsDisabled).toBe(true); // tools disabled for the summary turn
  });
});
