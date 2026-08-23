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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentWorker, TOOLSHIM_TIMEOUT_MS } from '@/core/agent-worker';
import type { AgentEvent } from '@/core/agent-worker';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import type { AgentContext } from '@/core/types';
import { agentRepository } from '@/db/repositories/agent-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { CompletionResult } from '@/models/litellm-client';
import { CascadedCancellationError, ChildTimeoutError, DriftDetectedError, classifyChildError } from './swarm/errors';
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
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditRepository, 'logAgentCompleted').mockResolvedValue(undefined as never);
    updateSpy = vi.spyOn(agentRepository, 'updateStatus').mockResolvedValue(undefined as never);
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
    const parent = new AgentWorker(mkCtx({ role: 'general', root: true, id: 'parent-1' }), cfg());
    (parent as unknown as { startTime: number }).startTime = Date.now();
    parent.registerPendingChild(
      pending('c-t', { nodeId: 'c-t', kind: 'subagent', status: 'timeout', output: 'partial work', usedTokens: 3, durationMs: 10, spawnedChildren: [] }),
    );
    const collected = await parent.collectAllDetached(1_000);
    expect(collected).toHaveLength(1);
    expect(collected[0].status).toBe('timeout');
    expect(parent.getAbortSignal().aborted).toBe(false);
  });

  test('the root agent exits gracefully on wall-clock overrun instead of throwing', async () => {
    const orch = new AgentWorker(mkCtx({ role: 'general', root: true, id: 'orch-1' }), cfg({ timeout: 10 }));
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

  test('a wedged summary turn is bounded and still yields a deterministic recap', async () => {
    // The graceful exit is reached only once the wall/iteration budget is spent,
    // so `raceTimeout` cannot bound it — without an absolute ceiling a stuck or
    // cold provider holds the worker open indefinitely PAST its budget.
    const worker = new AgentWorker(
      mkCtx({ role: 'research', id: 'budget-wedged' }),
      { ...cfg({ maxIterations: 2 }), unracedTurnCeilingMs: 50 },
    );
    const priv = worker as unknown as {
      iteration: number;
      loop: () => Promise<string>;
      getCompletion: () => Promise<CompletionResult>;
      messages: Array<{ role: string; content: string; timestamp: Date }>;
    };
    priv.iteration = 2;
    priv.messages.push({ role: 'tool', content: 'INDEXED 12 FILES', timestamp: new Date() });
    // A provider that never answers.
    priv.getCompletion = () => new Promise<CompletionResult>(() => {});

    const startedAt = Date.now();
    const result = await priv.loop();
    // Bounded by the ceiling, not by the provider.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // And it still returns real content rather than a bare error.
    expect(result).toContain('INDEXED 12 FILES');
  });
});

