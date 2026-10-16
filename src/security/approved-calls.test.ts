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
  const caller = () => ({ userId, sessionId, role: 'qa', attended: true });
  const bash = (command: string) => ({ toolId: 'cli-native:Bash', action: 'Bash', toolName: 'Bash', args: { command, description: 'any' } });
  const shell = (command: string) => ({ toolId: 'shell', action: 'execute', toolName: 'run', args: { command } });

  test('the blocked call and the named gate commands execute while the run lives, nothing else', async () => {
    const { routeApprovalFor } = await import('./approval-route');
    const { approvedCallOf, gateCommandCalls, withApprovedCalls } = await import('./approved-calls');
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const metadata = withApprovedCalls(
      withApprovedCalls({ keep: true }, [approvedCallOf(bash('docker compose build'))!]),
      [...gateCommandCalls('npm test'), ...gateCommandCalls('npm test')],
    );
    expect(metadata).toMatchObject({ keep: true });
    expect(metadata.approvedCalls).toHaveLength(3);
    const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 't', type: 'development', status: 'running', metadata });

    const route = (call: ReturnType<typeof shell> | ReturnType<typeof bash>, over: Record<string, unknown> = {}, level: 'ASK' | 'DENY' = 'ASK') =>
      routeApprovalFor({ ...caller(), ...over }, call, { level });
    await expect(route(bash('docker compose build'))).resolves.toMatchObject({ route: 'execute', source: 'pipeline-approval' });
    await expect(route(bash('npm test'))).resolves.toMatchObject({ route: 'execute' });
    await expect(route(shell('npm test'))).resolves.toMatchObject({ route: 'execute' });
    await expect(route(bash('npm test 2>&1'))).resolves.toMatchObject({ route: 'ask_human' });
    await expect(route(bash('docker compose down'))).resolves.toMatchObject({ route: 'ask_human' });
    await expect(route(bash('npm test'), { sessionId: otherSessionId })).resolves.toMatchObject({ route: 'ask_human' });
    await expect(route(bash('npm test'), { sessionId: 'not-a-uuid' })).resolves.toMatchObject({ route: 'ask_human' });
    await expect(route(bash('npm test'), {}, 'DENY')).resolves.toMatchObject({ route: 'deny' });

    await pipelineRepository.updatePipeline(pipeline.id, { status: 'completed' });
    await expect(route(bash('npm test'))).resolves.toMatchObject({ route: 'ask_human' });
  });
});
