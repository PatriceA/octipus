import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, refreshConfigKey, resetConfig } from '@/config';
import { renderContractFeedback } from './scorers';
import { SwarmSpawner, applyScorerVerdict } from './spawner';
import type { ChildResult } from './types';

/**
 * The swarm contract-retry loop: a child whose SCORER GATE failed is
 * re-dispatched with the failures quoted back to it, bounded by
 * `config.swarm.contractRetries`.
 *
 * These drive the loop through `runChildWithRetry` — the method the spawn path
 * actually calls — rather than through `retryOnContractFailure` directly. The
 * repo has paid for the difference four times (see the "prove the guard is
 * REACHED" rule in `docs/plans/rebuild-execution-plan.md`): a guard that works
 * when called by hand and is never reached in production is not a guard.
 * `singleSpawnAndRun` is the one thing stubbed, because it is the boundary that
 * boots an agent and calls a model.
 */

/** Minimal ChildResult; only the fields the retry loop reads are meaningful. */
function result(over: Partial<ChildResult> = {}): ChildResult {
  return {
    nodeId: 'n1',
    kind: 'agent',
    status: 'ok',
    output: 'done',
    usedTokens: 100,
    durationMs: 10,
    spawnedChildren: [],
    ...over,
  } as ChildResult;
}

/** A `contract_failed` carrying real scorer failures — the retryable shape. */
function gateFailed(reason = 'file "notes.md" does not exist'): ChildResult {
  return result({
    status: 'contract_failed',
    scorerOutcome: { passed: false, ran: 1, failures: [{ scorer: 'file_exists', reason }] },
    notes: `Scorer gate failed: file_exists: ${reason}`,
  });
}

/**
 * Drive `runChildWithRetry` with a scripted sequence of child results.
 * Returns the final result plus every `childMessage` the spawner passed down,
 * which is how the feedback injection is asserted.
 */
async function runWith(
  results: ChildResult[],
  opts: {
    tokenCap?: number;
    tokensUsed?: number;
    wallCap?: number;
    startedAt?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ final: ChildResult; messages: string[]; calls: number }> {
  const spawner = new SwarmSpawner({} as never);
  const messages: string[] = [];
  let calls = 0;

  (spawner as unknown as { singleSpawnAndRun: unknown }).singleSpawnAndRun = async (o: {
    childMessage: string;
  }) => {
    messages.push(o.childMessage);
    const next = results[Math.min(calls, results.length - 1)];
    calls++;
    return next;
  };

  const base = {
    parent: { id: 'parent-1', rootSessionId: 's1', signal: opts.signal },
    parentContext: { userId: 'u1' },
    childDepth: 1,
    childKind: 'agent',
    childRole: 'coding',
    childModel: 'm1',
    childLane: 'agents',
    childTools: [],
    budget: {
      tokens: { cap: opts.tokenCap ?? 80_000, used: opts.tokensUsed ?? 0 },
      wallClockMs: { cap: opts.wallCap ?? 600_000, startedAt: opts.startedAt ?? Date.now() },
      fanOut: { cap: 4, used: 0 },
      depth: 1,
    },
    topicPath: 'coding',
    subtopic: 'x',
    brief: { taskBrief: 'write notes.md', topicPath: 'coding' },
    briefHash: 'h1',
    childMessage: 'ORIGINAL TASK BODY',
    reason: 'normal',
    spawnMode: 'await',
  };

  const final = await (
    spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }
  ).runChildWithRetry(base);
  return { final, messages, calls };
}

describe('renderContractFeedback', () => {
  it('names every failed scorer and its reason', () => {
    const text = renderContractFeedback(
      [
        { scorer: 'file_exists', reason: 'file "notes.md" does not exist' },
        { scorer: 'json', reason: 'missing required keys: body' },
      ],
      1,
      2,
    );
    expect(text).toContain('file_exists: file "notes.md" does not exist');
    expect(text).toContain('json: missing required keys: body');
    // The run being briefed is the SECOND of three, not the first — telling the
    // final attempt it is "attempt 1 of 2" while rejecting its predecessor is a
    // contradiction the model has to resolve.
    expect(text).toContain('attempt 2 of 3');
  });

  it('returns null when there is nothing actionable to say', () => {
    // A retry prompt naming no defect asks the child to guess what went wrong,
    // which is worse than surfacing the failure — so the loop must not start.
    expect(renderContractFeedback([], 1, 1)).toBeNull();
  });
});

