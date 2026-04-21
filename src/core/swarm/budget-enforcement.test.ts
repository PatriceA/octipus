import { describe, test, expect } from 'bun:test';
import { AgentWorker } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import {
  BudgetExceededError,
  CascadedCancellationError,
  ChildTimeoutError,
  classifyChildError,
} from './errors';

const mkCtx = (over: Partial<AgentContext> = {}): AgentContext => ({
  id: 'w-1',
  sessionId: '00000000-0000-0000-0000-000000000000',
  userId: 'u-1',
  topic: 'test',
  model: 'test-model',
  role: 'research',
  status: 'idle',
  createdAt: new Date(),
  updatedAt: new Date(),
  metadata: {},
  ...over,
});

describe('AgentWorker — hard budget enforcement (Phase 2)', () => {
  test('pre-LLM-call token budget breach throws BudgetExceededError', async () => {
    const worker = new AgentWorker(mkCtx(), {
      maxIterations: 10,
      contextWindowSize: 100_000,
      timeout: 60_000,
      maxTokenBudget: 100,
    });
    // Seed totalTokensUsed above cap so the pre-check fires immediately.
    (worker as unknown as { totalTokensUsed: number }).totalTokensUsed = 200;

    // run() catches errors and persists DB rows — we want the underlying
    // BudgetExceededError to be rethrown.
    let thrown: unknown = null;
    try {
      // Skip loadHistory / DB persist by invoking the loop directly via the
      // public run API. We expect it to throw synchronously before the first
      // LLM call.
      await worker.run('anything');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BudgetExceededError);
    const err = thrown as BudgetExceededError;
    expect(err.metadata?.used).toBe(200);
    expect(err.metadata?.cap).toBe(100);
  });

  test('abort propagates via CascadedCancellationError', async () => {
    const parent = new AbortController();
    const worker = new AgentWorker(
      mkCtx({ id: 'w-2' }),
      { maxIterations: 10, contextWindowSize: 100_000, timeout: 60_000, maxTokenBudget: 100_000 },
      { parentSignal: parent.signal },
    );
    // Abort before run starts.
    parent.abort('parent-cancel');

    let thrown: unknown = null;
    try {
      await worker.run('anything');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CascadedCancellationError);
  });

  test('wall-clock breach in loop pre-check throws ChildTimeoutError', async () => {
    // Invoke the private loop directly so we can control startTime.
    // run() resets startTime; loop() does not.
    const worker = new AgentWorker(mkCtx({ id: 'w-3' }), {
      maxIterations: 10,
      contextWindowSize: 100_000,
      timeout: 10, // 10ms cap
      maxTokenBudget: 100_000,
    });
    const priv = worker as unknown as {
      startTime: number;
      loop: () => Promise<string>;
      getCompletion: () => Promise<never>;
    };
    // Simulate 1 second elapsed at loop entry — triggers the pre-LLM check.
    priv.startTime = Date.now() - 1000;
    // Make getCompletion fail loudly if called — proves pre-check fires first.
    priv.getCompletion = async () => {
      throw new Error('getCompletion should not be reached');
    };

    let thrown: unknown = null;
    try {
      await priv.loop();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ChildTimeoutError);
    expect((thrown as ChildTimeoutError).metadata?.capMs).toBe(10);
  });
});

describe('classifyChildError taxonomy', () => {
  test('maps our classes to the right ChildResult.status', () => {
    expect(classifyChildError(new BudgetExceededError({ agentId: 'a', used: 1, cap: 0 }))).toBe('budget');
    expect(classifyChildError(new ChildTimeoutError({ agentId: 'a', elapsedMs: 1, capMs: 0 }))).toBe('timeout');
    expect(classifyChildError(new CascadedCancellationError({ agentId: 'a' }))).toBe('cancelled');
  });

  test('falls through to string heuristics for plain errors', () => {
    expect(classifyChildError(new Error('permission denied'))).toBe('denied');
    expect(classifyChildError(new Error('token budget exceeded (150/100)'))).toBe('budget');
    expect(classifyChildError(new Error('agent timeout exceeded'))).toBe('timeout');
    expect(classifyChildError(new Error('aborted by user'))).toBe('cancelled');
    expect(classifyChildError(new Error('provider rate_limit'))).toBe('provider_error');
    expect(classifyChildError(new Error('weird thing broke'))).toBe('tool_error');
  });
});
