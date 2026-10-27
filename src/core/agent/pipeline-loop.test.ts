/**
 * The loop, actually running.
 *
 * Everything around it was already covered — `pipeline-graph.test.ts` proves the
 * compiler emits a `qa_fail` back-edge and a `foreach`, and the gate tests prove
 * the gates judge correctly. Nothing drove the WALKER. So "a failing QA verdict
 * sends the item back to the implementer, the second attempt passes, and the
 * loop moves to the next plan item" was a property of the design rather than an
 * observed behaviour of the product.
 *
 * These drive the real `PipelineManager.createAndRun` against a real (embedded)
 * database, with exactly one thing stubbed: `spawnWorker`, the boundary that
 * calls a model. Everything else — graph compilation, node rows, plan items,
 * edge selection, traversal counting, checkpoints, the evidence gate — is the
 * shipping code.
 *
 * Assertions are on what the RUN produced, not on what a stage said about
 * itself: the recorded visit counts per node, and the plan-item rows the loop
 * left behind.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '33333333-3333-3333-3333-333333333333';

/** One call the stubbed worker received. */
interface WorkerCall {
  role: string;
  stageName: string;
  input: string;
  resumeKey?: unknown;
  workerId: string;
  metadata: Record<string, unknown>;
  skillIds?: string[];
  decideSkills?: boolean;
}

let manager: import('./pipeline-manager').PipelineManager;
let queryRaw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
let executeRaw: (sql: string) => Promise<unknown>;
let sessionId: string;
let calls: WorkerCall[];
/** Stage name → the replies it gives, in order; the last one repeats. */
let replies: Record<string, string[]>;
/** How many times the run escalated to a human. */
let approvalsAsked = 0;
/** What the stubbed human answers. */
let approvalAnswer: { approved: boolean; response?: string; reason?: string } = { approved: false, response: 'Abort Pipeline' };
let tokenCharges: Record<string, number> = {};
let commandCounts: number[] = [];
let uncertainByStage: Record<string, string[]> = {};
let stopAtStage: string | undefined;
/** Stage name → per-call plan: a string (or one built from the call) makes that call throw it, undefined runs normally. */
let throwPlan: Record<string, Array<string | ((call: WorkerCall) => string) | undefined>> = {};
/** Stage name → per-call progress the worker reports before it replies or throws. */
let partialPlan: Record<string, Array<string | undefined>> = {};
/** Runs inside the stubbed worker before it replies or throws. */
let onSpawn: ((stageName: string, pipelineId: string, call: WorkerCall) => Promise<void>) | undefined;

/**
 * A PASSING verdict that survives the audit-coverage gate.
 *
 * `{"passed": true, "issues": []}` does not, and should not: the gate rejects a
 * pass that states no `whatIDidNotCheck`, which is the rubber stamp it exists to
 * catch. Writing the fixture the lazy way had this suite reporting the walker
 * broken when the walker was fine and the gate was working — worth keeping as a
 * comment, because the next person will reach for the short version too.
 */
const QA_PASS = [
  '```json',
  '{"passed": true, "issues": [], "feedback": "Implement: ran the item end to end.",',
  ' "whatIDidNotCheck": ["performance under load"], "confidence": "high"}',
  '```',
].join('\n');

const qaFail = (issue: string) =>
  [
    '```json',
    `{"passed": false, "issues": ["${issue}"], "feedback": "Implement: ${issue}",`,
    ' "whatIDidNotCheck": [], "confidence": "high"}',
    '```',
  ].join('\n');

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-pipe-loop-'));

  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  executeRaw = pg.executeRaw as typeof executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'loop-user' }]);
  sessionId = (await seedSession({ userId, channelId: 'loop-1' })).id;

  // A two-item plan loop: Implement (declares nothing) → QA (the auditor).
  // Deliberately smaller than the shipped preset so a failure here points at
  // the walker rather than at seven stages of prompt.
  const steps = [
    { name: 'Plan', topic: 'architecture', producesPlan: true, promptTemplate: 'plan: {{description}}' },
    { name: 'Implement', topic: 'coding', loopOverPlan: true, promptTemplate: 'implement: {{description}}' },
    {
      name: 'QA',
      runsCommands: true,
      topic: 'qa',
      loopOverPlan: true,
      stageType: 'qa_validation',
      maxRetries: 2,
      promptTemplate: 'qa: {{description}}',
    },
  ];
  await executeRaw(
    `INSERT INTO pipeline_templates (user_id, name, is_preset, steps)
     VALUES (NULL, 'loop-fixture', true, '${JSON.stringify(steps)}'::jsonb)`,
  );
  // The same loop, capped at one item, with stage-declared skills.
  const capped = steps.map((step) =>
    step.name === 'Implement' ? { ...step, maxPlanItems: 1, skillIds: ['caveman'] }
      : step.name === 'QA' ? { ...step, autoSkills: true } : step);
  await executeRaw(
    `INSERT INTO pipeline_templates (user_id, name, is_preset, steps)
     VALUES (NULL, 'loop-capped', true, '${JSON.stringify(capped)}'::jsonb)`,
  );
  // The same loop with a plan sign-off that approves itself when nobody watches.
  const autoApproved = steps.map((step) =>
    step.name === 'Implement' ? { ...step, requiresApproval: true, autoApproveUnattended: true } : step);
  await executeRaw(
    `INSERT INTO pipeline_templates (user_id, name, is_preset, steps)
     VALUES (NULL, 'loop-auto-approve', true, '${JSON.stringify(autoApproved)}'::jsonb)`,
  );

  const { PipelineManager } = await import('./pipeline-manager');
  manager = new PipelineManager();

  // The one stubbed boundary. It also plays the planner: a `producesPlan` stage
  // is expected to leave plan items behind, so the stub writes two, exactly as
  // a real planner would through the `plan` tool.
  const { getAgentService } = await import('./index');
  const service = getAgentService();

  // An exhausted retry budget ASKS A HUMAN rather than passing the work — so a
  // suite with nobody watching hangs on the approval channel unless it answers.
  // Answering "no" is the honest stand-in for an operator who declines to wave
  // failing work through, and it is what lets the assertion below be about the
  // run's recorded outcome instead of about a timeout.
  vi.spyOn(service, 'requestApproval').mockImplementation(async () => {
    approvalsAsked++;
    return approvalAnswer;
  });

  vi.spyOn(service, 'spawnWorker').mockImplementation((async (
    role: string,
    input: string,
    _ctx: unknown,
    context: AgentContext & { stageName?: string },
    options?: {
      onTokens?: (tokens: number) => void;
      onCounters?: (counters: import('@/core/swarm/receipt').SideEffectCounters) => void;
      onPartialOutput?: (text: string) => void;
      onWorkerSpawned?: (workerId: string) => void;
      swarmParent?: { signal?: AbortSignal };
      skillIds?: string[];
      decideSkills?: boolean;
    },
  ) => {
    const stageName = context?.stageName ?? '';
    const call: WorkerCall = { role, stageName, input, resumeKey: context.metadata?.resumeKey, workerId: `worker-${calls.length + 1}`, metadata: { ...context.metadata },
      skillIds: options?.skillIds, decideSkills: options?.decideSkills };
    calls.push(call);
    options?.onTokens?.(tokenCharges[stageName] ?? 0);
    options?.onWorkerSpawned?.(call.workerId);
    await onSpawn?.(stageName, String(context.metadata?.pipelineId), call);
    // A real stage worker is torn down when the signal it was spawned under aborts.
    const parentSignal = options?.swarmParent?.signal;
    if (parentSignal?.aborted) throw new Error(`Worker "${role}" stopped: ${String(parentSignal.reason)}`);
    if (stageName === stopAtStage) await manager.stop(String(context.metadata?.pipelineId));
    const progress = partialPlan[stageName]?.shift();
    if (progress) options?.onPartialOutput?.(progress);
    const thrown = throwPlan[stageName]?.shift();
    if (thrown) throw new Error(typeof thrown === 'function' ? thrown(call) : thrown);
    options?.onCounters?.({ ...(uncertainByStage[stageName] ? { uncertainActionIds: uncertainByStage[stageName] } : {}), filesChanged: 0, commandsRun: stageName === 'QA' ? commandCounts.shift() ?? 1 : 1, toolCalls: 1, toolErrors: 0, approvalsRequired: 0, approvalsDenied: 0, autoApproved: 0, permissionDenials: 0, byName: {} });

    if (stageName === 'Plan') {
      const pipelineId = (context.metadata as { pipelineId?: string })?.pipelineId;
      const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
      if ((await pipelineRepository.getPlanItems(pipelineId!)).length) return 'retained existing plan';
      await pipelineRepository.addPlanItems([
        { pipelineId: pipelineId!, ordinal: 0, title: 'item one' },
        { pipelineId: pipelineId!, ordinal: 1, title: 'item two' },
      ]);
      return 'planned 2 items';
    }

    const scripted = replies[stageName];
    if (!scripted?.length) return `${stageName} ok`;
    // Consume up to the last, which then repeats — so a script says "fail once,
    // then pass forever" without counting visits.
    return scripted.length > 1 ? (scripted.shift() as string) : scripted[0];
  }) as never);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const pg = await import('@/db/postgres');
  await pg.closeDb?.();
});

beforeEach(() => {
  calls = [];
  uncertainByStage = {};
  replies = {};
  approvalsAsked = 0;
  tokenCharges = {};
  approvalAnswer = { approved: false, response: 'Abort Pipeline' };
  commandCounts = [];
  stopAtStage = undefined;
  throwPlan = {};
  partialPlan = {};
  onSpawn = undefined;
});

/** Visits per node name, read from the rows the run wrote. */
async function visitsByNode(pipelineId: string): Promise<Record<string, number>> {
  const { rows } = await queryRaw(
    `SELECT name, visits FROM pipeline_nodes WHERE pipeline_id = '${pipelineId}' ORDER BY ordinal`,
  );
  return Object.fromEntries(rows.map((r) => [String(r.name), Number(r.visits)]));
}