describe('SwarmSpawner — contract retry (through runChildWithRetry)', () => {
  beforeEach(() => {
    resetConfig();
    getConfig();
  });
  afterEach(() => resetConfig());

  it('re-dispatches a scorer-gate failure and leads the retry with the feedback', async () => {
    const { final, messages, calls } = await runWith([gateFailed(), result()]);

    expect(calls).toBe(2);
    expect(final.status).toBe('ok');
    // The retry must SAY what was wrong, and say it before the task it modifies
    // — a correction appended after a long brief is read last or not at all.
    expect(messages[1]).toContain('PREVIOUS ATTEMPT REJECTED');
    expect(messages[1]).toContain('file "notes.md" does not exist');
    expect(messages[1].indexOf('PREVIOUS ATTEMPT REJECTED')).toBeLessThan(
      messages[1].indexOf('ORIGINAL TASK BODY'),
    );
    // The first attempt is untouched — feedback only exists after a rejection.
    expect(messages[0]).toBe('ORIGINAL TASK BODY');
  });

  it('annotates the recovered result so a clean run and a rescued one differ', async () => {
    const { final } = await runWith([gateFailed(), result()]);
    expect(final.notes ?? '').toContain('Recovered after 1 failed attempt(s)');
    expect(final.notes ?? '').toContain('contract_failed');
  });

  it('does NOT claim recovery when the retry failed too', async () => {
    // The parent LLM reads `notes` verbatim beside the status. "Recovered"
    // next to `contract_failed` tells it the opposite of what happened.
    const { final } = await runWith([gateFailed(), gateFailed()]);
    expect(final.status).toBe('contract_failed');
    expect(final.notes ?? '').not.toContain('Recovered');
    expect(final.notes ?? '').toContain('Still failing after 2 attempt(s)');
  });

  it('does NOT retry a contract_failed with no scorer failures (drift abort)', async () => {
    // `DriftDetectedError` maps to `contract_failed` (errors.ts:133) precisely
    // so the crash-retry path would not respawn a wandering child. Retrying on
    // the status rather than on the failures reintroduces that bug from the
    // other side, so this is the regression that matters most here.
    const drift = result({
      status: 'contract_failed',
      notes: 'Task drift detected: 8 consecutive iterations unrelated to the brief',
    });
    const { final, calls } = await runWith([drift, result()]);

    expect(calls).toBe(1);
    expect(final.status).toBe('contract_failed');
  });

  it('stops at the configured bound and returns the failure', async () => {
    refreshConfigKey('swarm.contractRetries', 2);
    const { final, calls } = await runWith([gateFailed(), gateFailed(), gateFailed()]);

    // One initial attempt + two retries. Not more: an unbounded corrective loop
    // burns the pool the parent still needs.
    expect(calls).toBe(3);
    expect(final.status).toBe('contract_failed');
  });

  it('honours contractRetries=0 — the previous behaviour, exactly', async () => {
    refreshConfigKey('swarm.contractRetries', 0);
    const { final, calls } = await runWith([gateFailed(), result()]);

    expect(calls).toBe(1);
    expect(final.status).toBe('contract_failed');
  });

  it('skips the retry when the attempts so far have drained the cap', async () => {
    // Counted from what the attempts REPORTED, not from `budget.tokens.used`:
    // a child's budget is derived fresh per spawn and its `used` stays 0 for
    // the node's whole life, so a guard reading it could never fire. Here the
    // first attempt reports spending nearly the whole cap.
    const drained = gateFailed();
    drained.usedTokens = 78_000;
    const { final, calls } = await runWith([drained, result()], { tokenCap: 80_000 });

    expect(calls).toBe(1);
    expect(final.status).toBe('contract_failed');
    // The diagnosis survives — that is the point of not retrying.
    expect(final.scorerOutcome?.failures).toHaveLength(1);
  });

  it('keeps the diagnosis when the retry dies for an unrelated reason', async () => {
    // A retry that hits the concurrency cap says nothing about the contract.
    // Replacing a diagnosed `contract_failed` (with its failed scorers) by a
    // null-output infrastructure failure hands the parent strictly less.
    const infra = result({ status: 'concurrency_limit', output: null });
    const { final, calls } = await runWith([gateFailed(), infra]);

    expect(calls).toBe(2);
    expect(final.status).toBe('contract_failed');
    expect(final.output).toBe('done');
    expect(final.scorerOutcome?.failures[0].scorer).toBe('file_exists');
  });

  it('reports the tokens of every superseded attempt, not just the survivor', async () => {
    // The pool paid for all of them. `usedTokens` stays the honest cost of the
    // answer that survived; `discardedTokens` is what the cascade must also see.
    const first = gateFailed();
    first.usedTokens = 5_000;
    const { final } = await runWith([first, result({ usedTokens: 3_000 })]);

    expect(final.usedTokens).toBe(3_000);
    expect(final.discardedTokens).toBe(5_000);
  });

  it('counts what earlier attempts already burned, not just the last one', async () => {
    // A crash retry and a backup-model attempt run BEFORE this loop and come
    // out of the same pool. Seeding the guard from the surviving attempt alone
    // let a contract retry start against a pool three attempts had emptied.
    const crashed = result({ status: 'tool_error', usedTokens: 30_000 });
    const gate = gateFailed();
    gate.usedTokens = 30_000;
    const { final, calls } = await runWith([crashed, gate, result()], { tokenCap: 62_000 });

    // Attempt 1 crashed (30k), attempt 2 is the crash retry and fails its gate
    // (30k). 60k of a 62k cap is gone, leaving less than MIN_CHILD_TOKENS, so
    // no contract retry may start. Counting only the survivor would see 30k
    // spent, read 32k as available, and start a third attempt.
    expect(calls).toBe(2);
    expect(final.status).toBe('contract_failed');
  });

  it('stops when the wall clock is spent, even with tokens left', async () => {
    // Wall clock does not cascade: every attempt gets a fresh full cap, so a
    // token-only guard still permits an unbounded wait on an awaited spawn.
    const { final, calls } = await runWith([gateFailed(), result()], {
      wallCap: 60_000,
      startedAt: Date.now() - 61_000,
    });

    expect(calls).toBe(1);
    expect(final.status).toBe('contract_failed');
  });

  it('does not re-dispatch a failure the child has no power over', async () => {
    // No shell tool, a denied permission, a denylisted command, a missing
    // workspace: a second full child run produces the identical refusal.
    const unfixable = result({
      status: 'contract_failed',
      scorerOutcome: {
        passed: false,
        ran: 1,
        failures: [
          {
            scorer: 'command_exit_zero(npm test)',
            reason: 'this child does not hold the shell tool',
            retryable: false,
          },
        ],
      },
    });
    const { final, calls } = await runWith([unfixable, result()]);

    expect(calls).toBe(1);
    expect(final.status).toBe('contract_failed');
  });

  it('still retries when at least one failure is the child’s to fix', async () => {
    const mixed = result({
      status: 'contract_failed',
      scorerOutcome: {
        passed: false,
        ran: 2,
        failures: [
          { scorer: 'command_exit_zero(x)', reason: 'no shell tool', retryable: false },
          { scorer: 'file_exists', reason: 'notes.md does not exist' },
        ],
      },
    });
    const { calls } = await runWith([mixed, result()]);
    expect(calls).toBe(2);
  });

  it('does not re-dispatch onto a cancelled run', async () => {
    // The session is gone; a retry would create a fresh node, agent and model
    // call for work nobody is waiting for.
    const controller = new AbortController();
    controller.abort();
    const { final, calls } = await runWith([gateFailed(), result()], { signal: controller.signal });

    expect(calls).toBe(1);
    expect(final.status).toBe('contract_failed');
  });

  it('hands the retry what is LEFT of the pool, not another full grant', async () => {
    // Each attempt used to get the original cap, so one `spawn_child` could
    // spend a multiple of its grant — and since discarded tokens are now
    // charged honestly, the overspend surfaces as an InsufficientBudgetError on
    // a later sibling that should have fit.
    const spent = gateFailed();
    spent.usedTokens = 50_000;
    const caps: number[] = [];
    const spawner = new SwarmSpawner({} as never);
    let calls = 0;
    (spawner as unknown as { singleSpawnAndRun: unknown }).singleSpawnAndRun = async (o: {
      budget: { tokens: { cap: number } };
    }) => {
      caps.push(o.budget.tokens.cap);
      return calls++ === 0 ? spent : result();
    };
    await (
      spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }
    ).runChildWithRetry({
      parent: { id: 'p', rootSessionId: 's' },
      parentContext: { userId: 'u' },
      childDepth: 1,
      childKind: 'agent',
      childRole: 'coding',
      childModel: 'm',
      childLane: 'agents',
      childTools: [],
      budget: {
        tokens: { cap: 80_000, used: 0 },
        wallClockMs: { cap: 600_000, startedAt: Date.now() },
        fanOut: { cap: 4, used: 0 },
        depth: 1,
      },
      topicPath: 'coding',
      subtopic: 'x',
      brief: { taskBrief: 'b', topicPath: 'coding' },
      briefHash: 'h',
      childMessage: 'TASK',
      reason: 'normal',
      spawnMode: 'await',
    });

    expect(caps[0]).toBe(80_000);
    expect(caps[1]).toBe(30_000);
  });

  it('hands the retry the REMAINING wall clock, not a fresh one', async () => {
    // `singleSpawnAndRun` passes this cap straight to `agentManager.spawn` as
    // the worker's timeout, so sharing a `startedAt` bounds nothing on its own:
    // one `spawn_child` could still block for a multiple of its wall budget.
    const walls: number[] = [];
    const spawner = new SwarmSpawner({} as never);
    let n = 0;
    (spawner as unknown as { singleSpawnAndRun: unknown }).singleSpawnAndRun = async (o: {
      budget: { wallClockMs: { cap: number } };
    }) => {
      walls.push(o.budget.wallClockMs.cap);
      return n++ === 0 ? gateFailed() : result();
    };
    await (
      spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }
    ).runChildWithRetry({
      parent: { id: 'p', rootSessionId: 's' },
      parentContext: { userId: 'u' },
      childDepth: 1,
      childKind: 'agent',
      childRole: 'coding',
      childModel: 'm',
      childLane: 'agents',
      childTools: [],
      budget: {
        tokens: { cap: 80_000, used: 0 },
        wallClockMs: { cap: 600_000, startedAt: Date.now() - 200_000 },
        fanOut: { cap: 4, used: 0 },
        depth: 1,
      },
      topicPath: 'coding',
      subtopic: 'x',
      brief: { taskBrief: 'b', topicPath: 'coding' },
      briefHash: 'h',
      childMessage: 'TASK',
      reason: 'normal',
      spawnMode: 'await',
    });

    expect(walls[0]).toBe(600_000);
    // ~400s left of the original 600s deadline.
    expect(walls[1]).toBeGreaterThan(390_000);
    expect(walls[1]).toBeLessThan(410_000);
  });

  it('restamps the retry’s clock so the deadline is not counted twice', async () => {
    // `cap` and `startedAt` describe ONE absolute deadline. Shrinking the cap
    // while keeping the original start makes every `cap - (now - startedAt)`
    // consumer subtract the elapsed time again — `collect-tool.ts` reads
    // `remaining === 0` from the corrective attempt's first moment.
    const budgets: { cap: number; startedAt: number }[] = [];
    const spawner = new SwarmSpawner({} as never);
    let n = 0;
    (spawner as unknown as { singleSpawnAndRun: unknown }).singleSpawnAndRun = async (o: {
      budget: { wallClockMs: { cap: number; startedAt: number } };
    }) => {
      budgets.push({ ...o.budget.wallClockMs });
      return n++ === 0 ? gateFailed() : result();
    };
    const startedAt = Date.now() - 200_000;
    await (
      spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }
    ).runChildWithRetry({
      parent: { id: 'p', rootSessionId: 's' },
      parentContext: { userId: 'u' },
      childDepth: 1,
      childKind: 'agent',
      childRole: 'coding',
      childModel: 'm',
      childLane: 'agents',
      childTools: [],
      budget: {
        tokens: { cap: 80_000, used: 0 },
        wallClockMs: { cap: 600_000, startedAt },
        fanOut: { cap: 4, used: 0 },
        depth: 1,
      },
      topicPath: 'coding',
      subtopic: 'x',
      brief: { taskBrief: 'b', topicPath: 'coding' },
      briefHash: 'h',
      childMessage: 'TASK',
      reason: 'normal',
      spawnMode: 'await',
    });

    const retry = budgets[1];
    // Roughly the whole remainder is still available to the retry.
    const remaining = retry.cap - (Date.now() - retry.startedAt);
    expect(remaining).toBeGreaterThan(390_000);
  });

  it('will not start a retry that cannot finish', async () => {
    // A remainder of milliseconds is not "time left": the attempt registers a
    // node, boots an agent and is then guaranteed to time out. The token side
    // has had `MIN_CHILD_TOKENS` all along; this is its counterpart.
    const { final, calls } = await runWith([gateFailed(), result()], {
      wallCap: 600_000,
      startedAt: Date.now() - 599_000,
    });

    expect(calls).toBe(1);
    expect(final.status).toBe('contract_failed');
  });

  it('keeps the diagnosis when the retry itself throws', async () => {
    // Same shape as the backup-model retry beside it: a throw says nothing
    // about the contract, and letting it propagate discards the
    // `contract_failed` result and the scorer failures this loop exists to act
    // on.
    const spawner = new SwarmSpawner({} as never);
    let n = 0;
    (spawner as unknown as { singleSpawnAndRun: unknown }).singleSpawnAndRun = async () => {
      if (n++ === 0) return gateFailed();
      throw new Error('agent manager exploded');
    };
    const final = await (
      spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }
    ).runChildWithRetry({
      parent: { id: 'p', rootSessionId: 's' },
      parentContext: { userId: 'u' },
      childDepth: 1,
      childKind: 'agent',
      childRole: 'coding',
      childModel: 'm',
      childLane: 'agents',
      childTools: [],
      budget: {
        tokens: { cap: 80_000, used: 0 },
        wallClockMs: { cap: 600_000, startedAt: Date.now() },
        fanOut: { cap: 4, used: 0 },
        depth: 1,
      },
      topicPath: 'coding',
      subtopic: 'x',
      brief: { taskBrief: 'b', topicPath: 'coding' },
      briefHash: 'h',
      childMessage: 'TASK',
      reason: 'normal',
      spawnMode: 'await',
    });

    expect(final.status).toBe('contract_failed');
    expect(final.scorerOutcome?.failures[0].scorer).toBe('file_exists');
  });

  it('gives the retry a fresh fan-out allowance', async () => {
    // The budget spread shares the `fanOut` OBJECT, so a child that spawned its
    // four subagents in attempt 1 met `concurrency_limit` on every
    // `spawn_child` of the corrective attempt — unable to do the work it was
    // being asked to redo.
    const fanOuts: { cap: number; used: number }[] = [];
    const spawner = new SwarmSpawner({} as never);
    let n = 0;
    (spawner as unknown as { singleSpawnAndRun: unknown }).singleSpawnAndRun = async (o: {
      budget: { fanOut: { cap: number; used: number } };
    }) => {
      fanOuts.push({ ...o.budget.fanOut });
      // Attempt 1 spends its whole allowance, as a real child would.
      o.budget.fanOut.used = o.budget.fanOut.cap;
      return n++ === 0 ? gateFailed() : result();
    };
    await (
      spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }
    ).runChildWithRetry({
      parent: { id: 'p', rootSessionId: 's' },
      parentContext: { userId: 'u' },
      childDepth: 1,
      childKind: 'agent',
      childRole: 'coding',
      childModel: 'm',
      childLane: 'agents',
      childTools: [],
      budget: {
        tokens: { cap: 80_000, used: 0 },
        wallClockMs: { cap: 600_000, startedAt: Date.now() },
        fanOut: { cap: 4, used: 0 },
        depth: 1,
      },
      topicPath: 'coding',
      subtopic: 'x',
      brief: { taskBrief: 'b', topicPath: 'coding' },
      briefHash: 'h',
      childMessage: 'TASK',
      reason: 'normal',
      spawnMode: 'await',
    });

    expect(fanOuts[1]).toEqual({ cap: 4, used: 0 });
  });

  it('leaves a passing child alone', async () => {
    const { final, calls } = await runWith([result()]);
    expect(calls).toBe(1);
    expect(final.status).toBe('ok');
  });
});

