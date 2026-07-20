import { describe, test, expect } from 'bun:test';
import { AgentWorker } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import {
  BudgetExceededError,
  CascadedCancellationError,
  DriftDetectedError,
  ChildTimeoutError,
  classifyChildError,
} from './errors';
import type { ChildResult, PendingChild } from './types';

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

  test('pre-flight refuses a single oversized request before the LLM call (RC5 D2)', async () => {
    // used is BELOW the cap (so the loop-top gate passes) but the pending
    // request's estimated input would cross it — the pre-flight must abort
    // BEFORE getCompletion, else one giant call (a 373 KB image) overshoots.
    const worker = new AgentWorker(mkCtx({ id: 'w-preflight', userId: 'system' }), {
      maxIterations: 10,
      contextWindowSize: 1_000_000,
      timeout: 60_000,
      maxTokenBudget: 100,
    });
    const priv = worker as unknown as {
      startTime: number;
      totalTokensUsed: number;
      messages: Array<{ role: string; content: unknown }>;
      loop: () => Promise<string>;
      getCompletion: () => Promise<never>;
    };
    priv.startTime = Date.now();
    priv.totalTokensUsed = 50; // below cap → loop-top gate passes
    priv.messages = [{ role: 'user', content: 'x'.repeat(400) }]; // ceil(400/4)=100 est
    priv.getCompletion = async () => {
      throw new Error('getCompletion should not be reached');
    };

    let thrown: unknown = null;
    try {
      await priv.loop();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BudgetExceededError);
    // projected = 50 (spent) + 100 (estimated input) = 150 ≥ cap 100
    expect((thrown as BudgetExceededError).metadata?.used).toBe(150);
    expect((thrown as BudgetExceededError).metadata?.cap).toBe(100);
  });

  test('raceAbsolute: wedged self-timed wait trips the ceiling; fast/disabled do not (RC5 D5)', async () => {
    const worker = new AgentWorker(mkCtx(), {
      maxIterations: 1,
      contextWindowSize: 1000,
      timeout: 1000,
      maxTokenBudget: 0,
    });
    const priv = worker as unknown as {
      raceAbsolute: <T>(p: Promise<T>, label: string, ceilingMs: number) => Promise<T>;
    };

    // A never-resolving wait trips the ceiling.
    const hang = new Promise<string>(() => {});
    await expect(priv.raceAbsolute(hang, 'collect', 40)).rejects.toThrow(/absolute ceiling/i);

    // A wait that finishes under the ceiling passes through with its value.
    const fast = Promise.resolve('done');
    expect(await priv.raceAbsolute(fast, 'collect', 10_000)).toBe('done');

    // ceiling <= 0 disables the backstop (returns the promise unraced).
    expect(await priv.raceAbsolute(Promise.resolve('x'), 'collect', 0)).toBe('x');
  });

  test('estimateRequestTokens: text = chars/4; image part = fixed (not base64 length)', () => {
    const worker = new AgentWorker(mkCtx(), {
      maxIterations: 1,
      contextWindowSize: 1000,
      timeout: 1000,
      maxTokenBudget: 0,
    });
    const priv = worker as unknown as {
      messages: Array<{ role: string; content: unknown }>;
      estimateRequestTokens: () => number;
    };
    // Plain string: 40 chars → 10 tokens.
    priv.messages = [{ role: 'user', content: 'a'.repeat(40) }];
    expect(priv.estimateRequestTokens()).toBe(10);

    // A huge base64 blob dumped into a STRING (what a text model gets — the
    // run-743d4b66 case) is counted at full length so it trips the cap.
    priv.messages = [{ role: 'user', content: 'x'.repeat(400_000) }];
    expect(priv.estimateRequestTokens()).toBe(100_000);

    // The SAME-sized blob as a structured image_url part (vision model) is a
    // fixed ~1500, NOT length/4 — otherwise a legit vision agent false-aborts.
    priv.messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${'b'.repeat(400_000)}` } }] },
    ];
    const imgEst = priv.estimateRequestTokens();
    expect(imgEst).toBe(1_500);
    expect(imgEst).toBeLessThan(10_000); // nowhere near the 100k a length-based count would give
  });
});

describe('AgentWorker — detached-collect wall-clock pause', () => {
  test('time spent waiting in collectAllDetached is excluded from elapsed()', async () => {
    const worker = new AgentWorker(mkCtx({ id: 'w-pause' }), {
      maxIterations: 10,
      contextWindowSize: 100_000,
      timeout: 600_000,
      maxTokenBudget: 100_000,
    });
    const priv = worker as unknown as { startTime: number };
    priv.startTime = Date.now() - 1_000; // 1s of active work so far

    const WAIT = 150;
    const child: ChildResult = {
      nodeId: 'n1', kind: 'subagent', status: 'ok', output: 'done',
      usedTokens: 5, durationMs: WAIT, spawnedChildren: [],
    };
    const pc: PendingChild = {
      childId: 'c1', startedAt: Date.now(), taskBrief: 't', topic: 'research',
      promise: new Promise<ChildResult>((resolve) => setTimeout(() => resolve(child), WAIT)),
    };
    worker.registerPendingChild(pc);

    const before = worker.getElapsedMs();
    const results = await worker.collectAllDetached(5_000);
    const after = worker.getElapsedMs();

    expect(results).toHaveLength(1);
    // The ~150ms blocked wait must NOT count against the parent's clock.
    // Without the pause, `after - before` would be ≈ WAIT; with it, ≈ 0.
    expect(after - before).toBeLessThan(WAIT - 40);
  });
});

describe('classifyChildError taxonomy', () => {
  test('maps our classes to the right ChildResult.status', () => {
    expect(classifyChildError(new BudgetExceededError({ agentId: 'a', used: 1, cap: 0 }))).toBe('budget');
    expect(classifyChildError(new ChildTimeoutError({ agentId: 'a', elapsedMs: 1, capMs: 0 }))).toBe('timeout');
    expect(classifyChildError(new CascadedCancellationError({ agentId: 'a' }))).toBe('cancelled');
  });

  test('drift maps to contract_failed, NOT tool_error', () => {
    // tool_error would send it down the spawner's crash-retry path and spawn a
    // second child to drift all over again. contract_failed is terminal and
    // tells the parent the work was not done.
    expect(
      classifyChildError(new DriftDetectedError({ agentId: 'a', consecutive: 8, briefSummary: 'world, cup' })),
    ).toBe('contract_failed');
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