async function planItemStatuses(pipelineId: string): Promise<string[]> {
  const { rows } = await queryRaw(
    `SELECT status FROM plan_items WHERE pipeline_id = '${pipelineId}' ORDER BY ordinal`,
  );
  return rows.map((r) => String(r.status));
}

function run(description: string, template = 'loop-fixture', context: Partial<AgentContext> = {}) {
  return manager.createAndRun(
    'orch-loop',
    sessionId,
    userId,
    'loop test',
    template,
    description,
    { userId, sessionId, agentId: 'orch-loop', ...context } as unknown as AgentContext,
  );
}

describe('the plan loop runs the body once per item', () => {
  test('two plan items produce two passes, and both items end done', async () => {
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await run('do the thing');

    const visits = await visitsByNode(pipelineId);
    // The planner runs once; the body runs once per item. This is the loop the
    // old list-walker could not express at all.
    expect(visits.Plan).toBe(1);
    expect(visits.Implement).toBe(2);
    expect(visits.QA).toBe(2);
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);

    const { rows } = await queryRaw(`SELECT status FROM pipelines WHERE id = '${pipelineId}'`);
    expect(rows[0].status).toBe('completed');
  });

  test('each pass carries its own item into the implementer', async () => {
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await run('do the thing');
    expect(pipelineId).toBeTruthy();

    const implementInputs = calls.filter((c) => c.stageName === 'Implement').map((c) => c.input);
    expect(implementInputs).toHaveLength(2);
    expect(implementInputs[0]).toContain('item one');
    expect(implementInputs[1]).toContain('item two');
    // A loop that handed every pass the same item would still visit twice and
    // still finish green, so the visit count alone cannot prove iteration.
    expect(implementInputs[0]).not.toContain('item two');
  });
});

describe('the plan loop item limit', () => {
  test('stops after the limit and marks the rest skipped, with the reason', async () => {
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await run('do the thing', 'loop-capped');

    const visits = await visitsByNode(pipelineId);
    expect(visits.Implement).toBe(1);
    expect(visits.QA).toBe(1);
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'skipped']);
    const { rows } = await queryRaw(`SELECT error FROM plan_items WHERE pipeline_id = '${pipelineId}' AND status = 'skipped'`);
    expect(String(rows[0].error)).toContain('limited to 1 item');
    // A cap is a configured stop, not a failure: the run still completes.
    const { rows: p } = await queryRaw(`SELECT status FROM pipelines WHERE id = '${pipelineId}'`);
    expect(p[0].status).toBe('completed');
  });
});

describe('plan approval when nobody is watching', () => {
  test('an unattended run approves the plan by itself, says so, and runs the loop', async () => {
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await run('do the thing', 'loop-auto-approve', { attended: false });
    expect(approvalsAsked).toBe(0);
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
    const { rows } = await queryRaw(`SELECT status FROM pipelines WHERE id = '${pipelineId}'`);
    expect(rows[0].status).toBe('completed');
    const { rows: msgs } = await queryRaw(
      `SELECT content FROM messages WHERE session_id = '${sessionId}' AND metadata->>'pipelineId' = '${pipelineId}' AND metadata->>'pipelineEvent' = 'auto_approved'`,
    );
    expect(String(msgs[0]?.content)).toContain('no one was watching');
    const { rows: head } = await queryRaw(`SELECT status, approved_by FROM pipeline_nodes WHERE pipeline_id = '${pipelineId}' AND kind = 'foreach'`);
    // Approved, by nobody: never recorded as a person's yes.
    expect(head[0]).toMatchObject({ status: 'completed', approved_by: null });
  });

  test('an attended run still asks', async () => {
    const { pipelineId } = await run('do the thing', 'loop-auto-approve', { attended: true });
    expect(approvalsAsked).toBe(1);
    const { rows } = await queryRaw(`SELECT status, summary FROM pipelines WHERE id = '${pipelineId}'`);
    expect(rows[0]).toMatchObject({ status: 'paused', summary: 'Plan rejected by user.' });
  });

  test('an approval nobody answered pauses the run as unanswered, not as rejected', async () => {
    approvalAnswer = { approved: false, reason: 'Approval timed out' };
    const { pipelineId } = await run('do the thing', 'loop-auto-approve');
    const { rows } = await queryRaw(`SELECT status, summary FROM pipelines WHERE id = '${pipelineId}'`);
    expect(rows[0].status).toBe('paused');
    expect(String(rows[0].summary)).toContain('Nobody answered the plan approval');
  });
});

describe('stage skills reach the worker', () => {
  test('declared skills and the decision-model opt-in are passed per stage', async () => {
    replies = { QA: [QA_PASS] };
    await run('do the thing', 'loop-capped');
    const implement = calls.find((c) => c.stageName === 'Implement');
    const qa = calls.find((c) => c.stageName === 'QA');
    expect(implement?.skillIds).toEqual(['caveman']);
    expect(implement?.decideSkills).toBeUndefined();
    expect(qa?.skillIds).toBeUndefined();
    expect(qa?.decideSkills).toBe(true);
  });
});

describe('a failed QA verdict sends the item back', () => {
  test('the implementer re-runs, and the verdict travels with it', async () => {
    replies = { QA: [qaFail('the tests do not pass'), QA_PASS] };
    const { pipelineId } = await run('do the thing');

    const visits = await visitsByNode(pipelineId);
    // Item one: implement, QA fails, implement again, QA passes. Item two:
    // implement, QA passes. Three implements, three QAs.
    expect(visits.Implement).toBe(3);
    expect(visits.QA).toBe(3);
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);

    // The retry is only a loop if the second attempt is told what was wrong.
    const retryInput = calls.filter((c) => c.stageName === 'Implement')[1].input;
    expect(retryInput).toContain('the tests do not pass');
  });

  test('the retry bound holds, and an exhausted loop asks instead of passing', async () => {
    // QA never passes. `maxRetries: 2` bounds the back-edge, so the run must
    // stop cycling — and must not come back `completed`, which is the exact
    // failure this whole effort exists to prevent.
    replies = { QA: [qaFail('still broken')] };
    const { pipelineId } = await run('do the thing');

    const visits = await visitsByNode(pipelineId);
    // Bounded: the first attempt plus at most two retries.
    expect(visits.Implement).toBeLessThanOrEqual(3);
    expect(visits.QA).toBeLessThanOrEqual(3);

    // It escalated rather than deciding for itself.
    expect(approvalsAsked).toBeGreaterThan(0);

    const { rows } = await queryRaw(`SELECT status FROM pipelines WHERE id = '${pipelineId}'`);
    expect(rows[0].status).not.toBe('completed');
    expect(await planItemStatuses(pipelineId)).not.toContain('done');
  });
});

describe('an item discovered mid-run joins the same loop', () => {
  test('the loop re-reads the plan, so an appended item is picked up', async () => {
    // The live-plan property the `plan` tool's docstring promises: a stage that
    // finds work out of scope appends it and the same run does it. Asserted
    // through the walker, since "the loop re-reads the table" is a claim about
    // the walker and not about the tool.
    let appended = false;
    replies = { QA: [QA_PASS] };
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const original = pipelineRepository.getPlanItems.bind(pipelineRepository);
    const spy = vi
      .spyOn(pipelineRepository, 'getPlanItems')
      .mockImplementation(async (pipelineId: string) => {
        const items = await original(pipelineId);
        if (!appended && items.length === 2 && items.some((i) => i.status === 'done')) {
          appended = true;
          await pipelineRepository.addPlanItems([
            { pipelineId, ordinal: 2, title: 'item three, found while working' },
          ]);
          return original(pipelineId);
        }
        return items;
      });

    const { pipelineId } = await run('do the thing');
    spy.mockRestore();

    expect(appended, 'the fixture must actually have appended an item').toBe(true);
    const visits = await visitsByNode(pipelineId);
    expect(visits.Implement).toBe(3);
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done', 'done']);
  });
});

describe('pipeline replay consent', () => {
  test('denied rewind preserves checkpoints and starts no workers', async () => {
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await run('prepare recovery fixture');
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const checkpoints = await pipelineRepository.getCheckpoints(pipelineId, 100);
    const oldest = checkpoints[checkpoints.length - 1];
    const { getPermissionManager } = await import('@/security/permissions');
    const permissions = getPermissionManager();
    const unsubscribe = permissions.onRequest(request => { void permissions.deny(request.requestId, userId); });
    const priorCalls = calls.length;
    try { await expect(manager.resume(pipelineId, { fromSeq: oldest.seq })).rejects.toThrow('not approved'); }
    finally { unsubscribe(); }
    expect(calls).toHaveLength(priorCalls);
    expect(await pipelineRepository.getCheckpoints(pipelineId, 100)).toEqual(checkpoints);
    expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
  });

  test('another resume cannot pass a pending recovery review', async () => {
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await run('prepare concurrent resume fixture');
    const { getPermissionManager } = await import('@/security/permissions');
    const permissions = getPermissionManager(); let requestId = '';
    const unsubscribe = permissions.onRequest(request => { requestId = request.requestId; });
    const pending = manager.resume(pipelineId);
    const rejection = expect(pending).rejects.toThrow('not approved');
    try {
      await vi.waitFor(() => expect(requestId).not.toBe(''));
      await expect(manager.resume(pipelineId)).rejects.toThrow('already awaiting');
      await permissions.deny(requestId, userId);
      await rejection;
    } finally { unsubscribe(); }
  });
});

