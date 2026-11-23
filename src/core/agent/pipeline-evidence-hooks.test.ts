/**
 * Project evidence hooks, driven through the real walker.
 *
 * Real embedded database, real permission check and real shell: the hooks are
 * actual commands (`ls built.txt`) run in the session's workspace through the
 * `command_exit_zero` gate. The one stubbed boundary is `spawnWorker`, the call
 * that would reach a model; the stub plays the implementer by writing files
 * into the workspace, so whether a hook passes depends on what the "work" left
 * on disk, exactly as it would in a real run.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '77777777-7777-4777-8777-777777777777';

interface WorkerCall { stageName: string; input: string }

let manager: import('./pipeline-manager').PipelineManager;
let queryRaw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
let refreshConfigKey: (key: string, value: unknown) => void;
let sessionId = '';
let root = '';
let calls: WorkerCall[];
/** Stage name → replies in order; the last one repeats. */
let replies: Record<string, string[]>;
/** What the stubbed implementer writes into the workspace on each visit (by visit index). */
let implementWrites: Array<string[]>;
let approvalsAsked = 0;

/** A passing verdict that survives the audit-coverage gate (see pipeline-loop.test.ts). */
const QA_PASS = [
  '```json',
  '{"passed": true, "issues": [], "feedback": "Implement: checked the change end to end.",',
  ' "whatIDidNotCheck": ["performance"], "confidence": "high"}',
  '```',
].join('\n');

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-evidence-hooks-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'octipus-evidence-hooks-files-'));
  const config = await import('@/config');
  config.getConfig();
  refreshConfigKey = config.refreshConfigKey;
  refreshConfigKey('workspace.rootPath', dataRoot);

  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'evidence-user' }]);
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  await getOrgWorkspaceManager().ensureDefaultWorkspace(userId);
  sessionId = (await seedSession({ userId, channelId: 'evidence-1' })).id;
  const { getPermissionManager } = await import('@/security/permissions');
  await getPermissionManager().setPermission(userId, 'shell', 'execute', 'ALLOW');

  // Where the stage's commands run, resolved the way the hooks resolve it.
  const { stageCommandScope } = await import('./evidence-hooks');
  root = (await stageCommandScope({ userId, sessionId, role: 'coding' })).root ?? '';
  expect(root).toBeTruthy();
  mkdirSync(root, { recursive: true });

  const steps = [
    { name: 'Implement', topic: 'coding', producesArtifacts: true, promptTemplate: 'implement: {{description}}' },
    { name: 'QA', topic: 'qa', stageType: 'qa_validation', maxRetries: 2, promptTemplate: 'qa: {{description}}' },
  ];
  await pg.executeRaw(`INSERT INTO pipeline_templates (user_id, name, is_preset, steps)
    VALUES (NULL, 'evidence-fixture', true, '${JSON.stringify(steps)}'::jsonb)`);
  await pg.executeRaw(`INSERT INTO pipeline_templates (user_id, name, is_preset, steps)
    VALUES (NULL, 'evidence-no-auditor', true, '${JSON.stringify([steps[0]])}'::jsonb)`);

  const { PipelineManager } = await import('./pipeline-manager');
  manager = new PipelineManager();
  const { getAgentService } = await import('./index');
  const service = getAgentService();
  vi.spyOn(service, 'requestApproval').mockImplementation(async () => {
    approvalsAsked++;
    return { approved: false, response: 'Abort Pipeline' };
  });
  vi.spyOn(service, 'spawnWorker').mockImplementation((async (
    _role: string,
    input: string,
    _ctx: unknown,
    context: AgentContext & { stageName?: string },
    options?: { onCounters?: (counters: import('@/core/swarm/receipt').SideEffectCounters) => void },
  ) => {
    const stageName = context?.stageName ?? '';
    calls.push({ stageName, input });
    if (stageName === 'Implement') {
      const visit = calls.filter((c) => c.stageName === 'Implement').length - 1;
      for (const file of implementWrites[Math.min(visit, implementWrites.length - 1)] ?? []) writeFileSync(join(root, file), 'x');
    }
    options?.onCounters?.({ filesChanged: stageName === 'Implement' ? 1 : 0, commandsRun: 1, toolCalls: 1, toolErrors: 0,
      approvalsRequired: 0, approvalsDenied: 0, autoApproved: 0, permissionDenials: 0, byName: {} });
    const scripted = replies[stageName];
    if (!scripted?.length) return `${stageName} ok`;
    return scripted.length > 1 ? (scripted.shift() as string) : scripted[0];
  }) as never);
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  const pg = await import('@/db/postgres');
  await pg.closeDb?.();
});

