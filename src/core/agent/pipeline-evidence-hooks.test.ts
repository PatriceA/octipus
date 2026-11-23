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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
let approvalReply: { approved: boolean; response: string } = { approved: false, response: 'Abort Pipeline' };
/** Commands the stubbed QA worker reports having run. */
let qaCommands = 1;
/** Extra per-stage side effects, run before the stage replies. */
let onStage: Record<string, () => void> = {};

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
    { name: 'QA', topic: 'qa', stageType: 'qa_validation', readOnly: true, maxRetries: 2, promptTemplate: 'qa: {{description}}' },
  ];
  await pg.executeRaw(`INSERT INTO pipeline_templates (user_id, name, is_preset, steps)
    VALUES (NULL, 'evidence-fixture', true, '${JSON.stringify(steps)}'::jsonb)`);
  const template = async (name: string, list: unknown[]) => pg.executeRaw(`INSERT INTO pipeline_templates (user_id, name, is_preset, steps)
    VALUES (NULL, '${name}', true, '${JSON.stringify(list)}'::jsonb)`);
  await template('evidence-no-auditor', [steps[0]]);
  // Both shipped auditors declare `runsCommands`.
  await template('evidence-qa-runs', [steps[0], { ...steps[1], runsCommands: true }]);
  await template('evidence-qa-approve', [steps[0], { ...steps[1], requiresApproval: true }]);
  await template('evidence-after-auditor', [...steps, { name: 'Polish', topic: 'coding', producesArtifacts: true, promptTemplate: 'polish' }]);
  await template('evidence-qa-writer', [steps[0], { ...steps[1], readOnly: false }]);
  await template('evidence-research', [{ name: 'Research', topic: 'research', promptTemplate: 'research: {{description}}' }]);
  await template('evidence-loop', [
    { name: 'Plan', topic: 'architecture', producesPlan: true, promptTemplate: 'plan: {{description}}' },
    { name: 'Implement', topic: 'coding', loopOverPlan: true, producesArtifacts: true, promptTemplate: 'implement: {{description}}' },
    { name: 'QA', topic: 'qa', loopOverPlan: true, stageType: 'qa_validation', readOnly: true, maxRetries: 2, promptTemplate: 'qa: {{description}}' },
  ]);

  const { PipelineManager } = await import('./pipeline-manager');
  manager = new PipelineManager();
  const { getAgentService } = await import('./index');
  const service = getAgentService();
  vi.spyOn(service, 'requestApproval').mockImplementation(async () => {
    approvalsAsked++;
    return approvalReply;
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
    onStage[stageName]?.();
    if (stageName === 'Plan') {
      const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
      const pipelineId = String(context.metadata?.pipelineId);
      if (!(await pipelineRepository.getPlanItems(pipelineId)).length) {
        await pipelineRepository.addPlanItems([{ pipelineId, ordinal: 0, title: 'item one' }, { pipelineId, ordinal: 1, title: 'item two' }]);
      }
      return 'planned';
    }
    if (stageName === 'Implement') {
      const visit = calls.filter((c) => c.stageName === 'Implement').length - 1;
      for (const file of implementWrites[Math.min(visit, implementWrites.length - 1)] ?? []) writeFileSync(join(root, file), 'x');
    }
    options?.onCounters?.({ filesChanged: stageName === 'Implement' || stageName === 'Polish' ? 1 : 0, commandsRun: stageName === 'QA' ? qaCommands : 1, toolCalls: 1, toolErrors: 0,
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
  approvalReply = { approved: false, response: 'Abort Pipeline' };
  qaCommands = 1;
  onStage = {};
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

  test('hooks for a different project folder do not apply here, and the summary says so', async () => {
    refreshConfigKey('agent.evidenceHooks', [{ name: 'test', command: 'ls never.txt', root: join(tmpdir(), `elsewhere-${rand(4)}`) }]);
    const { pipelineId } = await run();
    const row = await pipelineRow(pipelineId);
    expect(row.status).toBe('completed');
    expect(String(row.summary)).toContain('none has its root at or inside');
    expect(await evidenceRows(pipelineId)).toEqual([]);
  });

  test('a run with no artifact-producing stage runs none, and says so', async () => {
    hooks({ name: 'test', command: 'ls never.txt' });
    const { pipelineId } = await run('evidence-research');
    const row = await pipelineRow(pipelineId);
    expect(row.status).toBe('completed');
    expect(String(row.summary)).toContain('declares no artifact-producing stage');
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
    // The output is framed as data, not as instructions.
    expect(retry).toContain('<hook-output name="test">');

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
    const { results: [result] } = await runEvidenceHooks(
      { userId, sessionId, role: 'coding' },
      { hooks: [{ name: 'slow', command: 'sleep 20', root, timeoutMs: 1_000 }] },
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result).toMatchObject({ name: 'slow', passed: false, timedOut: true });
    expect(result.refused).toBeUndefined();
  });
});

describe('where a hook applies and runs', () => {
  test('a hook rooted in a folder inside the stage folder runs there', async () => {
    const repo = join(root, `repo-${rand(3)}`);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'marker.txt'), 'x');
    refreshConfigKey('agent.evidenceHooks', [{ name: 'test', command: 'ls marker.txt', root: repo }]);
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([true]);
  });

  test('a hook rooted above the stage folder is refused out loud, not run elsewhere or skipped', async () => {
    const parent = dirname(root);
    writeFileSync(join(parent, 'marker-at-parent.txt'), 'x');
    refreshConfigKey('agent.evidenceHooks', [{ name: 'test', command: 'ls marker-at-parent.txt', root: parent }]);
    const { pipelineId } = await run();
    const row = await pipelineRow(pipelineId);
    expect(row.status).toBe('paused');
    expect(String(row.summary)).toContain('lies outside it');
    expect(stageCalls('QA')).toHaveLength(0);
  });

  test('a root given through a symlink matches the folder it points to', async () => {
    const link = join(tmpdir(), `evidence-link-${rand(4)}`);
    symlinkSync(root, link);
    refreshConfigKey('agent.evidenceHooks', [{ name: 'test', command: 'ls never.txt', root: link }]);
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    expect((await evidenceRows(pipelineId)).length).toBeGreaterThan(0);
  });
});