test('stop after replay approval but before reconstruction completes does not restart workers', async () => {
  replies = { QA: [QA_PASS] };
  const { pipelineId } = await run('prepare stop during resume fixture');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const checkpoints = await pipelineRepository.getCheckpoints(pipelineId, 100);
  const oldest = checkpoints[checkpoints.length - 1];
  const { getPermissionManager } = await import('@/security/permissions');
  const permissions = getPermissionManager();
  let approved = false;
  const unsubscribe = permissions.onRequest(request => {
    void permissions.approve(request.requestId, userId).then(() => { approved = true; });
  });
  // The second getNodes is recipe reconstruction, after the recovery review.
  const original = pipelineRepository.getNodes.bind(pipelineRepository);
  let release!: () => void; let nodeReads = 0;
  const lookup = vi.spyOn(pipelineRepository, 'getNodes').mockImplementation(async id => {
    if (++nodeReads === 2) await new Promise<void>(resolve => { release = resolve; });
    return original(id);
  });
  const priorCalls = calls.length;
  const pending = manager.resume(pipelineId, { fromSeq: oldest.seq });
  const rejected = expect(pending).rejects.toThrow('Pipeline replay cancelled');
  try {
    await vi.waitFor(() => { expect(approved).toBe(true); expect(release).toBeDefined(); });
    await manager.stop(pipelineId); release(); await rejected;
    expect(calls).toHaveLength(priorCalls);
    expect(await pipelineRepository.getCheckpoints(pipelineId, 100)).toEqual(checkpoints);
  } finally { unsubscribe(); lookup.mockRestore(); }
});


describe('stage contract retries', () => {
  test('retries a failed execution contract with feedback and then finishes all items', async () => {
    replies = { QA: [QA_PASS] };
    commandCounts = [0, 1, 1];
    const { pipelineId } = await run('retry the contract');
    expect((await visitsByNode(pipelineId)).QA).toBe(3);
    expect(calls.filter(call => call.stageName === 'QA')[1].input).toContain('ran 0 commands');
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
  });
  test('stops at the retry budget, lists remaining items and saves the retry count', async () => {
    replies = { QA: [QA_PASS] };
    commandCounts = [0, 0, 0, 0];
    const { pipelineId, result } = await run('exhaust the contract');
    expect((await visitsByNode(pipelineId)).QA).toBe(3);
    expect(result).toContain('Remaining items: item one; item two');
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const checkpoint = (await pipelineRepository.getCheckpoints(pipelineId, 1))[0];
    expect(Object.values(checkpoint.state.contractRetries as Record<string, number>)).toContain(2);
    expect((await planItemStatuses(pipelineId))[1]).toBe('pending');
  });
});


describe('a pipeline outlives the root turn that started it', () => {
  async function withRootAgent<T>(fn: (turn: AbortController, stop: AbortController) => Promise<T>): Promise<T> {
    const { getAgentManager } = await import('@/core/agent-manager');
    const turn = new AbortController();
    const stop = new AbortController();
    const spy = vi.spyOn(getAgentManager(), 'get').mockImplementation(((id: string) =>
      id === 'orch-loop' ? { getAbortSignal: () => turn.signal, getStopSignal: () => stop.signal } : undefined) as never);
    try {
      return await fn(turn, stop);
    } finally {
      spy.mockRestore();
    }
  }

  test('the turn ending (its run signal aborting) does not stop the run', async () => {
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await withRootAgent(async (turn) => {
      // create_pipeline returned its handle; the CLI root's run ends and aborts its signal.
      onSpawn = async (stage) => { if (stage === 'Implement') turn.abort('CLI run ended'); };
      return run('outlives its turn');
    });
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    expect((await pipelineRepository.findById(pipelineId))?.status).toBe('completed');
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
  });

  test('stopping the root agent still stops the run', async () => {
    replies = { QA: [QA_PASS] };
    const outcome = await withRootAgent(async (_turn, stop) => {
      onSpawn = async (stage) => { if (stage === 'Implement') stop.abort('manual stop'); };
      return run('stopped with its root').then(r => r.pipelineId, () => undefined);
    });
    const { rows } = await queryRaw(`SELECT status FROM pipelines ORDER BY created_at DESC LIMIT 1`);
    expect(rows[0]?.status).toBe('stopped');
    if (outcome) expect(calls.filter(c => c.stageName === 'QA')).toHaveLength(0);
  });
});

test('stopping an active stage retains its checkpoint and never advances to another item', async () => {
  stopAtStage = 'QA';
  replies = { QA: [QA_PASS] };
  const { pipelineId } = await run('stop during QA');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  expect((await pipelineRepository.findById(pipelineId))?.status).toBe('stopped');
  expect((await pipelineRepository.getNodes(pipelineId)).find(node => node.name === 'QA')?.status).toBe('pending');
  expect(await planItemStatuses(pipelineId)).toEqual(['running', 'pending']);
  const checkpoint = (await pipelineRepository.getCheckpoints(pipelineId, 1))[0];
  expect(checkpoint.state.previousOutput).toContain('Implement');
});

test('queued plan edits apply atomically at the next item boundary', async () => {
  replies = { QA: [QA_PASS] };
  let queued = false;
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  onSpawn = async (stage, pipelineId) => {
    if (stage !== 'Implement' || queued) return;
    queued = true;
    const items = await pipelineRepository.getPlanItems(pipelineId);
    await pipelineRepository.queueItemEdit(pipelineId, { skip: [items[1].id], add: [{ title: 'Replacement item' }], evidence: 'User changed the remaining scope' });
    expect((await pipelineRepository.getPlanItems(pipelineId))[1].status).toBe('pending');
    // A concurrent stage transition must not overwrite the queued root edits.
    await pipelineRepository.updatePipeline(pipelineId, { metadata: {} });
    expect((await pipelineRepository.findById(pipelineId))?.metadata?.pendingItemEdits).toBeTruthy();
  };
  const { pipelineId } = await run('edit at boundary');
  const items = await pipelineRepository.getPlanItems(pipelineId);
  expect(items.map(item => item.status)).toEqual(['done', 'skipped', 'done']);
  expect(items[2].title).toBe('Replacement item');
});

test('stage history retains separate results for both items and the reason for a retry', async () => {
  replies = { QA: [QA_PASS] };
  commandCounts = [0, 1, 1];
  const { pipelineId } = await run('history across items');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const items = await pipelineRepository.getPlanItems(pipelineId);
  await vi.waitFor(async () => {
    const history = await pipelineRepository.getStageHistory(pipelineId);
    const starts = history.filter(event => event.event === 'spawn').map(event => event.payload as Record<string, unknown>);
    expect(starts.some(event => String(event.startReason).startsWith('contract_retry:'))).toBe(true);
    for (const item of items) {
      const completed = history.filter(event => event.event === 'node_completed' && (event.payload as Record<string, unknown>).itemId === item.id);
      expect(completed.length).toBeGreaterThanOrEqual(2);
      expect(completed.every(event => (event.payload as Record<string, unknown>).attemptId && typeof (event.payload as Record<string, unknown>).output === 'string')).toBe(true);
    }
  });
});

test('resume watchdog fails stalled scheduling but allows a pending human review', async () => {
  replies = { QA: [QA_PASS] };
  const { pipelineId } = await run('watchdog fixture');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  await pipelineRepository.updatePipeline(pipelineId, { status: 'awaiting_approval', metadata: { pendingApproval: { requestId: 'review' } } });
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    manager['watchResume'](pipelineId);
    vi.setSystemTime(Date.now() + 121_000);
    await vi.advanceTimersByTimeAsync(5000);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await pipelineRepository.findById(pipelineId))?.status).toBe('awaiting_approval');
    await pipelineRepository.updatePipeline(pipelineId, { status: 'planning', metadata: {} });
    vi.setSystemTime(Date.now() + 121_000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(async () => expect(await pipelineRepository.findById(pipelineId)).toMatchObject({ status: 'failed', summary: expect.stringContaining('Resume watchdog') }));
  } finally { manager['clearResumeWatchdog'](pipelineId); vi.useRealTimers(); }
});

test('resume reuses completed stages and finishes the remaining plan items', async () => {
  stopAtStage = 'QA';
  replies = { QA: [QA_PASS] };
  const { pipelineId } = await run('resume the saved QA stage');
  const priorCalls = calls.length;
  stopAtStage = undefined;
  // Simulate an older run without a link and a coordinator-owned visible plan.
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { workPlanRepository } = await import('@/db/repositories/work-plan-repository');
  const { reviseWorkPlan, planUpdateSchema } = await import('@/shared/work-plan');
  await pipelineRepository.updatePipeline(pipelineId, { metadata: {} });
  const visible = await workPlanRepository.read(sessionId, userId);
  const coordinated = reviseWorkPlan(visible, planUpdateSchema.parse({ ...visible.current, revision: visible.revision, summary: 'Coordinator updated the plan' }));
  await workPlanRepository.save(sessionId, userId, visible.revision, coordinated);
  // Recovery approval is tested separately; this test exercises the actual
  // checkpoint walker after approval, without launching a model or asking a user.
  const { actionRecovery } = await import('@/core/action-recovery');
  const approval = vi.spyOn(actionRecovery, 'reviewPipeline').mockResolvedValue();
  try {
    await manager.resume(pipelineId);
    expect(calls.slice(priorCalls).map(call => call.stageName)).toEqual(['QA', 'Implement', 'QA']);
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
    expect((await visitsByNode(pipelineId)).Plan).toBe(1);
    expect((await workPlanRepository.read(sessionId, userId)).current?.sourcePipelineId).toBe(pipelineId);
  } finally { approval.mockRestore(); }
});


test('launching over a coordinator plan retains all phases and skips completed work', async () => {
  const { workPlanRepository } = await import('@/db/repositories/work-plan-repository');
  const { reviseWorkPlan, planUpdateSchema } = await import('@/shared/work-plan');
  const state = await workPlanRepository.read(sessionId, userId);
  const planned = reviseWorkPlan(state, planUpdateSchema.parse({ revision: state.revision, newPlan: true,
    title: 'All phases', goal: 'Finish the app', summary: 'Six phases',
    steps: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: `Phase ${i}`, status: i === 0 ? 'done' : 'pending', evidence: i === 0 ? 'Already verified' : '' })),
  }));
  await workPlanRepository.save(sessionId, userId, state.revision, planned);
  replies = { QA: [QA_PASS] };
  const { pipelineId } = await run('complete all phases');
  expect(await planItemStatuses(pipelineId)).toEqual(Array(6).fill('done'));
  expect((await visitsByNode(pipelineId)).Implement).toBe(5);
  expect(calls.find(call => call.stageName === 'Plan')?.input).toContain('do not append duplicates');
  const visible = await workPlanRepository.read(sessionId, userId);
  // The coordinator's plan keeps its identity (#14).
  expect(visible.current).toMatchObject({ id: planned.current!.id, title: 'All phases', goal: 'Finish the app' });
  expect(visible.current?.steps.map(step => step.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  expect(visible.current?.steps).toHaveLength(6);
  expect(visible.current?.steps.every(step => step.status === 'done')).toBe(true);
});


