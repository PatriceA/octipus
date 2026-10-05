/**
 * A pipeline stage's `verifyCommand` runs where the stage's agents work: the
 * session's workspace (here a non-default one). Before, the scorer got no
 * workspace root outside dev mode and reported "the workspace could not be
 * resolved" to the auditor as the stage's ground truth.
 *
 * Real database, real permission check, real shell; the command looks for a
 * file that exists in that workspace alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '66666666-6666-4666-8666-666666666666';
let dataRoot = '';
let projectWs = '';
let sessionId = '';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-stage-verify-'));
  dataRoot = mkdtempSync(join(tmpdir(), 'octipus-stage-verify-files-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', dataRoot);

  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers, seedSession } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice-verify' }]);
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  await getOrgWorkspaceManager().ensureDefaultWorkspace(aliceId);
  projectWs = (await getOrgWorkspaceManager().createWorkspace(aliceId, { slug: 'build', name: 'Build' })).id;
  sessionId = (await seedSession({ userId: aliceId, channelType: 'web', channelId: rand(4) })).id;
  await executeRaw(`UPDATE sessions SET workspace_id = '${projectWs}' WHERE id = '${sessionId}'`);

  const { getPermissionManager } = await import('@/security/permissions');
  await getPermissionManager().setPermission(aliceId, 'shell', 'execute', 'ALLOW');
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('runStageVerifyCommand', () => {
  test("runs the command in the session's workspace", async () => {
    const root = join(dataRoot, 'users', aliceId, 'workspaces', projectWs, 'files');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'built.txt'), 'ok');

    const { runStageVerifyCommand } = await import('./pipeline-manager');
    const ctx = { userId: aliceId, sessionId, workspaceId: projectWs, space: null, role: 'coding', toolIds: ['shell'] };
    expect(await runStageVerifyCommand('ls built.txt', ctx)).toMatch(/RESULT: exit 0/);
    // The same command fails on a file the workspace does not hold: it ran
    // there, not somewhere that happens to hold everything.
    expect(await runStageVerifyCommand('ls missing.txt', ctx)).toMatch(/RESULT: FAILED/);
  });
});
