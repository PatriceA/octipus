/**
 * Calls approved for a pipeline (#12/#20) are read from the pipeline row, so
 * they hold across a server restart and end with the run. Real database.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '77777777-7777-4777-8777-777777777777';
let sessionId = '';
let otherSessionId = '';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-approved-calls-'));
  const { getConfig } = await import('@/config');
  getConfig();
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers, seedSession } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'approved-calls' }]);
  sessionId = (await seedSession({ userId, channelType: 'web', channelId: rand(4) })).id;
  otherSessionId = (await seedSession({ userId, channelType: 'web', channelId: rand(4) })).id;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('calls approved for a pipeline', () => {
  const bash = (command: string, extra: Record<string, unknown> = {}) => ({ toolId: 'cli-native:Bash', action: 'Bash', toolName: 'Bash', args: { command, description: 'any', ...extra } });
  const shell = (args: Record<string, unknown>) => ({ toolId: 'shell', action: 'execute', toolName: 'run', args });
  const write = (content: string) => ({ toolId: 'cli-native:Write', action: 'Write', toolName: 'Write', args: { file_path: 'src/a.ts', content } });

  test('approval binds the concrete operation and preserves published description and timeout arguments', async () => {
    const { approvedCallOf, gateCommandCalls, isApprovedCall, withApprovedCalls } = await import('./approved-calls');
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const scope = { nodeKey: 'implement', attemptId: 'attempt-1', hostServices: false };
    const foreground = shell({ command: 'npm test' });
    const createRepo = { toolId: 'github', action: 'write', toolName: 'repo_create',
      args: { name: 'approval-regression', description: 'Approved public description', private: true } };
    const calls = [approvedCallOf(foreground, scope)!, approvedCallOf(createRepo, scope)!];
    const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId,
      title: 'operation scope', type: 'development', status: 'running', metadata: withApprovedCalls({}, calls) });
    const caller = { userId, sessionId, metadata: { pipelineId: pipeline.id, ...scope } };
    await expect(isApprovedCall(caller, foreground)).resolves.toBe(true);
    await expect(isApprovedCall(caller, { ...foreground, toolName: 'run_background' })).resolves.toBe(false);
    await expect(isApprovedCall(caller, { ...foreground, toolName: undefined })).resolves.toBe(false);
    await expect(isApprovedCall(caller, createRepo)).resolves.toBe(true);
    await expect(isApprovedCall(caller, { ...createRepo,
      args: { ...createRepo.args, description: 'Different published content' } })).resolves.toBe(false);
    await expect(isApprovedCall(caller, { ...createRepo,
      args: { ...createRepo.args, timeout: 600 } })).resolves.toBe(false);
    // A plan gate also names the foreground operation, never its detached sibling.
    await pipelineRepository.updatePipeline(pipeline.id, { metadata: withApprovedCalls({}, gateCommandCalls('npm test', scope.nodeKey, false)) });
    await expect(isApprovedCall(caller, foreground)).resolves.toBe(true);
    await expect(isApprovedCall(caller, { ...foreground, toolName: 'run_background' })).resolves.toBe(false);
    // Old persisted grants without concrete operation identity fail closed.
    const { toolName: _oldName, ...legacy } = calls[0];
    await pipelineRepository.updatePipeline(pipeline.id, { metadata: { approvedCalls: [legacy] } });
    await expect(isApprovedCall(caller, foreground)).resolves.toBe(false);
  });

  test('a grant executes only the exact call, for its own stage attempt and capabilities, while the run lives', async () => {
    const { routeApprovalFor } = await import('./approval-route');
    const { approvedCallOf, gateCommandCalls, stageScopeOf, withApprovedCalls } = await import('./approved-calls');
    const { stageChildMetadata } = await import('@/core/agent/worker-spawner');
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const attempt = { nodeKey: 'implement', attemptId: 'attempt-1', hostServices: false };
    const metadata = withApprovedCalls(
      withApprovedCalls({ keep: true, approvedCalls: [{ toolId: 'shell', action: 'execute', subject: 'old shape' }] },
        [approvedCallOf(bash('docker compose build'), attempt)!, approvedCallOf(write('ok'), attempt)!]),
      [...gateCommandCalls('npm test', 'qa', false), ...gateCommandCalls('npm test', 'qa', false)],
    );
    expect(metadata).toMatchObject({ keep: true });
    // The pre-scope grant is dropped; the gate pair is stored once.
    expect(metadata.approvedCalls).toHaveLength(4);
    const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 't', type: 'development', status: 'running', metadata });
    // Another live pipeline of the same session, with no grants.
    const other = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 'o', type: 'development', status: 'running', metadata: {} });

    const stage = (over: Record<string, unknown> = {}) => ({ pipelineId: pipeline.id, nodeKey: 'implement', attemptId: 'attempt-1', ...over });
    type Call = { toolId: string; action: string; toolName: string; args: Record<string, unknown> };
    const route = (call: Call, metadata: Record<string, unknown> | undefined = stage(), over: Record<string, unknown> = {}, level: 'ASK' | 'DENY' = 'ASK') =>
      routeApprovalFor({ userId, sessionId, role: 'coding', attended: true, metadata, ...over }, call, { level }).then(decision => decision.route);

    await expect(route(bash('docker compose build'))).resolves.toBe('execute');
    // The CLI's one-line label is not part of the approval.
    await expect(route(bash('docker compose build', { description: 'other label' }))).resolves.toBe('execute');
    await expect(route(bash('docker compose down'))).resolves.toBe('ask_human');
    await expect(route(bash('docker compose build', { run_in_background: true }))).resolves.toBe('ask_human');
    await expect(route(bash('docker compose build', { dangerouslyDisableSandbox: true }))).resolves.toBe('ask_human');
    await expect(route(write('ok'))).resolves.toBe('execute');
    await expect(route(write('different contents'))).resolves.toBe('ask_human');
    // Capabilities: the same call in a stage attempt with host services is a different approval.
    await expect(route(bash('docker compose build'), stage({ hostServices: true }))).resolves.toBe('ask_human');
    // Lifecycle of the attempt: a later attempt, another stage, another pipeline.
    await expect(route(bash('docker compose build'), stage({ attemptId: 'attempt-2' }))).resolves.toBe('ask_human');
    await expect(route(bash('docker compose build'), stage({ nodeKey: 'qa' }))).resolves.toBe('ask_human');
    await expect(route(bash('docker compose build'), stage({ pipelineId: other.id }))).resolves.toBe('ask_human');
    // Unrelated workers: the root (no stage metadata), a child the stage spawned, a forged handle.
    await expect(route(bash('docker compose build'), {})).resolves.toBe('ask_human');
    const child = stageChildMetadata({ ...stage(), resumeKey: 'pipeline-x:implement:attempt-1' });
    expect(child).toEqual({ pipelineId: pipeline.id, nodeKey: 'implement' });
    expect(stageScopeOf(child)).toBeUndefined();
    await expect(route(bash('docker compose build'), child)).resolves.toBe('ask_human');
    await expect(route(bash('docker compose build'), stage({ pipelineId: 'not-a-uuid' }))).resolves.toBe('ask_human');
    // Owner scope: another session, another workspace.
    await expect(route(bash('docker compose build'), stage(), { sessionId: otherSessionId })).resolves.toBe('ask_human');
    await expect(route(bash('docker compose build'), stage(), { workspaceId: '99999999-9999-4999-8999-999999999999' })).resolves.toBe('ask_human');
    // DENY still wins.
    await expect(route(bash('docker compose build'), stage(), {}, 'DENY')).resolves.toBe('deny');

    // Gate commands: their own stage, any attempt of it, default scope only.
    const qa = stage({ nodeKey: 'qa', attemptId: 'qa-attempt-7' });
    await expect(route(bash('npm test'), qa)).resolves.toBe('execute');
    await expect(route(shell({ command: 'npm test' }), qa)).resolves.toBe('execute');
    await expect(route(shell({ command: 'npm test', timeout: 600 }), qa)).resolves.toBe('execute');
    await expect(route(bash('npm test 2>&1'), qa)).resolves.toBe('ask_human');
    await expect(route(shell({ command: 'npm test', cwd: '/tmp' }), qa)).resolves.toBe('ask_human');
    await expect(route(shell({ command: 'npm test', env: { NODE_OPTIONS: '--require x' } }), qa)).resolves.toBe('ask_human');
    await expect(route(shell({ command: 'npm test', network: true }), qa)).resolves.toBe('ask_human');
    await expect(route(shell({ command: 'npm test', useShell: true }), qa)).resolves.toBe('ask_human');
    await expect(route(bash('npm test'), stage())).resolves.toBe('ask_human');
    await expect(route(bash('npm test'), { ...qa, hostServices: true })).resolves.toBe('ask_human');

    // The run ends: every grant ends with it.
    await pipelineRepository.updatePipeline(pipeline.id, { status: 'completed' });
    await expect(route(bash('docker compose build'))).resolves.toBe('ask_human');
    await expect(route(bash('npm test'), qa)).resolves.toBe('ask_human');
  });
});

test('an approved overnight profile covers each stage, records denials and preserves explicit DENY (#49/#52)', async () => {
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { routeApprovalFor } = await import('./approval-route');
  const { rememberRunDecision } = await import('./pipeline-permissions');
  const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
  const profile = pipelinePermissionProfileSchema.parse({ repoPath: '/repo', publicHosts: ['go.dev'], packageManagers: ['pnpm'], overnight: true });
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 'overnight', type: 'development', status: 'running',
    metadata: { permissionProfile: { profile, repoPath: '/repo', approvedBy: userId } } });
  const caller = { userId, sessionId, attended: false, metadata: { pipelineId: pipeline.id, nodeKey: 'testing', attemptId: 'one' } };
  const read = { toolId: 'cli-native:Bash', action: 'Bash', toolName: 'Bash', args: { command: "curl --head 'https://go.dev/dl/?mode=json&include=all'" } };
  expect(await routeApprovalFor(caller, read, { level: 'ASK' })).toMatchObject({ route: 'execute', source: 'pipeline-approval' });
  expect(await routeApprovalFor({ ...caller, metadata: { ...caller.metadata, nodeKey: 'qa', attemptId: 'two' } }, read, { level: 'ASK' })).toMatchObject({ route: 'execute' });
  expect(await routeApprovalFor(caller, read, { level: 'DENY', source: 'permission:deny' })).toMatchObject({ route: 'deny' });
  const outside = { ...read, args: { command: 'curl https://outside.example' } };
  expect(await routeApprovalFor(caller, outside, { level: 'ASK' })).toMatchObject({ route: 'deny', reason: expect.stringContaining('morning summary') });
  expect((await pipelineRepository.findById(pipeline.id))?.metadata?.deniedRequests).toHaveLength(2);
  // Simulate a real human decision in attended mode; the exact fingerprint then holds across stages.
  await rememberRunDecision(caller, outside);
  expect(await routeApprovalFor({ ...caller, metadata: { ...caller.metadata, nodeKey: 'qa', attemptId: 'three' } }, outside, { level: 'ASK' })).toMatchObject({ route: 'execute' });
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'completed' });
  expect(await routeApprovalFor(caller, read, { level: 'ASK' })).toMatchObject({ route: 'blocked' });
});