beforeEach(() => {
  calls = [];
  replies = { QA: [QA_PASS] };
  implementWrites = [['built.txt']];
  approvalsAsked = 0;
  for (const file of ['built.txt', 'draft.txt']) if (existsSync(join(root, file))) rmSync(join(root, file));
  refreshConfigKey('agent.evidenceHooks', []);
});

function hooks(...list: Array<{ name: string; command: string; timeoutMs?: number }>) {
  refreshConfigKey('agent.evidenceHooks', list.map((hook) => ({ root, ...hook })));
}

function run(template = 'evidence-fixture') {
  return manager.createAndRun('orch-evidence', sessionId, userId, 'evidence test', template, 'build the thing',
    { userId, sessionId, agentId: 'orch-evidence' } as unknown as AgentContext);
}

async function pipelineRow(id: string) {
  const { rows } = await queryRaw(`SELECT status, summary, completed_at FROM pipelines WHERE id = '${id}'`);
  return rows[0];
}

async function evidenceRows(id: string) {
  const { rows } = await queryRaw(`SELECT kind, stage, passed, detail FROM verification_evidence
    WHERE pipeline_id = '${id}' AND kind = 'pre_verify' ORDER BY created_at`);
  return rows.map((r) => ({
    stage: r.stage as string,
    passed: r.passed as boolean,
    detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
  }));
}

const stageCalls = (name: string) => calls.filter((c) => c.stageName === name);

describe('no hooks declared', () => {
  test('the run behaves exactly as before: no evidence step, no rows, no change to the auditor input', async () => {
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(await evidenceRows(pipelineId)).toEqual([]);
    expect(stageCalls('Implement')).toHaveLength(1);
    expect(stageCalls('QA')[0].input).not.toContain('EVIDENCE HOOKS');
  });

  test('hooks for a different project folder do not apply here', async () => {
    refreshConfigKey('agent.evidenceHooks', [{ name: 'test', command: 'ls never.txt', root: join(tmpdir(), `elsewhere-${rand(4)}`) }]);
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(await evidenceRows(pipelineId)).toEqual([]);
  });
});

describe('passing evidence', () => {
  test('is recorded beside the QA verdict and handed to the auditor as ground truth', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    const { pipelineId } = await run();

    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    const rows = await evidenceRows(pipelineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: 'QA', passed: true });
    // The command recorded is the configured one, verbatim.
    expect(rows[0].detail).toMatchObject({ hook: 'test', command: 'ls built.txt', exitCode: 0, timedOut: false });
    expect(typeof rows[0].detail.durationMs).toBe('number');
    expect(String(rows[0].detail.outputExcerpt)).toContain('built.txt');
    // Same scope as the auditor's own rows.
    const { rows: verdicts } = await queryRaw(`SELECT detail->>'checkScope' AS scope FROM verification_evidence
      WHERE pipeline_id = '${pipelineId}' AND kind = 'qa_verdict'`);
    expect(rows[0].detail.checkScope).toBe(verdicts[0].scope);

    expect(stageCalls('QA')[0].input).toContain('EVIDENCE HOOKS');
    expect(stageCalls('QA')[0].input).toContain('`ls built.txt` — exit 0');
  });
});