describe('hooks and the auditor contract', () => {
  test('an auditor declaring runsCommands that obeys "do not re-run" is not failed for it', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    qaCommands = 0;
    const { pipelineId } = await run('evidence-qa-runs');
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(stageCalls('QA')).toHaveLength(1);
    expect(await evidenceRows(pipelineId)).toHaveLength(1);
  });
});

describe('no route to completed skips the hooks', () => {
  test('a person skipping the auditor does not complete the run over failing evidence', async () => {
    hooks({ name: 'test', command: 'ls never.txt' });
    approvalReply = { approved: true, response: 'Skip' };
    const { pipelineId } = await run('evidence-qa-approve');
    expect(approvalsAsked).toBe(1);
    const row = await pipelineRow(pipelineId);
    expect(row.status).toBe('failed');
    expect(String(row.summary)).toContain('about to complete');
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([false]);
  });

  test('a skipped auditor with passing evidence completes, with the evidence recorded', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    approvalReply = { approved: true, response: 'Skip' };
    const { pipelineId } = await run('evidence-qa-approve');
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([true]);
  });

  test('a stage that changes files after the auditor is checked again before completion', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    onStage = { Polish: () => rmSync(join(root, 'built.txt')) };
    const { pipelineId } = await run('evidence-after-auditor');
    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([true, false]);
  });

  test('an auditor that may change files has the evidence checked again before completion', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    onStage = { QA: () => rmSync(join(root, 'built.txt')) };
    const { pipelineId } = await run('evidence-qa-writer');
    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([true, false]);
  });

  test('a passing auditor run is not checked twice', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    const { pipelineId } = await run();
    expect(await evidenceRows(pipelineId)).toHaveLength(1);
  });
});

describe('plan loops', () => {
  test('hooks run on the last item only, and its evidence is scoped to it', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    implementWrites = [['draft.txt'], ['built.txt']];
    const { pipelineId } = await run('evidence-loop');
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    const rows = await evidenceRows(pipelineId);
    expect(rows.map((r) => r.passed)).toEqual([true]);
    const { rows: items } = await queryRaw(`SELECT id FROM plan_items WHERE pipeline_id = '${pipelineId}' AND ordinal = 1`);
    expect(String(rows[0].detail.checkScope)).toContain(`item:${items[0].id}`);
  });

  test('a failing hook on the last item sends that item back for repair', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    implementWrites = [['draft.txt'], ['draft.txt'], ['built.txt']];
    const { pipelineId } = await run('evidence-loop');
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(stageCalls('Implement')).toHaveLength(3);
    expect(stageCalls('Implement')[2].input).toContain('item two');
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([false, true]);
  });
});

describe('hooks that cannot run pause the run', () => {
  test('a permission denial pauses it with the reason', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().setPermission(userId, 'shell', 'execute', 'DENY');
    try {
      const { pipelineId } = await run();
      const row = await pipelineRow(pipelineId);
      expect(row.status).toBe('paused');
      expect(String(row.summary)).toContain('shell.execute');
      expect(stageCalls('Implement')).toHaveLength(1);
    } finally {
      await getPermissionManager().setPermission(userId, 'shell', 'execute', 'ALLOW');
    }
  });

  test('in a run with no auditor too, paused rather than failed', async () => {
    hooks({ name: 'test', command: 'ls built.txt && rm -rf /' });
    const { pipelineId } = await run('evidence-no-auditor');
    const row = await pipelineRow(pipelineId);
    expect(row.status).toBe('paused');
    expect(String(row.summary)).toContain('End-of-run evidence check');
    expect(String(row.summary)).toContain('misconfigured');
  });
});
