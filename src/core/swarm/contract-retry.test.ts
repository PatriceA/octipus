import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, refreshConfigKey, resetConfig } from '@/config';
import { renderContractFeedback } from './scorers';
import { SwarmSpawner } from './spawner';
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
  opts: { tokenCap?: number; tokensUsed?: number; wallCap?: number; startedAt?: number } = {},
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
    parent: { id: 'parent-1', rootSessionId: 's1' },
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
    expect(text).toContain('attempt 1 of 3');
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

  it('leaves a passing child alone', async () => {
    const { final, calls } = await runWith([result()]);
    expect(calls).toBe(1);
    expect(final.status).toBe('ok');
  });
});
