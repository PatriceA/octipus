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
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      for (const file of implementWrites[Math.min(visit, implementWrites.length - 1)] ?? []) writeFileSync(join(root, file), `${visit}-${rand(4)}`);
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
    const name = `repo-${rand(3)}`;
    const repo = join(root, name);
    mkdirSync(repo, { recursive: true });
    // The work happens in the repo; the hook proves it ran there, not in the stage folder.
    implementWrites = [[`${name}/marker.txt`]];
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

const PROSE = 'I looked at it and it seems fine.';
const sub = (name: string) => { const dir = join(root, `${name}-${rand(3)}`); mkdirSync(dir, { recursive: true }); return dir; };

async function resumeApproved(id: string, opts: { fromSeq?: number } = {}) {
  const { getPermissionManager } = await import('@/security/permissions');
  const permissions = getPermissionManager();
  let done = false;
  const resumed = manager.resume(id, opts).finally(() => { done = true; });
  // A rewind asks for a replay review; the test plays the person who approves it.
  for (let i = 0; i < 300 && !done; i++) {
    for (const request of await permissions.getPendingRequests(userId)) await permissions.approve(request.id, userId);
    await new Promise((r) => setTimeout(r, 100));
  }
  await resumed;
}

describe('second review', () => {
  test('a verdict repair on a non-final plan item does not run the project-wide hooks', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    implementWrites = [['draft.txt'], ['built.txt']];
    replies = { QA: [PROSE, QA_PASS] };
    const { pipelineId } = await run('evidence-loop');
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(stageCalls('Implement')).toHaveLength(2);
    const { rows: items } = await queryRaw(`SELECT id FROM plan_items WHERE pipeline_id = '${pipelineId}' AND ordinal = 1`);
    const rows = await evidenceRows(pipelineId);
    expect(rows.map((r) => r.passed)).toEqual([true]);
    expect(String(rows[0].detail.checkScope)).toContain(`item:${items[0].id}`);
  });

  test('a stage swapping a hook root for a symlink pauses the run instead of switching the hook off', async () => {
    const sub = join(root, `proj-${rand(3)}`);
    mkdirSync(sub);
    refreshConfigKey('agent.evidenceHooks', [{ name: 'test', command: 'ls never.txt', root: sub }]);
    const outside = mkdtempSync(join(tmpdir(), 'evidence-outside-'));
    onStage = { Implement: () => { if (!existsSync(`${sub}-real`)) { renameSync(sub, `${sub}-real`); symlinkSync(outside, sub); } } };
    const { pipelineId } = await run();
    const row = await pipelineRow(pipelineId);
    // A symlink left in the workspace would make every later run's change set unknown.
    rmSync(sub);
    expect(row.status).toBe('paused');
    expect(String(row.summary)).toContain('when the run started');
  });

  test('a hook for another project in the same workspace does not judge this run', async () => {
    const mine = sub('mine');
    const other = sub('unrelated');
    refreshConfigKey('agent.evidenceHooks', [
      { name: 'mine-tests', command: 'ls built.txt', root: mine },
      { name: 'other-tests', command: 'ls never.txt', root: other },
    ]);
    implementWrites = [[`${mine.slice(root.length + 1)}/built.txt`]];
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(stageCalls('Implement')).toHaveLength(1);
    expect((await evidenceRows(pipelineId)).map((r) => r.detail.hook)).toEqual(['mine-tests']);
  });

  test('a hook that never ran is a block, not failed work', async () => {
    const { runEvidenceHooks } = await import('./evidence-hooks');
    const { results: [result] } = await runEvidenceHooks(
      { userId, sessionId, role: 'coding' },
      { hooks: [{ name: 'gone', command: 'definitely-not-a-program-x7 --version', root, timeoutMs: 5_000 }] },
    );
    expect(result).toMatchObject({ passed: false, refused: true, exitCode: null });
  });

  test('resuming after an end-of-run block runs only the check, not the last stage', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().setPermission(userId, 'shell', 'execute', 'DENY');
    let pipelineId = '';
    try {
      ({ pipelineId } = await run('evidence-no-auditor'));
      expect((await pipelineRow(pipelineId)).status).toBe('paused');
    } finally {
      await getPermissionManager().setPermission(userId, 'shell', 'execute', 'ALLOW');
    }
    const implementBefore = stageCalls('Implement').length;
    await manager.resume(pipelineId);
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(stageCalls('Implement')).toHaveLength(implementBefore);
    expect((await evidenceRows(pipelineId)).map((r) => r.passed)).toEqual([false, true]);
  }, 60_000);

  test('an evidence failure in the middle of a verdict repair round resets that round', async () => {
    hooks({ name: 'test', command: 'ls built.txt' });
    let qaVisits = 0;
    onStage = { QA: () => { if (qaVisits++ === 0) rmSync(join(root, 'built.txt')); } };
    replies = { QA: [PROSE, PROSE, PROSE, QA_PASS] };
    const { pipelineId } = await run('evidence-qa-writer');
    expect((await pipelineRow(pipelineId)).status).toBe('completed');
    expect(stageCalls('Implement')).toHaveLength(2);
  });
});