describe('an unanswered approval parks the stage instead of failing the run (#12/#20/#22)', () => {
  /** The newest parked pipeline's pending request, once the walker has parked it. */
  async function parkedApproval() {
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    return vi.waitFor(async () => {
      const { rows } = await queryRaw(`SELECT id FROM pipelines WHERE status = 'awaiting_approval' ORDER BY created_at DESC LIMIT 1`);
      const pipeline = await pipelineRepository.findById(String(rows[0]?.id));
      const pending = (pipeline?.metadata as { pendingApproval?: import('./pipeline-manager').PendingStageApproval })?.pendingApproval;
      expect(pending).toBeDefined();
      return pending!;
    }, { timeout: 10_000, interval: 50 });
  }
  const blocked = { toolId: 'cli-native:Bash', action: 'Bash', toolName: 'Bash', args: { command: 'docker compose build' } };
  /** The stage worker's own request, as the CLI bridge raises it before it gives up waiting. */
  const raise = async (agentId: string, args: Record<string, unknown> = blocked.args) => {
    const { getPermissionManager } = await import('@/security/permissions');
    // Labelled exactly as src/core/cli-permissions.ts labels it: the label is not the routed tool name.
    return getPermissionManager().requestApproval(userId, agentId, blocked.toolId, blocked.action, args, sessionId, `CLI: ${blocked.toolName}`);
  };

  test.each(['APPROVAL_TIMEOUT_REASON', 'APPROVAL_DISCONNECT_REASON'] as const)('%s: approving re-runs that stage attempt and the run completes', async key => {
    const { approvalWaitReason, [key]: reason } = await import('@/core/approval-wait');
    replies = { QA: [QA_PASS] };
    const { getPermissionManager } = await import('@/security/permissions');
    const { routeApprovalFor } = await import('@/security/approval-route');
    const routes: string[] = [];
    let requestId = '';
    throwPlan = { Implement: [() => `Worker "coding" failed: ${approvalWaitReason(reason, requestId)}`] };
    let implementRuns = 0;
    onSpawn = async (stageName, _pipelineId, call) => {
      if (stageName !== 'Implement') return;
      if (++implementRuns === 1) requestId = await raise(call.workerId);
      // Routed as that worker: its own framework-set stage metadata.
      routes.push((await routeApprovalFor({ userId, sessionId, role: 'coding', attended: true, metadata: call.metadata }, blocked, { level: 'ASK' })).route);
    };
    const running = run('park on an unanswered approval');
    const pending = await parkedApproval();
    expect(pending).toMatchObject({ stage: 'Implement', item: 'item one', reason: expect.stringContaining(reason), subject: 'docker compose build', workerRequestId: requestId });
    expect(await getPermissionManager().approve(pending.requestId, userId)).toBe(true);
    const { pipelineId } = await running;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const pipeline = await pipelineRepository.findById(pipelineId);
    expect(pipeline?.status).toBe('completed');
    expect((pipeline?.metadata as Record<string, unknown>).pendingApproval).toBeUndefined();
    expect(calls.map(call => call.stageName)).toEqual(['Plan', 'Implement', 'Implement', 'QA', 'Implement', 'QA']);
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
    const implement = calls.filter(call => call.stageName === 'Implement');
    // Asked before the approval; the re-run of THAT attempt runs it without
    // asking; the next item is a new attempt and asks again.
    expect(routes).toEqual(['ask_human', 'execute', 'ask_human']);
    expect((pipeline?.metadata as Record<string, unknown>).approvedCalls).toEqual([expect.objectContaining({
      toolId: blocked.toolId, action: blocked.action, nodeKey: implement[0].metadata.nodeKey, attemptId: implement[0].metadata.attemptId, hostServices: false,
    })]);
    // The re-run continues the same vendor CLI conversation and is told why (#20); the next item starts its own.
    expect(implement[1].resumeKey).toBe(implement[0].resumeKey);
    expect(implement[1].metadata.attemptId).toBe(implement[0].metadata.attemptId);
    expect(implement[1].input).toContain('`docker compose build` may run now');
    expect(implement[2].resumeKey).not.toBe(implement[0].resumeKey);
  });

  test('interleaved workers: the stage parks on its own request, never on a newer one from another worker', async () => {
    const { APPROVAL_TIMEOUT_REASON, approvalWaitReason } = await import('@/core/approval-wait');
    replies = { QA: [QA_PASS] };
    let own = '';
    throwPlan = { Implement: [() => approvalWaitReason(APPROVAL_TIMEOUT_REASON, own)] };
    onSpawn = async (stageName, _pipelineId, call) => {
      if (stageName !== 'Implement' || own) return;
      own = await raise(call.workerId, { command: 'npm run build' });
      // Another worker of the same session asks afterwards: the newest request, not this stage's.
      await raise('unrelated-worker', { command: 'rm -rf build' });
    };
    const running = run('interleaved approvals');
    const pending = await parkedApproval();
    expect(pending).toMatchObject({ workerRequestId: own, subject: 'npm run build' });
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().deny(pending.requestId, userId);
    await running;
  });

  test('a request that is not the stage worker\'s own is not adopted: it parks without a grant', async () => {
    const { APPROVAL_TIMEOUT_REASON, approvalWaitReason } = await import('@/core/approval-wait');
    replies = { QA: [QA_PASS] };
    let foreign = '';
    throwPlan = { Implement: [() => approvalWaitReason(APPROVAL_TIMEOUT_REASON, foreign)] };
    onSpawn = async stageName => {
      if (stageName === 'Implement' && !foreign) foreign = await raise('unrelated-worker', { command: 'rm -rf build' });
    };
    const running = run('foreign approval');
    const pending = await parkedApproval();
    expect(pending).toMatchObject({ workerRequestId: null, toolId: null, subject: null, fingerprint: null });
    const { getPermissionManager } = await import('@/security/permissions');
    expect(await getPermissionManager().approve(pending.requestId, userId)).toBe(true);
    const { pipelineId } = await running;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    expect(((await pipelineRepository.findById(pipelineId))?.metadata as Record<string, unknown>).approvedCalls).toBeUndefined();
  });

  test('a denial pauses the run at that stage; it never fails', async () => {
    const { APPROVAL_TIMEOUT_REASON } = await import('@/core/approval-wait');
    replies = { QA: [QA_PASS] };
    throwPlan = { QA: [`Worker "qa" failed: ${APPROVAL_TIMEOUT_REASON}`] };
    const running = run('deny the parked approval');
    const pending = await parkedApproval();
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().deny(pending.requestId, userId);
    const { pipelineId, result } = await running;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    expect((await pipelineRepository.findById(pipelineId))?.status).toBe('paused');
    expect(result).toContain('not granted');
    expect((await pipelineRepository.getNodes(pipelineId)).find(node => node.name === 'QA')?.status).toBe('pending');
    expect(await planItemStatuses(pipelineId)).toEqual(['running', 'pending']);
  });
});

describe('an interrupted stage attempt survives a restart (#20)', () => {
  // Recovery review is tested separately; these exercise the walker after it was approved.
  let review: { mockRestore: () => void } | undefined;
  beforeEach(async () => {
    const { actionRecovery } = await import('@/core/action-recovery');
    review = vi.spyOn(actionRecovery, 'reviewPipeline').mockResolvedValue();
  });
  afterEach(() => review?.mockRestore());
  test('after boot reconciliation the same attempt resumes its CLI session, with its progress marked incomplete', async () => {
    replies = { QA: [QA_PASS] };
    partialPlan = { Implement: ['edited src/a.ts; tests not run yet'] };
    throwPlan = { Implement: ['CLI claude exited with signal SIGKILL: no failure diagnostic reported'] };
    const first = await run('interrupted attempt');
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const [checkpoint] = await pipelineRepository.getCheckpoints(first.pipelineId, 1);
    expect(checkpoint.state).toMatchObject({ partial: { text: 'edited src/a.ts; tests not run yet', attemptId: calls[1].metadata.attemptId } });
    // The process died mid-stage: rows still claim to be running until the boot sweep.
    await executeRaw(`UPDATE pipelines SET status = 'running' WHERE id = '${first.pipelineId}'`);
    await executeRaw(`UPDATE pipeline_nodes SET status = 'running' WHERE pipeline_id = '${first.pipelineId}' AND name = 'Implement'`);
    expect(await manager.reconcileInterrupted()).toBeGreaterThanOrEqual(1);
    expect((await pipelineRepository.findById(first.pipelineId))?.status).toBe('paused');

    // The vendor session the interrupted attempt saved, under its resume key.
    const { childCliSessionKey, loadCliSession, ownedResumeKey, saveCliSession } = await import('@/core/cli-session-store');
    const { sessionGeneration } = await import('@/db/schema/sessions');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const keyOf = (resumeKey: unknown) => childCliSessionKey('claude', ownedResumeKey(String(resumeKey)));
    const generation = sessionGeneration((await sessionRepository.findById(sessionId))?.context as never);
    await saveCliSession(sessionId, keyOf(calls[1].resumeKey), { id: 'vendor-conversation-1', fingerprint: 'fp', lastUsedAt: new Date().toISOString(), generation });

    const before = calls.length;
    await manager.resume(first.pipelineId);
    const [resumed, nextItem] = calls.slice(before).filter(call => call.stageName === 'Implement');
    expect(resumed.metadata.attemptId).toBe(calls[1].metadata.attemptId);
    expect((await loadCliSession(sessionId, keyOf(resumed.resumeKey), 'fp'))?.id).toBe('vendor-conversation-1');
    expect(resumed.input).toContain('INCOMPLETE');
    expect(resumed.input).toContain('edited src/a.ts; tests not run yet');
    // The next item is its own attempt: no other item's progress, no shared conversation.
    expect(nextItem.metadata.attemptId).not.toBe(resumed.metadata.attemptId);
    expect(nextItem.input).not.toContain('INCOMPLETE');
    expect((await pipelineRepository.findById(first.pipelineId))?.status).toBe('completed');
    // The resumed attempt finished: its checkpoint no longer holds progress.
    const resumedFrom = (await pipelineRepository.getCheckpoints(first.pipelineId, 100))
      .filter(c => c.seq > checkpoint.seq && (c.state as Record<string, unknown>).attemptId === resumed.metadata.attemptId);
    expect(resumedFrom).toHaveLength(1);
    expect(resumedFrom[0].state).not.toHaveProperty('partial');
  });

  test('a rewind with fromStage is a deliberate fresh attempt', async () => {
    replies = { QA: [QA_PASS] };
    throwPlan = { Implement: ['the database is unreachable'] };
    const { pipelineId } = await run('fresh rewind');
    const failed = calls[1];
    const { createPipelineRecoveryTools } = await import('./pipeline-tools');
    let completion: Promise<unknown> | undefined;
    const [, resumeTool] = createPipelineRecoveryTools((_id, done) => { completion = done; });
    const before = calls.length;
    await resumeTool.execute({ id: pipelineId, fromStage: 'Implement' }, { userId, sessionId, workspaceId: null } as unknown as AgentContext);
    await completion;
    expect(calls[before].metadata.attemptId).not.toBe(failed.metadata.attemptId);
  });
});

