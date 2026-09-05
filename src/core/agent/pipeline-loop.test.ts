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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
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
    return { approved: false, response: 'Abort Pipeline' };
  });

  vi.spyOn(service, 'spawnWorker').mockImplementation((async (
    role: string,
    input: string,
    _ctx: unknown,
    context: AgentContext & { stageName?: string },
  ) => {
    const stageName = context?.stageName ?? '';
    calls.push({ role, stageName, input });

    if (stageName === 'Plan') {
      const pipelineId = (context.metadata as { pipelineId?: string })?.pipelineId;
      const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
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
  replies = {};
  approvalsAsked = 0;
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

function run(description: string) {
  return manager.createAndRun(
    'orch-loop',
    sessionId,
    userId,
    'loop test',
    'loop-fixture',
    description,
    { userId, sessionId, agentId: 'orch-loop' } as unknown as AgentContext,
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