describe('third review: the change set may only narrow when it is trustworthy', () => {
  test('a rewind to an earlier checkpoint runs every hook, whatever that checkpoint knew', async () => {
    const app = sub('app');
    const other = sub('other');
    refreshConfigKey('agent.evidenceHooks', [
      { name: 'test', command: 'ls built.txt', root: app },
      { name: 'other', command: 'ls ok.txt', root: other },
    ]);
    implementWrites = [[]];
    let visits = 0;
    // Three failing attempts in app; after the rewind the implementer only
    // touches the other project, so a change set narrowed from the rewound
    // checkpoint would skip app's hook.
    onStage = { Implement: () => {
      if (visits++ < 3) writeFileSync(join(app, 'draft.txt'), `x${visits}`);
      else writeFileSync(join(other, 'ok.txt'), `y${visits}`);
    } };
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    const rowsBefore = (await evidenceRows(pipelineId)).length;
    const { rows: checkpoints } = await queryRaw(`SELECT c.seq FROM pipeline_checkpoints c JOIN pipeline_nodes n
      ON n.pipeline_id = c.pipeline_id AND n.node_key = c.node_key WHERE c.pipeline_id = '${pipelineId}' AND n.name = 'Implement' ORDER BY c.seq LIMIT 1`);
    await resumeApproved(pipelineId, { fromSeq: Number(checkpoints[0].seq) });
    expect((await pipelineRow(pipelineId)).status).not.toBe('completed');
    expect((await evidenceRows(pipelineId)).length).toBeGreaterThan(rowsBefore);
  }, 120_000);

  test('a change only in a sibling folder runs the hooks of the project beside it', async () => {
    const app = sub('app');
    const lib = sub('lib');
    refreshConfigKey('agent.evidenceHooks', [{ name: 'app-test', command: 'ls never.txt', root: app }]);
    implementWrites = [[]];
    onStage = { Implement: () => writeFileSync(join(lib, 'shared.js'), 'broken') };
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    expect((await evidenceRows(pipelineId)).length).toBeGreaterThan(0);
  });

  test('a same-size rewrite with its timestamp put back is still a change', async () => {
    const { execFileSync } = await import('node:child_process');
    const app = sub('app');
    const other = sub('other');
    const file = join(app, 'code.txt');
    writeFileSync(file, 'a');
    refreshConfigKey('agent.evidenceHooks', [
      { name: 'app-test', command: 'ls never.txt', root: app },
      { name: 'other-test', command: 'ls ok.txt', root: other },
    ]);
    implementWrites = [[]];
    // An honest change in the other project, so the change set is not empty
    // and would narrow to it if the forged rewrite in app went unseen.
    onStage = { Implement: () => {
      writeFileSync(join(other, 'ok.txt'), rand(4));
      // `touch -r` restores the timestamp to the nanosecond, as a forger would.
      execFileSync('cp', ['-p', file, `${file}.ref`]);
      writeFileSync(file, 'b');
      execFileSync('touch', ['-r', `${file}.ref`, file]);
      rmSync(`${file}.ref`);
    } };
    const { pipelineId } = await run();
    expect((await pipelineRow(pipelineId)).status).toBe('failed');
    expect((await evidenceRows(pipelineId)).length).toBeGreaterThan(0);
  });

  test('a stage on a remote execution environment is refused with the reason, not "does not exist"', async () => {
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const remote = (await seedSession({ userId, channelId: `remote-${rand(3)}` })).id;
    const pg = await import('@/db/postgres');
    await pg.executeRaw(`UPDATE sessions SET context = '{"executionEnvironmentId":"remote-1","projectPath":"/remote/proj"}'::jsonb WHERE id = '${remote}'`);
    refreshConfigKey('security.executionEnvironments', [{ id: 'remote-1', userId, name: 'Remote', backend: 'ssh', roots: ['/remote/proj'], ssh: { host: 'build.example', user: 'ci' } }]);
    try {
      const { runEvidenceHooks } = await import('./evidence-hooks');
      const { results } = await runEvidenceHooks({ userId, sessionId: remote, role: 'coding' },
        { hooks: [{ name: 'test', command: 'npm test', root: '/remote/proj', timeoutMs: 5_000 }] });
      expect(results[0]).toMatchObject({ refused: true });
      expect(results[0].reason).toContain('not supported on remote (SSH) execution environments');
    } finally {
      refreshConfigKey('security.executionEnvironments', []);
    }
  });
});