describe('resume_pipeline skipItems', () => {
  // Recovery review is tested separately; these exercise the walker after it was approved.
  let review: { mockRestore: () => void } | undefined;
  beforeEach(async () => {
    const { actionRecovery } = await import('@/core/action-recovery');
    review = vi.spyOn(actionRecovery, 'reviewPipeline').mockResolvedValue();
  });
  afterEach(() => review?.mockRestore());
  const tools = async () => {
    const { createPipelineRecoveryTools } = await import('./pipeline-tools');
    let completion: Promise<unknown> | undefined;
    const [, resumeTool] = createPipelineRecoveryTools((_id, done) => { completion = done; });
    return { resumeTool, done: () => completion };
  };
  const ctx = () => ({ userId, sessionId, workspaceId: null } as unknown as AgentContext);
  const itemIds = async (pipelineId: string) => {
    const { rows } = await queryRaw(`SELECT id FROM plan_items WHERE pipeline_id = '${pipelineId}' ORDER BY ordinal`);
    return rows.map(row => String(row.id));
  };

  test('skipping the failed current item advances past it and keeps the skip and its evidence', async () => {
    replies = { QA: [QA_PASS] };
    throwPlan = { Implement: ['the database is unreachable'] };
    const { pipelineId } = await run('skip the failed item');
    expect(await planItemStatuses(pipelineId)).toEqual(['failed', 'pending']);
    const [one] = await itemIds(pipelineId);
    const { resumeTool, done } = await tools();
    const before = calls.length;
    await resumeTool.execute({ id: pipelineId, skipItems: [one], evidence: 'abc123, npm test exit 0' }, ctx());
    await done();
    expect(calls.slice(before).map(call => call.stageName)).toEqual(['Implement', 'QA']);
    expect(calls[before].input).toContain('item two');
    expect(await planItemStatuses(pipelineId)).toEqual(['skipped', 'done']);
    const { rows } = await queryRaw(`SELECT result FROM plan_items WHERE id = '${one}'`);
    expect(rows[0].result).toContain('abc123, npm test exit 0');
  });

  test('a batch with one unknown id changes nothing', async () => {
    replies = { QA: [QA_PASS] };
    throwPlan = { Implement: ['the database is unreachable'] };
    const { pipelineId } = await run('mixed batch');
    const [, two] = await itemIds(pipelineId);
    const { resumeTool } = await tools();
    await expect(resumeTool.execute({ id: pipelineId, skipItems: [two, 'no-such-item'], evidence: 'abc123' }, ctx()))
      .rejects.toThrow("No plan item 'no-such-item' on this pipeline; nothing was skipped");
    expect(await planItemStatuses(pipelineId)).toEqual(['failed', 'pending']);
  });
});

test('a stage that reports it stopped re-runs itself for the same item, not the whole item (#16/#21)', async () => {
  replies = {
    Implement: ['Stopped: test/setup.ts does not exist.\n```handoff\n{"completedWork":"nothing","stopped":true}\n```', 'Implement ok'],
    QA: [QA_PASS],
  };
  const { pipelineId } = await run('recover from a stopped stage');
  expect(calls.map(call => call.stageName)).toEqual(['Plan', 'Implement', 'Implement', 'QA', 'Implement', 'QA']);
  expect(calls[2].input).toContain('stopped before finishing');
  expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
});

test('a failed stage reports its own reason, without an earlier item output (#7/#15)', async () => {
  replies = { QA: [QA_PASS] };
  throwPlan = { QA: [undefined, 'Worker "qa" failed: the database is unreachable'] };
  const { pipelineId, result } = await run('fail on the second item');
  expect(result).toContain('the database is unreachable');
  expect(result).not.toContain('Worker "qa" failed');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const qa = (await pipelineRepository.getNodes(pipelineId)).find(node => node.name === 'QA');
  expect(qa).toMatchObject({ status: 'failed', output: null });
  expect(await planItemStatuses(pipelineId)).toEqual(['done', 'failed']);
});

test('gate commands are the resolved verifyCommands, without one that waits on a stage output', async () => {
  const { pipelineGateCommands } = await import('./pipeline-manager');
  expect(pipelineGateCommands([
    { nodeKey: 'a', verifyCommand: '{{param.verifyCommand}}' }, { nodeKey: 'b' }, { nodeKey: 'qa', verifyCommand: 'npm test', hostServices: true },
    { nodeKey: 'c', verifyCommand: 'check {{previousOutput}}' },
  ], { 'param.verifyCommand': 'npm test', description: 'd' })).toEqual([
    { command: 'npm test', nodeKey: 'a', hostServices: false }, { command: 'npm test', nodeKey: 'qa', hostServices: true },
  ]);
});


test('finishes an item through QA before pausing at the token pool boundary (#41)', async () => {
  replies = { QA: [QA_PASS] };
  const { getConfig } = await import('@/config');
  const previous = getConfig().agent.pipelineTokenBudget;
  getConfig().agent.pipelineTokenBudget = 100;
  tokenCharges = { Implement: 60, QA: 60 };
  try {
    const { pipelineId } = await run('deliver both items');
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'pending']);
    expect(calls.filter(call => call.stageName === 'QA')).toHaveLength(1);
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const pipeline = await pipelineRepository.findById(pipelineId);
    expect(pipeline).toMatchObject({ status: 'paused', summary: expect.stringContaining('after finishing the current item') });
    expect(Object.values(pipeline?.metadata?.tokensByItem as Record<string, number>)).toEqual([120]);
  } finally { getConfig().agent.pipelineTokenBudget = previous; }
});

test('quota exhaustion parks an unverified item without marking the run or item failed (#38)', async () => {
  throwPlan = { QA: ["You've hit your usage limit. Try again at Oct 27th, 2026 9:20 AM"] };
  const { pipelineId } = await run('deliver both items', 'loop-fixture', { attended: false });
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  expect(await pipelineRepository.findById(pipelineId)).toMatchObject({ status: 'paused', metadata: {
    providerBlock: { nodeKey: expect.any(String), error: expect.stringContaining('usage limit') },
  } });
  expect(await planItemStatuses(pipelineId)).toEqual(['running', 'pending']);
});

test('one run-profile approval covers an entire item loop including its plan gate (#52)', async () => {
  replies = { QA: [QA_PASS] };
  const { rows } = await queryRaw("SELECT steps FROM pipeline_templates WHERE name = 'loop-fixture' LIMIT 1");
  const steps = (rows[0].steps as Array<Record<string, unknown>>).map(step => step.name === 'Implement'
    ? { ...step, requiresApproval: true, autoApproveUnattended: false } : step);
  await executeRaw(`INSERT INTO pipeline_templates (name, is_preset, steps) VALUES ('profile-fixture', true, '${JSON.stringify(steps)}'::jsonb)`);
  approvalAnswer = { approved: true, response: 'Approve' };
  const { WorkspaceFS } = await import('@/security/workspace-fs');
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const root = WorkspaceFS.forSession((await sessionRepository.findById(sessionId))!, { space: null }).root;
  const { pipelineId } = await manager.createAndRun('root', sessionId, userId, 'overnight', 'profile-fixture', 'deliver both items',
    { userId, sessionId, attended: true, role: 'general' } as AgentContext,
    { permissionProfile: { repoPath: root, packageManagers: ['pnpm'], publicHosts: ['go.dev'], overnight: true } });
  expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
  expect(approvalsAsked).toBe(1);
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  expect(await pipelineRepository.findById(pipelineId)).toMatchObject({ status: 'completed', metadata: {
    permissionProfile: { approvedBy: userId, profile: { overnight: true } },
  } });
});

test('overnight QA failure is reported without opening an unattended waiver approval (#52)', async () => {
  replies = { QA: [qaFail('the check did not pass')] };
  const { pipelineId } = await run('deliver both items', 'loop-fixture', { attended: false, metadata: { overnightRun: true, approvedRunGates: true } });
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  expect(await pipelineRepository.findById(pipelineId)).toMatchObject({ status: 'failed', summary: expect.stringContaining('did not request a waiver') });
  expect(approvalsAsked).toBe(0);
});