describe('AgentWorker task-drift detection (T2.2)', () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;
  // The orchestrator case persists its user message; this suite has no DB.
  let msgSpy: ReturnType<typeof vi.spyOn>;
  let sessSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditRepository, 'logAgentCompleted').mockResolvedValue(undefined as never);
    updateSpy = vi.spyOn(agentRepository, 'updateStatus').mockResolvedValue(undefined as never);
    msgSpy = vi.spyOn(messageRepository, 'create').mockResolvedValue(undefined as never);
    sessSpy = vi.spyOn(sessionRepository, 'incrementMessageCount').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    auditSpy.mockRestore();
    updateSpy.mockRestore();
    msgSpy.mockRestore();
    sessSpy.mockRestore();
  });

  /**
   * write_file into an unrelated doc tree, a DIFFERENT path each time — as in
   * the real incident, which produced ~25 distinct files. Distinct signatures
   * also keep `ToolLoopDetector.checkRepeat` (identical-args) out of the way,
   * so this exercises drift rather than repetition. `filesystem__` is already
   * exempt from the same-name check via REPEAT_ALLOWED_PREFIXES.
   */
  let n = 0;
  const driftingCall = (): CompletionResult => {
    n++;
    return {
      content: '',
      toolCalls: [
        {
          id: `tc-${n}`,
          name: 'filesystem__write_file',
          arguments: { path: `ai-docs/reference/tool-${n}.md`, content: 'documentation framework page' },
        },
      ],
      finishReason: 'tool_calls',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      model: 'test-model',
      latencyMs: 1,
    };
  };

  test('a worker that drifts off its brief is stopped instead of running to budget', async () => {
    const worker = new AgentWorker(mkCtx({ id: 'drift-1' }), cfg({ maxIterations: 40 }));
    const priv = worker as unknown as {
      getCompletion: () => Promise<CompletionResult>;
      toolExecutor: { handleToolCalls: (tc: unknown) => Promise<unknown[]> };
    };
    priv.getCompletion = async () => driftingCall();
    // Tools "succeed" — the point is that success is not the same as relevance.
    priv.toolExecutor.handleToolCalls = async () => [];

    let thrown: unknown = null;
    try {
      await worker.run('Find which World Cup matches were played yesterday and the scores.');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DriftDetectedError);
    // Stopped well inside the 40-iteration budget — the 743d4b66 child burned 37.
    expect((thrown as DriftDetectedError).metadata?.consecutive).toBe(8);
    expect(classifyChildError(thrown)).toBe('contract_failed');
  });

  test('the ROOT agent is exempt — a false abort there would cascade-cancel its own children', async () => {
    // The root's delegation vocabulary (spawn_child / collect_children) never
    // echoes the user's wording, so judging it the same way would abort it —
    // and run()'s catch calls detached.cancelAll(), killing the pending
    // children it was waiting to collect.
    const worker = new AgentWorker(mkCtx({ id: 'orch-1', role: 'general', root: true }), cfg({ maxIterations: 14 }));
    const priv = worker as unknown as {
      getCompletion: () => Promise<CompletionResult>;
      toolExecutor: { handleToolCalls: (tc: unknown) => Promise<unknown[]> };
      driftDetector?: unknown;
    };
    let calls = 0;
    priv.getCompletion = async () => {
      calls++;
      if (calls > 12) return completion('Here is the summary of the delegated work.');
      return driftingCall();
    };
    priv.toolExecutor.handleToolCalls = async () => [];

    const out = await worker.run('Find which World Cup matches were played yesterday and the scores.');
    expect(priv.driftDetector).toBeUndefined();
    expect(out).toContain('summary');
  });

  test('an on-task worker is never tripped by the detector', async () => {
    const worker = new AgentWorker(mkCtx({ id: 'ontask-1' }), cfg({ maxIterations: 12 }));
    const priv = worker as unknown as {
      getCompletion: () => Promise<CompletionResult>;
      toolExecutor: { handleToolCalls: (tc: unknown) => Promise<unknown[]> };
    };
    let calls = 0;
    priv.getCompletion = async () => {
      calls++;
      if (calls > 9) return completion('Brazil beat Serbia 2-0 yesterday.');
      return {
        ...driftingCall(),
        toolCalls: [
          { id: `tc-${calls}`, name: 'websearch__search', arguments: { query: 'World Cup scores yesterday' } },
        ],
      };
    };
    priv.toolExecutor.handleToolCalls = async () => [];

    const out = await worker.run('Find which World Cup matches were played yesterday and the scores.');
    expect(out).toContain('Brazil');
  });
});

/**
 * Toolshim gating: the shim reconstructs a call the model FAILED to emit. It
 * must not fire on a normal text-only final answer — that costs an extra LLM
 * call per turn and, when the `background` model is a cold local one, stalls
 * delivery of an answer that is already written (observed: 14 min between an
 * orchestrator's finished text and its completion event).
 */