describe('failing evidence', () => {
  test('goes back to the working stage with the output, and a repaired run passes', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    implementWrites = [['draft.txt'], ['built.txt']];
    const { pipelineId } = await run();

    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(stageCalls('Implement')).toHaveLength(2);
    // The auditor was not asked about the failing attempt.
    expect(stageCalls('QA')).toHaveLength(1);
    const retry = stageCalls('Implement')[1].input;
    expect(retry).toContain('Evidence hook "test" (`ls built.txt`) failed');
    expect(retry).toContain('built.txt');
    expect(retry).toContain('you cannot change or skip them');

    const rows = await evidenceRows(pipelineId);
    expect(rows.map((r) => r.passed)).toEqual([false, true]);
    expect(rows[0].detail.exitCode).not.toBe(0);
    expect(rows[0].detail.evidenceRepair).toBe(0);
    expect(rows[1].detail.evidenceRepair).toBe(1);
  });

  test('still failing after the repair limit ends the run failed with the evidence attached', async () => {
    const { EVIDENCE_REPAIR_LIMIT } = await import('./evidence-hooks');
    hooks({ name: 'test', command: 'ls never.txt' });
    const { pipelineId } = await run();

    const row = await pipelineRow(pipelineId);
    expect(row.status).toBe('failed');
    expect(row.completed_at).toBeNull();
    expect(String(row.summary)).toContain('evidence hooks');
    expect(String(row.summary)).toContain('FAIL test (`ls never.txt`)');
    // The first attempt plus every repair, and no more.
    expect(stageCalls('Implement')).toHaveLength(1 + EVIDENCE_REPAIR_LIMIT);
    const rows = await evidenceRows(pipelineId);
    expect(rows).toHaveLength(1 + EVIDENCE_REPAIR_LIMIT);
    expect(rows.every((r) => r.passed === false)).toBe(true);
    // Never handed to a human to wave through.
    expect(approvalsAsked).toBe(0);
  });

  test('a QA pass cannot override it', async () => {
    hooks({ name: 'test', command: 'ls never.txt' });
    replies = { QA: [QA_PASS] };
    const { pipelineId } = await run();

    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    // The auditor that would have passed it was never asked, so no passing
    // verdict exists to outweigh the evidence.
    expect(stageCalls('QA')).toHaveLength(0);
    const { rows } = await queryRaw(`SELECT passed FROM verification_evidence WHERE pipeline_id = '${pipelineId}' AND kind = 'qa_verdict'`);
    expect(rows).toEqual([]);
    const { rows: nodes } = await queryRaw(`SELECT status, error FROM pipeline_nodes WHERE pipeline_id = '${pipelineId}' AND name = 'QA'`);
    expect(nodes[0].status).toBe('failed');
    expect(String(nodes[0].error)).toContain('ls never.txt');
  });

  test('a run with no auditor checks its evidence before it completes', async () => {
    hooks({ name: 'test', command: 'ls never.txt' });
    const { pipelineId } = await run('evidence-no-auditor');
    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([false]);

    hooks({ name: 'test', command: 'ls built.txt' });
    const second = await run('evidence-no-auditor');
    expect((await pipelineRow(second.pipelineId)).status).toBe('completed');
    expect((await evidenceRows(second.pipelineId)).map((r) => r.passed)).toEqual([true]);
  });
});

describe('a hook that cannot run', () => {
  test('pauses the run for the operator instead of passing it or spending a repair', async () => {
    hooks({ name: 'test', command: 'ls built.txt && rm -rf /' });
    const { pipelineId } = await run();

    const row = await pipelineRow(pipelineId);
    expect(row.status).toBe('paused');
    expect(String(row.summary)).toContain('Environment blocked');
    expect(String(row.summary)).toContain('misconfigured');
    expect(stageCalls('Implement')).toHaveLength(1);
    expect(stageCalls('QA')).toHaveLength(0);
    expect((await evidenceRows(pipelineId))[0].detail).toMatchObject({ refused: true, exitCode: null });
  });
});

describe('runEvidenceHooks', () => {
  test('a hook that outruns its timeout is a failed check, not a hung run', async () => {
    const { runEvidenceHooks } = await import('./evidence-hooks');
    const started = Date.now();
    const [result] = await runEvidenceHooks(
      { userId, sessionId, role: 'coding' },
      { hooks: [{ name: 'slow', command: 'sleep 20', root, timeoutMs: 1_000 }] },
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result).toMatchObject({ name: 'slow', passed: false, timedOut: true });
    expect(result.refused).toBeUndefined();
  });
});