test('approval publication cannot revive a pipeline that was already stopped (#45)', async () => {
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 'stopped', type: 'development', status: 'stopped' });
  const pending: import('@/shared/pipeline-approval').PendingStageApproval = {
    kind: 'conversation', requestId: 'question', workerRequestId: null, stage: 'Plan', nodeKey: 'loop1', attemptId: '',
    fingerprint: null, hostServices: false, itemId: null, item: null, toolId: null, action: null, toolName: null, subject: 'Approve?', reason: 'Plan gate',
  };
  expect(await pipelineRepository.publishApproval(pipeline.id, pending, 'Waiting')).toBe(false);
  expect(await pipelineRepository.findById(pipeline.id)).toMatchObject({ status: 'stopped' });
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'running' });
  expect(await pipelineRepository.publishApproval(pipeline.id, pending, 'Waiting')).toBe(true);
  expect(await pipelineRepository.findById(pipeline.id)).toMatchObject({ status: 'awaiting_approval', metadata: { pendingApproval: pending } });
});


test.each(['Plan', 'QA'])('enforces the pool outside the item loop after %s exhausts it', async chargedStage => {
  replies = { QA: [QA_PASS] };
  const { rows } = await queryRaw("SELECT steps FROM pipeline_templates WHERE name = 'loop-fixture' LIMIT 1");
  const steps = [...rows[0].steps as Array<Record<string, unknown>>,
    { name: 'Summary', topic: 'writing', promptTemplate: 'summarize: {{previousOutput}}' }];
  const template = `budget-tail-${chargedStage}`;
  await executeRaw(`INSERT INTO pipeline_templates (name, is_preset, steps) VALUES ('${template}', true, '${JSON.stringify(steps)}'::jsonb)`);
  const { getConfig } = await import('@/config');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const previous = getConfig().agent.pipelineTokenBudget;
  getConfig().agent.pipelineTokenBudget = 100;
  tokenCharges = { [chargedStage]: 120 };
  // Keep only one plan item so QA is the final item's verification.
  onSpawn = async (stageName, pipelineId) => {
    if (stageName === 'Plan') await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 0, title: 'only item' }]);
  };
  try {
    const { pipelineId } = await run('deliver one item then summarize', template);
    expect(await pipelineRepository.findById(pipelineId)).toMatchObject({ status: 'paused' });
    expect(calls.some(call => call.stageName === 'Summary')).toBe(false);
    expect(await planItemStatuses(pipelineId)).toEqual([chargedStage === 'QA' ? 'done' : 'pending']);
    expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(chargedStage === 'QA' ? 1 : 0);
    getConfig().agent.pipelineTokenBudget = 500;
    // Replay consent is covered separately; exercise the budget checkpoint after consent.
    const { actionRecovery } = await import('@/core/action-recovery');
    const review = vi.spyOn(actionRecovery, 'reviewPipeline').mockResolvedValue();
    try { await manager.resume(pipelineId); } finally { review.mockRestore(); }
    expect(await pipelineRepository.findById(pipelineId)).toMatchObject({ status: 'completed' });
    expect(await planItemStatuses(pipelineId)).toEqual(['done']);
    expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(1);
    expect(calls.filter(call => call.stageName === 'Summary')).toHaveLength(1);
  } finally { getConfig().agent.pipelineTokenBudget = previous; }
});


test.each(['go: Kommando nicht gefunden', 'ECONNREFUSED ::1:5433', '/var/run/docker.sock: no such file or directory'])
('pauses on a required environment failure without consuming item retries: %s', async reason => {
  replies = { QA: [qaFail(reason)] };
  const { pipelineId } = await run('verify the project');
  expect(await planItemStatuses(pipelineId)).toEqual(['running', 'pending']);
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(1);
  expect(calls.filter(call => call.stageName === 'QA')).toHaveLength(2);
  expect(await manager.getPipeline(pipelineId)).toMatchObject({ status: 'paused', metadata: {
    environmentBlock: { reason: expect.stringContaining(reason), itemId: expect.any(String), attemptId: expect.any(String) },
  } });
  replies = { QA: [QA_PASS] };
  const { actionRecovery } = await import('@/core/action-recovery');
  const review = vi.spyOn(actionRecovery, 'reviewPipeline').mockResolvedValue();
  try { await manager.resume(pipelineId); } finally { review.mockRestore(); }
  expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
  expect((await manager.getPipeline(pipelineId))?.metadata?.environmentBlock).toBeUndefined();
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(2);
});

test('a stopped testing handoff with an environment blocker pauses before command evidence enforcement', async () => {
  replies = { QA: ['```handoff\n' + JSON.stringify({ stopped: true, environmentBlocked: 'Required gate: go test ./...; go: command not found' }) + '\n```'] };
  commandCounts = [0];
  const { pipelineId } = await run('verify the project');
  expect(await manager.getPipeline(pipelineId)).toMatchObject({ status: 'paused', summary: expect.stringContaining('Environment blocked') });
  expect(await planItemStatuses(pipelineId)).toEqual(['running', 'pending']);
});

test('host service declarations reach the actual stage worker metadata', async () => {
  const { rows } = await queryRaw("SELECT steps FROM pipeline_templates WHERE name = 'loop-fixture' LIMIT 1");
  const steps = (rows[0].steps as Array<Record<string, unknown>>).map(step => step.name === 'QA' ? { ...step, hostServices: true } : step);
  await executeRaw(`INSERT INTO pipeline_templates (name, is_preset, steps) VALUES ('host-fixture', true, '${JSON.stringify(steps)}'::jsonb)`);
  replies = { QA: [QA_PASS] };
  await run('verify with local services', 'host-fixture');
  expect(calls.filter(call => call.stageName === 'QA').every(call => call.metadata.hostServices === true)).toBe(true);
  expect(calls.filter(call => call.stageName === 'Implement').every(call => call.metadata.hostServices !== true)).toBe(true);
});


test.each([false, true])('framework gate environment checks preserve successful evidence (passed=%s)', async passed => {
  const { rows } = await queryRaw("SELECT steps FROM pipeline_templates WHERE name = 'loop-fixture' LIMIT 1");
  const steps = (rows[0].steps as Array<Record<string, unknown>>).map(step => step.name === 'QA'
    ? { ...step, verifyCommand: passed ? 'printf "go: command not found"' : 'go test ./...', hostServices: true } : step);
  await executeRaw(`INSERT INTO pipeline_templates (name, is_preset, steps) VALUES ('gate-env-${passed}', true, '${JSON.stringify(steps)}'::jsonb)`);
  const scorer = await import('@/core/swarm/scorers');
  const probe = vi.spyOn(scorer, 'runScorers').mockResolvedValue({ passed, ran: 1,
    failures: passed ? [] : [{ scorer: 'command_exit_zero', reason: 'Scorer environment: required Go toolchain unavailable', retryable: false }] });
  replies = { QA: [QA_PASS] };
  try {
    const { pipelineId } = await run('verify gate environment', `gate-env-${passed}`);
    expect(await manager.getPipeline(pipelineId)).toMatchObject({ status: passed ? 'completed' : 'paused' });
    expect(await planItemStatuses(pipelineId)).toEqual(['done', passed ? 'done' : 'running']);
    expect(calls.filter(call => call.stageName === 'QA')).toHaveLength(passed ? 2 : 1);
    expect(probe.mock.calls[0][2]).toMatchObject({ hostServices: true });
  } finally { probe.mockRestore(); }
});


async function stageFixture(name: string, changes: Record<string, unknown>) {
  const { rows } = await queryRaw("SELECT steps FROM pipeline_templates WHERE name = 'loop-fixture' LIMIT 1");
  const steps = (rows[0].steps as Array<Record<string, unknown>>).map(step => ({ ...step, ...(changes[String(step.name)] as object ?? {}) }));
  await executeRaw(`INSERT INTO pipeline_templates (name, is_preset, steps) VALUES ('${name}', true, '${JSON.stringify(steps)}'::jsonb)`);
}

test('read-only evidence writes preserve a completed verdict and pause for inspection (#56)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'read-only-evidence-'));
  writeFileSync(join(root, 'contract.md'), 'Existing contract');
  const workspace = vi.spyOn(manager as unknown as { resolveWorkspaceRoot: () => Promise<string> }, 'resolveWorkspaceRoot').mockResolvedValue(root);
  await stageFixture('read-only-evidence', { QA: { readOnly: true } });
  replies = { QA: [QA_PASS] };
  onSpawn = async stage => { if (stage === 'QA') writeFileSync(join(root, 'contract.md'), 'QA evidence; gates passed'); };
  try {
    const { pipelineId } = await run('verify without writing the contract', 'read-only-evidence');
    expect(await manager.getPipeline(pipelineId)).toMatchObject({ status: 'paused', metadata: {
      readOnlyViolation: { verdict: { passed: true }, report: expect.stringContaining('whatIDidNotCheck') },
    } });
    expect(await planItemStatuses(pipelineId)).toEqual(['running', 'pending']);
    expect(calls.filter(call => call.stageName === 'QA')).toHaveLength(1);
    expect(calls.find(call => call.stageName === 'QA')?.input).toContain('Do not edit product files, the contract/plan document');
  } finally { workspace.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('an ad-hoc probe mistake gets one corrective stage retry instead of a human pause (#57)', async () => {
  replies = { QA: ['```handoff\n' + JSON.stringify({ stopped: true, environmentBlocked: 'pnpm exec tsx probe failed; ERR_MODULE_NOT_FOUND zod from repo root' }) + '\n```', QA_PASS] };
  const { pipelineId } = await run('run the actual package gates');
  expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
  const qa = calls.filter(call => call.stageName === 'QA');
  expect(qa[1].input).toContain('correct workspace package cwd');
  expect(qa[0].metadata.attemptId).toBe(qa[1].metadata.attemptId);
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(2);
  expect(approvalsAsked).toBe(0);
});

test('coordinator-only visible-plan acceptance pauses before spending on implementation (#58)', async () => {
  onSpawn = async (stage, pipelineId) => {
    if (stage === 'Plan') {
      const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
      await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 0, title: 'Work requiring coordinator', acceptance: ['The visible plan step g1 must be working'] }]);
    }
  };
  const { pipelineId } = await run('verify coordinator-owned state separately');
  expect(await manager.getPipeline(pipelineId)).toMatchObject({ status: 'paused', metadata: {
    coordinatorRequest: { reason: expect.stringContaining('visible plan step g1') },
  } });
  expect(calls.some(call => call.stageName === 'Implement')).toBe(false);
  expect((await manager.getPipeline(pipelineId))?.metadata?.environmentBlock).toBeUndefined();
});