describe('applyScorerVerdict — the two outcomes are independent', () => {
  it('fails the contract on a real miss even when the gate was cut short', () => {
    // `runScorers` preserves verdicts across a cancellation; the spawn path has
    // to act on them. An `else if` on `notEvaluated` discards them, leaving the
    // child `ok` with a known `file_exists` miss.
    const v = applyScorerVerdict({
      passed: false,
      ran: 1,
      failures: [{ scorer: 'file_exists', reason: 'notes.md does not exist' }],
      notEvaluated: 'the run was cancelled before the check finished',
    });

    expect(v.contractFailed).toBe(true);
    // Both facts recorded, neither hiding the other.
    expect(v.notes).toContain('not evaluated');
    expect(v.notes).toContain('notes.md does not exist');
  });

  it('records an interruption without inventing a failure', () => {
    const v = applyScorerVerdict({ passed: true, ran: 0, failures: [], notEvaluated: 'cancelled' });
    expect(v.contractFailed).toBe(false);
    expect(v.notes).toContain('not evaluated');
  });

  it('leaves a clean pass alone', () => {
    const v = applyScorerVerdict({ passed: true, ran: 2, failures: [] }, 'existing');
    expect(v.contractFailed).toBe(false);
    expect(v.notes).toBe('existing');
  });
});