describe('AgentWorker toolshim gate (native tool-caller ⇒ no translator)', () => {
  const shimWorker = () => {
    const worker = new AgentWorker(mkCtx({ id: 'shim-1' }), cfg());
    worker.registerTool({
      name: 'filesystem__write_file',
      description: 'write a file',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });
    return worker;
  };

  test('a model that emitted a native tool call never reaches the translator again', async () => {
    const worker = shimWorker();
    const priv = worker as unknown as {
      sawNativeToolCall: boolean;
      tryToolShim: (prose: string) => Promise<unknown>;
    };
    const topicSpy = vi.spyOn(getModelRegistry(), 'getModelForTopic');

    priv.sawNativeToolCall = true;
    expect(await priv.tryToolShim('Done — the daily update task has been disabled.')).toBeNull();
    // The gate must sit BEFORE the translator is even resolved: resolving the
    // model is what leads to the (unbounded, possibly cold) provider call.
    expect(topicSpy).not.toHaveBeenCalled();
    topicSpy.mockRestore();
  });

  test('a model that has NOT emitted a native tool call still gets the translator', async () => {
    const worker = shimWorker();
    const priv = worker as unknown as {
      sawNativeToolCall: boolean;
      tryToolShim: (prose: string) => Promise<unknown>;
    };
    const topicSpy = vi.spyOn(getModelRegistry(), 'getModelForTopic').mockResolvedValue(null as never);

    priv.sawNativeToolCall = false;
    // Names the advertised tool, so the intent gate passes and the shim runs.
    expect(await priv.tryToolShim('I will now call filesystem__write_file with /a.txt')).toBeNull();
    expect(topicSpy).toHaveBeenCalledWith('background');
    topicSpy.mockRestore();
  });

  test('a plain final answer never reaches the translator, even from a weak model', async () => {
    const worker = shimWorker();
    const priv = worker as unknown as {
      sawNativeToolCall: boolean;
      tryToolShim: (prose: string) => Promise<unknown>;
    };
    const topicSpy = vi.spyOn(getModelRegistry(), 'getModelForTopic');

    // No native call yet (the daily-cron case: a 1-iteration run that simply
    // answers), and prose with no tool intent. Historically this still bought a
    // translator call and, against a cold local model, ~15 min of dead wait.
    priv.sawNativeToolCall = false;
    expect(
      await priv.tryToolShim('The daily update task for WM 2026 has been disabled.'),
    ).toBeNull();
    expect(topicSpy).not.toHaveBeenCalled();
    topicSpy.mockRestore();
  });

  test('the translator call carries a bounded deadline, not just the worker signal', async () => {
    // 50ms stand-in for the 30s production ceiling — same code path, no sleep.
    const worker = new AgentWorker(mkCtx({ id: 'shim-2' }), { ...cfg(), toolShimTimeoutMs: 50 });
    const priv = worker as unknown as {
      runToolTranslator: (m: unknown, p: string) => Promise<string>;
    };
    let seen: AbortSignal | undefined;
    // Stands in for a provider that never answers — e.g. ollama cold-loading a
    // 21 GB model — and, like a real HTTP client, aborts when its signal does.
    const completeSpy = vi.spyOn(getLiteLLMClient(), 'complete').mockImplementation((async (opts: {
      signal?: AbortSignal;
    }) => {
      seen = opts.signal;
      return await new Promise((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error('provider never answered')), 5_000);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(opts.signal?.reason);
        }, { once: true });
      });
    }) as never);

    await expect(
      priv.runToolTranslator({ modelId: 'slow-local', provider: 'litellm' }, 'prose'),
    ).rejects.toThrow(/50ms/);
    // The deadline fired and tore the request DOWN — a stuck provider can no
    // longer pin the turn for its own (15 min) timeout.
    expect(seen?.aborted).toBe(true);
    completeSpy.mockRestore();
  });

  test('the production default ceiling is bounded and well under a provider load timeout', () => {
    expect(TOOLSHIM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TOOLSHIM_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