test('a blocked decision is asked before the zero-file contract and recorded before work resumes (#59)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-evidence-'));
  const workspace = vi.spyOn(manager as unknown as { resolveWorkspaceRoot: () => Promise<string> }, 'resolveWorkspaceRoot').mockResolvedValue(root);
  await stageFixture('decision-fixture', { Implement: { producesArtifacts: true } });
  approvalAnswer = { approved: true, response: 'Near ties are inconclusive; run the benchmark once.' };
  replies = { QA: [QA_PASS] };
  let decisionId = '';
  onSpawn = async (stage, pipelineId) => {
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    if (stage === 'Implement' && (await pipelineRepository.getPlanItems(pipelineId)).find(item => item.status === 'running')?.id === decisionId) writeFileSync(join(root, 'decision-evidence.txt'), 'Recorded decision applied and verified');
    if (stage === 'Plan') {
      const items = await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 0, title: 'Implement decided rule' }, { pipelineId, ordinal: 1, title: 'User decision on near-tie rule' }]);
      decisionId = items[1].id;
      replies.Implement = ['```handoff\n' + JSON.stringify({ stopped: true, openQuestions: ['Pending user decision ' + decisionId], blockedOnDecision: { itemId: decisionId, question: 'How should a single-round near tie count?' } }) + '\n```', 'No product changes needed; ran the required benchmark once under the recorded decision'];
    }

  };
  try {
    const { pipelineId } = await run('block honestly without fabricated edits', 'decision-fixture');
    expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
    expect(approvalsAsked).toBe(1);
    expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(3);
    expect(calls.filter(call => call.stageName === 'Implement')[1].input).toContain('RECORDED USER DECISION');
    expect(calls.filter(call => call.stageName === 'Implement')[2].input).toContain('Near ties are inconclusive; run the benchmark once.');
    expect(calls.filter(call => call.stageName === 'Implement')[2].input).not.toContain('Verification-only work is valid');
    expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done']);
    expect(await manager.getPipeline(pipelineId)).toMatchObject({ metadata: { userDecisions: [expect.objectContaining({ itemId: decisionId, decidedBy: userId })] } });
  } finally { workspace.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('a prioritized prerequisite runs before the interrupted QA without replaying its implementation (#56)', async () => {
  replies = { QA: [QA_PASS] };
  let inserted = false;
  onSpawn = async (stage, pipelineId) => {
    if (stage !== 'Implement' || inserted) return;
    inserted = true;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const items = await pipelineRepository.getPlanItems(pipelineId);
    const current = items.find(item => item.status === 'running')!;
    const [prerequisite] = await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 100, title: 'Priority prerequisite' }], current.id);
    expect(prerequisite.ordinal).toBe(0);
  };
  const { pipelineId } = await run('finish prerequisites before accepting phase one');
  expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
  expect(calls.map(call => call.stageName)).toEqual(['Plan', 'Implement', 'Implement', 'QA', 'QA', 'Implement', 'QA']);
  expect(calls.filter(call => call.stageName === 'Implement')[1].input).toContain('Priority prerequisite');
  expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done', 'done']);
});

test('queued edits apply before the next stage even if the current item has not reached its boundary (#56)', async () => {
  replies = { QA: [QA_PASS] };
  let queued = false, seen = false;
  onSpawn = async (stage, pipelineId) => {
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const items = await pipelineRepository.getPlanItems(pipelineId);
    if (stage === 'Implement' && !queued) {
      queued = true;
      await pipelineRepository.queueItemEdit(pipelineId, { skip: [items[1].id], add: [], evidence: 'Root skipped the later item' });
    }
    if (stage === 'QA') seen = items[1].status === 'skipped';
  };
  const { pipelineId } = await run('apply pending root changes promptly');
  expect(seen).toBe(true);
  expect(await planItemStatuses(pipelineId)).toEqual(['done', 'skipped']);
});


test('declining a pending decision preserves the unfinished item without artifact-contract retries (#59)', async () => {
  replies = { Implement: ['waiting'] };
  onSpawn = async (stage, pipelineId) => {
    if (stage !== 'Plan') return;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const items = await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 0, title: 'Blocked implementation' }, { pipelineId, ordinal: 1, title: 'User decision' }]);
    replies.Implement = ['```handoff\n' + JSON.stringify({ stopped: true,
      openQuestions: ['Work item ' + items[0].id.slice(0, 8) + ' is blocked on pending user decision ' + items[1].id.slice(0, 8)] }) + '\n```'];
  };
  const { pipelineId } = await run('wait for the real user decision');
  expect((await manager.getPipeline(pipelineId))?.status).toBe('paused');
  expect((await manager.getPipeline(pipelineId))?.metadata?.pendingDecision).toBeDefined();
  expect(await planItemStatuses(pipelineId)).toEqual(['running', 'pending']);
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(1);
  expect(approvalsAsked).toBe(1);
});

test('queued priority additions keep their before placement when an explicit order is also supplied (#56)', async () => {
  replies = { QA: [QA_PASS] };
  let queued = false;
  onSpawn = async (stage, pipelineId) => {
    if (stage !== 'Implement' || queued) return;
    queued = true;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const items = await pipelineRepository.getPlanItems(pipelineId);
    await pipelineRepository.queueItemEdit(pipelineId, { skip: [], add: [{ title: 'Queued prerequisite', beforeItemId: items[0].id }],
      order: items.map(item => item.id), evidence: 'Prerequisite must run before Phase 1 verification' });
  };
  const { pipelineId } = await run('ordered queued prerequisites');
  expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
  expect(calls.map(call => call.stageName)).toEqual(['Plan', 'Implement', 'Implement', 'QA', 'QA', 'Implement', 'QA']);
});


test('a deferred item keeps its own QA ledger instead of inheriting its prerequisite verdicts', async () => {
  replies = { QA: [qaFail('requires a prerequisite fix'), QA_PASS] };
  let originalItem = '', added = false;
  onSpawn = async (stage, pipelineId) => {
    if (stage !== 'QA' || added) return;
    added = true;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const items = await pipelineRepository.getPlanItems(pipelineId);
    originalItem = items.find(item => item.status === 'running')!.id;
    await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 100, title: 'Required prerequisite fix' }], originalItem);
  };
  const { pipelineId } = await run('preserve the per-item verdict ledger');
  expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const checkpoints = await pipelineRepository.getCheckpoints(pipelineId, 50);
  const state = checkpoints.find(checkpoint => checkpoint.state.currentItemId === originalItem)!;
  const ledgers = Object.values(state.state.qaAttempts as Record<string, Array<{ passed: boolean }>>);
  expect(ledgers.flat().map(attempt => attempt.passed)).toEqual([false, true]);
});


test('a refused agent capability is coordinator work, never a host environment pause (#58)', async () => {
  replies = { QA: ['```handoff\n' + JSON.stringify({ stopped: true, environmentBlocked: 'Agent bridge rejected request (400): Tool is not available to this agent' }) + '\n```'] };
  const { pipelineId } = await run('do not misclassify a refused coordinator capability');
  const pipeline = await manager.getPipeline(pipelineId);
  expect(pipeline).toMatchObject({ status: 'paused', metadata: { coordinatorRequest: { reason: expect.stringContaining('Tool is not available') } } });
  expect(pipeline?.metadata?.environmentBlock).toBeUndefined();
  expect(calls.filter(call => call.stageName === 'QA')).toHaveLength(1);
});


test.each(['skipped', 'done'] as const)('settling a blocked item as %s clears its environment block atomically (#61)', async status => {
  replies = { QA: [qaFail('go: command not found')] };
  const { pipelineId } = await run('clear settled item diagnostics');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const before = await pipelineRepository.findById(pipelineId);
  const block = before!.metadata!.environmentBlock as { itemId: string };
  await pipelineRepository.updatePlanItem(block.itemId, { status });
  expect((await pipelineRepository.findById(pipelineId))?.metadata?.environmentBlock).toBeUndefined();
  // An in-flight stale metadata snapshot must not resurrect a settled item's block.
  await pipelineRepository.updatePipeline(pipelineId, { metadata: before!.metadata });
  expect((await pipelineRepository.findById(pipelineId))?.metadata?.environmentBlock).toBeUndefined();
});

test('a deferred item retains its retry budget after prerequisite QA retries', async () => {
  replies = { QA: [qaFail('prerequisite first failure'), qaFail('prerequisite second failure'), QA_PASS, qaFail('original needs one correction'), QA_PASS] };
  let inserted = false;
  onSpawn = async (stage, pipelineId) => {
    if (stage !== 'Implement' || inserted) return;
    inserted = true;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const current = (await pipelineRepository.getPlanItems(pipelineId)).find(item => item.status === 'running')!;
    await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 100, title: 'Required prerequisite' }], current.id);
  };
  const { pipelineId } = await run('preserve independent per-item retries');
  expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
  expect(await planItemStatuses(pipelineId)).toEqual(['done', 'done', 'done']);
  expect(approvalsAsked).toBe(0);
});

