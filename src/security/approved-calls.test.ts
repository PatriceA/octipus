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