test('an answered decision survives interruption and reaches the resumed stage and subsequent QA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-resume-'));
  const workspace = vi.spyOn(manager as unknown as { resolveWorkspaceRoot: () => Promise<string> }, 'resolveWorkspaceRoot').mockResolvedValue(root);
  await stageFixture('decision-resume-fixture', { Implement: { producesArtifacts: true } });
  const response = 'Near ties are inconclusive; run the benchmark once under this rule.';
  approvalAnswer = { approved: true, response };
  replies = { QA: [QA_PASS] };
  throwPlan = { Implement: [undefined, 'CLI claude exited with signal SIGKILL: no failure diagnostic reported'] };
  onSpawn = async (stage, pipelineId) => {
    if (stage === 'Implement') {
      const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
      if ((await pipelineRepository.getPlanItems(pipelineId)).find(item => item.status === 'running')?.title === 'User decision on near-tie rule') writeFileSync(join(root, 'decision-evidence.txt'), 'Decision evidence verified');
    }
    if (stage !== 'Plan') return;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const items = await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 0, title: 'Implement decided rule' }, { pipelineId, ordinal: 1, title: 'User decision on near-tie rule' }]);
    replies.Implement = ['```handoff\n' + JSON.stringify({ stopped: true, blockedOnDecision: { itemId: items[1].id, question: 'How should a near tie count?' } }) + '\n```', 'Ran the required benchmark once; no product edits were needed.'];
  };
  const { actionRecovery } = await import('@/core/action-recovery');
  const review = vi.spyOn(actionRecovery, 'reviewPipeline').mockResolvedValue();
  try {
    const { pipelineId } = await run('recover a recorded user rule', 'decision-resume-fixture');
    // A process crash leaves running rows for the boot sweep, rather than a caught CLI failure.
    await executeRaw(`UPDATE pipelines SET status = 'running' WHERE id = '${pipelineId}'`);
    await executeRaw(`UPDATE pipeline_nodes SET status = 'running' WHERE pipeline_id = '${pipelineId}' AND name = 'Implement'`);
    await manager.reconcileInterrupted();
    expect((await manager.getPipeline(pipelineId))?.status).toBe('paused');
    const interrupted = calls.filter(call => call.stageName === 'Implement')[1];
    throwPlan = {};
    await manager.resume(pipelineId);
    const resumed = calls.filter(call => call.stageName === 'Implement')[2];
    expect(resumed.metadata.attemptId).toBe(interrupted.metadata.attemptId);
    expect(resumed.input).toContain(response);
    expect(calls.find(call => call.stageName === 'QA')?.input).toContain(response);
    expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
    expect(approvalsAsked).toBe(1);
  } finally { review.mockRestore(); workspace.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('settling a user decision rolls back both records on failure and preserves a concurrent pause', async () => {
  throwPlan = { Implement: ['CLI claude exited with signal SIGKILL: no failure diagnostic reported'] };
  const { pipelineId } = await run('persist decisions atomically');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const [checkpoint] = await pipelineRepository.getCheckpoints(pipelineId, 1);
  const [item] = await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 100, title: 'User decision' }]);
  const { hydrateWalk } = await import('./pipeline-manager');
  const state = hydrateWalk(checkpoint.state)!;
  const decision = { itemId: item.id, blockedItemId: state.currentItemId, nodeKey: checkpoint.nodeKey,
    attemptId: state.attemptId!, question: 'How should a near tie count?', response: 'Inconclusive', decidedBy: userId, decidedAt: new Date().toISOString() };
  const pipeline = await manager.getPipeline(pipelineId);
  const pendingItemEdits = [{ skip: [], add: [{ title: 'Queued follow-up' }], evidence: 'Preserve concurrent edits' }];
  await pipelineRepository.updatePipeline(pipelineId, { status: 'running', metadata: { ...pipeline?.metadata, pendingDecision: decision } });
  await pipelineRepository.queueItemEdit(pipelineId, pendingItemEdits[0]);
  const sync = vi.spyOn(pipelineRepository as unknown as { syncWorkPlan: (...args: unknown[]) => Promise<void> }, 'syncWorkPlan').mockRejectedValueOnce(new Error('Injected plan projection failure'));
  try { await expect(pipelineRepository.settleUserDecision(pipelineId, decision)).rejects.toThrow('Injected plan projection failure'); }
  finally { sync.mockRestore(); }
  expect((await pipelineRepository.getPlanItems(pipelineId)).find(row => row.id === item.id)).toMatchObject({ status: 'pending', result: null });
  expect(await manager.getPipeline(pipelineId)).toMatchObject({ metadata: { pendingDecision: decision, pendingItemEdits } });
  expect((await manager.getPipeline(pipelineId))?.metadata?.userDecisions).toBeUndefined();
  await pipelineRepository.updatePipeline(pipelineId, { status: 'paused' });
  expect(await pipelineRepository.settleUserDecision(pipelineId, decision)).toBe(false);
  expect((await manager.getPipeline(pipelineId))?.status).toBe('paused');
  await pipelineRepository.updatePipeline(pipelineId, { status: 'running' });
  expect(await pipelineRepository.settleUserDecision(pipelineId, decision)).toBe(true);
  expect((await pipelineRepository.getPlanItems(pipelineId)).find(row => row.id === item.id)).toMatchObject({ status: 'pending', result: null });
  expect(await manager.getPipeline(pipelineId)).toMatchObject({ metadata: { userDecisions: [decision], pendingItemEdits } });
  expect((await manager.getPipeline(pipelineId))?.metadata?.pendingDecision).toBeUndefined();
});

test('an item can request its own user approval through handoff without calling unavailable tools (#66)', async () => {
  await stageFixture('self-approval-fixture', { Implement: { producesArtifacts: true } });
  approvalAnswer = { approved: true, response: 'Approve the tested cutover' };
  replies = { QA: [QA_PASS] };
  onSpawn = async (stage, pipelineId) => {
    if (stage !== 'Plan') return;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const [item] = await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 0, title: 'Tested cutover approval' }]);
    replies.Implement = ['```handoff\n' + JSON.stringify({ stopped: true, blockedOnDecision: { itemId: item.id, question: 'Approve the tested cutover?', options: ['Approve the tested cutover', 'Pause'] } }) + '\n```', 'Applied the approved cutover and verified the gates'];
  };
  const { pipelineId } = await run('approve a tested change', 'self-approval-fixture');
  expect((await manager.getPipeline(pipelineId))?.status).toBe('completed');
  expect(approvalsAsked).toBe(1);
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(2);
  expect(calls.filter(call => call.stageName === 'QA')).toHaveLength(1);
});

test('a future-date handoff parks once before the file-change contract and can be waived in place (#69/#68)', async () => {
  await stageFixture('date-deferral-fixture', { Implement: { producesArtifacts: true } });
  replies = { Implement: ['```handoff\n' + JSON.stringify({ stopped: true, deferredUntil: '2099-11-10T11:40:18Z', deferredReason: 'Retention window has not elapsed' }) + '\n```'] };
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { pipelineId } = await run('wait for eligibility', 'date-deferral-fixture');
  expect(await manager.getPipeline(pipelineId)).toMatchObject({ status: 'paused', metadata: { resumeAfter: '2099-11-10T11:40:18.000Z' } });
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(1);
  expect(calls.filter(call => call.stageName === 'QA')).toHaveLength(0);
  await expect(manager.resume(pipelineId)).rejects.toThrow('deferred until');
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(1);
  const [item] = await pipelineRepository.getPlanItems(pipelineId);
  expect(item.status).toBe('running');
  expect((await pipelineRepository.dueDeferred(new Date('2099-11-09T00:00:00Z'))).some(row => row.id === pipelineId)).toBe(false);
  expect((await pipelineRepository.dueDeferred(new Date('2099-11-11T00:00:00Z'))).some(row => row.id === pipelineId)).toBe(true);
  await pipelineRepository.queueItemEdit(pipelineId, { skip: [], add: [], update: [{ id: item.id, detail: 'User waived the date for test data', acceptance: ['Required gates pass'] }], evidence: 'Explicit user waiver' });
  await pipelineRepository.applyItemEdits(pipelineId);
  expect((await manager.getPipeline(pipelineId))?.metadata?.resumeAfter).toBeUndefined();
  expect((await pipelineRepository.getPlanItems(pipelineId))[0]).toMatchObject({ id: item.id, detail: 'User waived the date for test data', acceptance: ['Required gates pass'] });
});

test('a failed run accepts audited scope edits and reopens its original item id (#63/#68)', async () => {
  const { pipelineId } = await run('recover incorrectly completed item');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const [item] = await pipelineRepository.getPlanItems(pipelineId);
  await pipelineRepository.updatePlanItem(item.id, { status: 'done', result: 'Old evidence remains available', completedAt: new Date() });
  await pipelineRepository.updatePipeline(pipelineId, { status: 'failed', summary: 'Stale acceptance constraint' });
  await pipelineRepository.queueItemEdit(pipelineId, { skip: [], add: [], reopen: [item.id], update: [{ id: item.id, title: 'Corrected scope', acceptance: ['Approved acceptance'] }], evidence: 'User corrected a stale constraint' });
  await pipelineRepository.applyItemEdits(pipelineId);
  expect((await pipelineRepository.getPlanItems(pipelineId))[0]).toMatchObject({ id: item.id, status: 'pending', title: 'Corrected scope', acceptance: ['Approved acceptance'], result: 'Old evidence remains available', completedAt: null });
  expect((await pipelineRepository.findById(pipelineId))?.metadata?.itemEditHistory).toEqual(expect.arrayContaining([expect.objectContaining({ evidence: 'User corrected a stale constraint' })]));
  await expect(pipelineRepository.queueItemEdit(pipelineId, { skip: [], add: [], reopen: ['not-in-pipeline'], evidence: 'Invalid edit' })).rejects.toThrow('Unknown pipeline item');
});

test('uncertain execution parks for named recovery before a zero-artifact contract can fail (#64)', async () => {
  await stageFixture('uncertain-command-fixture', { Implement: { producesArtifacts: true } });
  uncertainByStage = { Implement: ['shell-record-1'] };
  const { pipelineId } = await run('report the command that actually ran', 'uncertain-command-fixture');
  const pipeline = await manager.getPipeline(pipelineId);
  expect(pipeline).toMatchObject({ status: 'paused', metadata: { coordinatorRequest: { reason: expect.stringContaining('shell-record-1'), action: expect.stringContaining('resolve_tool_action') } } });
  expect(pipeline?.summary).not.toContain('changed 0 files');
  expect(pipeline?.summary).not.toContain('ran 0 commands');
  expect(calls.filter(call => call.stageName === 'Implement')).toHaveLength(1);
  expect(calls.some(call => call.stageName === 'QA')).toBe(false);
});
