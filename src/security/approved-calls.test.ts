/**
 * Calls approved for a pipeline (#12/#20) are read from the pipeline row, so
 * they hold across a server restart and end with the run. Real database.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

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
  const read = { toolId: 'cli-native:Bash', action: 'Bash', toolName: 'Bash', args: { command: "curl --head 'https://go.dev/dl/?mode=json&include=all'", cwd: '/repo' } };
  expect(await routeApprovalFor(caller, read, { level: 'ASK' })).toMatchObject({ route: 'execute', source: 'pipeline-approval' });
  expect(await routeApprovalFor({ ...caller, metadata: { ...caller.metadata, nodeKey: 'qa', attemptId: 'two' } }, read, { level: 'ASK' })).toMatchObject({ route: 'execute' });
  expect(await routeApprovalFor(caller, read, { level: 'DENY', source: 'permission:deny' })).toMatchObject({ route: 'deny' });
  const outside = { ...read, args: { command: 'curl https://outside.example' } };
  expect(await routeApprovalFor(caller, outside, { level: 'ASK' })).toMatchObject({ route: 'deny', reason: expect.stringContaining('morning summary') });
  expect((await pipelineRepository.findById(pipeline.id))?.metadata?.deniedRequests).toHaveLength(2);
  // A target repo in the profile does not establish the native/shell execution cwd.
  expect(await routeApprovalFor(caller, { ...read, args: { command: read.args.command } }, { level: 'ASK' })).toMatchObject({ route: 'deny' });
  expect(await routeApprovalFor(caller, { ...read, args: { ...read.args, cwd: '/workspace/octipus' } }, { level: 'ASK' })).toMatchObject({ route: 'deny' });
  // Simulate a real human decision in attended mode; the exact fingerprint then holds across stages.
  await rememberRunDecision(caller, outside);
  expect(await routeApprovalFor({ ...caller, metadata: { ...caller.metadata, nodeKey: 'qa', attemptId: 'three' } }, outside, { level: 'ASK' })).toMatchObject({ route: 'execute' });
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'completed' });
  expect(await routeApprovalFor(caller, read, { level: 'ASK' })).toMatchObject({ route: 'blocked' });
});

test('approved remote SSH survives pause/resume and shell default cwd resolution without approving changed actions', async () => {
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { routeApprovalFor } = await import('./approval-route');
  const { askStillAuthorized } = await import('./approved-calls');
  const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
  const repo = '/home/patrice/docker-services/solar-system-map';
  const command = 'ssh root@192.168.1.156 "docker compose -f /opt/stacks/solar-system-map/compose.yaml ps --format json"';
  const profile = pipelinePermissionProfileSchema.parse({ repoPath: repo, commands: [command], overnight: true, hostServices: true });
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 'remote deployment', type: 'development', status: 'paused', metadata: { permissionProfile: { profile, repoPath: repo, approvedBy: userId, approvedAt: '2026-10-31T23:06:51.989Z' } } });
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'running' });
  const caller = { userId, sessionId, attended: false, metadata: { pipelineId: pipeline.id, nodeKey: 'deploy', attemptId: 'resumed', projectPath: repo, hostServices: true } };
  const call = { toolId: 'shell', toolName: 'run', action: 'execute', args: { command } };
  expect(await routeApprovalFor(caller, call, { level: 'ASK' })).toMatchObject({ route: 'execute', source: 'pipeline-approval' });
  expect(await askStillAuthorized('pipeline-approval', caller, call)).toBe(true);
  expect(await routeApprovalFor(caller, call, { level: 'ASK', source: 'flow-guard', reason: 'session read credential material; network egress requires approval' })).toMatchObject({ route: 'execute', source: 'pipeline-approval' });
  expect(await routeApprovalFor(caller, { ...call, args: { command: 'npm test' } }, { level: 'ASK', source: 'flow-guard' })).toMatchObject({ route: 'deny', reason: expect.stringContaining('flow guard') });
  const variant = { ...call, args: { command: 'ssh root@192.168.1.156 "cd /opt/stacks/solar-system-map && docker compose ps"' } };
  expect(await routeApprovalFor(caller, variant, { level: 'ASK' })).toMatchObject({ route: 'execute' });
  expect(await routeApprovalFor(caller, { ...variant, args: { command: variant.args.command.replace('compose ps', 'compose up') } }, { level: 'ASK' })).toMatchObject({ route: 'deny', reason: expect.stringContaining('command or permission action') });
  expect(await routeApprovalFor(caller, { ...call, args: { command, cwd: '/tmp/assistant-outside' } }, { level: 'ASK' })).toMatchObject({ route: 'deny', reason: expect.stringContaining('execution cwd') });
  expect(await routeApprovalFor({ ...caller, sessionId: otherSessionId }, call, { level: 'ASK' })).toMatchObject({ route: 'blocked' });
  expect(await routeApprovalFor(caller, call, { level: 'DENY' })).toMatchObject({ route: 'deny' });
});

test('flow consent is rechecked and remembered shell grants bind the actual default cwd', async () => {
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { rememberRunDecision } = await import('./pipeline-permissions');
  const { isApprovedCall, askStillAuthorized } = await import('./approved-calls');
  const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
  const profile = pipelinePermissionProfileSchema.parse({ repoPath: '/repo-a', packageManagers: ['pnpm'] });
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 'consent revalidation', type: 'development', status: 'running', metadata: { permissionProfile: { profile, repoPath: '/repo-a', approvedBy: userId } } });
  const caller = { userId, sessionId, metadata: { pipelineId: pipeline.id, nodeKey: 'test', attemptId: 'one', projectPath: '/repo-a' } };
  const command = { toolId: 'shell', toolName: 'run', action: 'execute', args: { command: 'pnpm test' } };
  expect(await askStillAuthorized('pipeline-approval', caller, command)).toBe(true);
  expect(await askStillAuthorized('pipeline-approval', caller, command, 'flow-guard')).toBe(false);
  const custom = { ...command, args: { command: 'custom-approved-check' } };
  await rememberRunDecision(caller, custom);
  expect(await isApprovedCall(caller, custom)).toBe(true);
  expect(await isApprovedCall({ ...caller, metadata: { ...caller.metadata, projectPath: '/repo-b' } }, custom)).toBe(false);
});

test('Compose reservations survive cleanup and refuse foreign scope and unknown retained resources', async () => {
  const { claimDockerProject } = await import('@/db/repositories/docker-project-repository');
  const identity = `test-daemon:${rand(8)}`;
  await claimDockerProject(identity, '/repo', { userId }, true, false);
  await claimDockerProject(identity, '/repo', { userId }, false, true);
  await expect(claimDockerProject(identity, '/other', { userId }, true, false)).rejects.toThrow('another repository');
  await expect(claimDockerProject(identity, '/repo', { userId, workspaceId: 'other' }, false, false)).rejects.toThrow('execution scope');
  await expect(claimDockerProject(`test-daemon:${rand(8)}`, '/repo', { userId }, true, true)).rejects.toThrow('ownership is unknown');
  const approvedExisting = `test-daemon:${rand(8)}`;
  await claimDockerProject(approvedExisting, '/repo', { userId }, true, true, true);
  await claimDockerProject(approvedExisting, '/repo', { userId }, false, true);
  await expect(claimDockerProject(approvedExisting, '/other', { userId }, true, true, true)).rejects.toThrow('another repository');
  await expect(claimDockerProject(approvedExisting, '/repo', { userId, workspaceId: 'other' }, true, true, true)).rejects.toThrow('execution scope');
});

test('registered shell dispatch reaches the approved SSH executor after flow taint and resume', async () => {
  const { ShellTool } = await import('@/tools/shell');
  const { ToolExecutor } = await import('@/core/tool-executor');
  const { observeFlow } = await import('./flow-guard');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { getPermissionManager } = await import('./permissions');
  const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
  const repo = '/home/patrice/docker-services/solar-system-map';
  const command = 'ssh root@192.168.1.156 "docker compose -f /opt/stacks/solar-system-map/compose.yaml ps --format json"';
  const profile = pipelinePermissionProfileSchema.parse({ repoPath: repo, commands: [command], overnight: true });
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 'registered SSH regression', type: 'development', status: 'paused', metadata: { permissionProfile: { profile, repoPath: repo, approvedBy: userId } } });
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'running' });
  const exec = vi.fn<import('@/tools/shell/operations').ShellOperations['exec']>(async () => ({ exitCode: 0, stdout: '[]', stderr: '', killed: false, timedOut: false, aborted: false, signal: null }));
  const shell = new ShellTool({ exec, spawnBackground: async () => ({ pid: undefined }), which: async () => null, getEnv: async () => ({}) });
  await shell.initialize();
  await getPermissionManager().setPermission(userId, 'shell', 'execute', 'ASK');
  observeFlow(sessionId, { toolId: 'fixture', action: 'read' }, { taints: ['secret'] });
  const now = new Date();
  const context: import('@/core/types').AgentContext = { id: 'approved-ssh-worker', userId, sessionId, workspaceId: null, role: 'coding', topic: 'coding', model: 'fixture', status: 'running', createdAt: now, updatedAt: now, attended: false, trigger: 'user', funding: 'own', space: null, metadata: { pipelineId: pipeline.id, nodeKey: 'deploy', attemptId: 'resumed', projectPath: repo } };
  const executor = new ToolExecutor(context, () => {});
  executor.registerTool(shell.getToolHandlers().find(tool => tool.name === 'shell__run')!);
  const result = await executor.handleToolCalls([{ id: rand(8), name: 'shell__run', arguments: { command, cwd: repo, network: true } }]);
  expect(exec).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0][0]).toBe(command); expect(exec.mock.calls[0][1]).toBe(repo);
  expect(result.find(message => message.role === 'tool')?.content).not.toContain('Permission denied');
  const shorthand = "ssh -o BatchMode=yes -o ConnectTimeout=10 root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps'";
  const rewritten = await executor.handleToolCalls([{ id: rand(8), name: 'shell__run', arguments: { command: shorthand, cwd: repo, network: true } }]);
  expect(exec.mock.calls[1][0]).toContain('docker compose -f /opt/stacks/solar-system-map/compose.yaml ps');
  expect(exec.mock.calls[1][0]).not.toContain('cd ');
  expect(rewritten.find(message => message.role === 'tool')?.content).toContain('Anchored to the explicitly approved Compose file');
  const profiles = await import('./pipeline-permissions');
  const originalLookup = profiles.runPermissionProfile;
  let lookups = 0;
  const changed = vi.spyOn(profiles, 'runPermissionProfile').mockImplementation(async caller => {
    if (++lookups === 4) { // initial dispatch, middleware, final authorization, then execution lookup
      await pipelineRepository.updatePipeline(pipeline.id, { metadata: {} });
      return undefined;
    }
    return originalLookup(caller);
  });
  try {
    const refused = await executor.handleToolCalls([{ id: rand(8), name: 'shell__run', arguments: { command: shorthand, cwd: repo, network: true } }]);
    expect(lookups).toBe(4);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(refused.find(message => message.role === 'tool')?.content).toContain('anchor is unavailable');
  } finally { changed.mockRestore(); }

});

test('metadata consent covers named file subsets after resume, with the same stage and data posture', async () => {
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { approvedCallOf, flowConsentOf, withApprovedCalls, askStillAuthorized } = await import('./approved-calls');
  const { observeFlow } = await import('./flow-guard');
  const { routeApprovalFor } = await import('./approval-route');
  const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
  const fresh = (await seedSession({ userId, channelId: rand(8) })).id;
  observeFlow(fresh, { toolId: 'fixture', action: 'read' }, { taints: ['secret'] });
  const scope = { nodeKey: 'deploy', attemptId: 'saved-attempt', hostServices: true };
  const args = { command: 'ssh root@docker-01 "stat --format=%n:%s:%a /stack/rollback/.env /stack/rollback/compose.yaml"', cwd: '/repo', network: true };
  const call = { toolId: 'shell', toolName: 'run', action: 'execute', args };
  const grant = { ...approvedCallOf(call, scope, flowConsentOf(fresh))!, fileMetadataScope: { target: 'root@docker-01', cwd: '/repo', paths: ['/stack/rollback/.env', '/stack/rollback/compose.yaml'] } };
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId: fresh, userId, title: 'backup metadata', type: 'development', status: 'running', metadata: withApprovedCalls({}, [grant]) });
  const caller = { userId, sessionId: fresh, attended: false, metadata: { pipelineId: pipeline.id, ...scope, projectPath: '/repo' } };
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'paused' });
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'running' });
  const subset = { ...call, args: { ...args, command: 'ssh -o BatchMode=yes root@docker-01 "stat -c %s /stack/rollback/.env"' } };
  expect(await routeApprovalFor(caller, subset, { level: 'ASK', source: 'flow-guard' })).toMatchObject({ route: 'execute' });
  expect(await askStillAuthorized('pipeline-approval', caller, subset, 'flow-guard')).toBe(true);
  for (const command of ['ssh root@docker-01 "cat /stack/rollback/.env"', 'ssh root@docker-01 "stat -c %s /stack/live/.env"']) {
    expect(await routeApprovalFor(caller, { ...call, args: { ...args, command } }, { level: 'ASK', source: 'flow-guard' })).not.toMatchObject({ route: 'execute' });
  }
  expect(await routeApprovalFor({ ...caller, metadata: { ...caller.metadata, nodeKey: 'qa' } }, subset, { level: 'ASK', source: 'flow-guard' })).not.toMatchObject({ route: 'execute' });
  observeFlow(fresh, { toolId: 'fixture', action: 'read-new' }, { taints: ['private'] });
  expect(await routeApprovalFor(caller, subset, { level: 'ASK', source: 'flow-guard' })).not.toMatchObject({ route: 'execute' });
});

test('exact human flow consent survives stages/resume while new data posture requires fresh consent', async () => {
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
  const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
  const { rememberRunDecision } = await import('./pipeline-permissions');
  const { observeFlow } = await import('./flow-guard');
  const { routeApprovalFor } = await import('./approval-route');
  const { askStillAuthorized, flowConsentOf } = await import('./approved-calls');
  const fresh = (await seedSession({ userId, channelId: rand(8) })).id;
  const profile = pipelinePermissionProfileSchema.parse({ repoPath: '/repo', overnight: true });
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId: fresh, userId, title: 'flow receipt', type: 'development', status: 'running', metadata: { permissionProfile: { profile, repoPath: '/repo', approvedBy: userId } } });
  const caller = { userId, sessionId: fresh, attended: false, metadata: { pipelineId: pipeline.id, nodeKey: 'implement', attemptId: 'one', projectPath: '/repo' } };
  const call = { toolId: 'shell', toolName: 'run', action: 'execute', args: { command: 'curl --data fixed https://approved.example/hook' } };
  await rememberRunDecision(caller, call, flowConsentOf(fresh));
  observeFlow(fresh, { toolId: 'fixture', action: 'read' }, { taints: ['secret'] });
  expect(await routeApprovalFor(caller, call, { level: 'ASK', source: 'flow-guard' })).toMatchObject({ route: 'deny' });
  await rememberRunDecision(caller, call, flowConsentOf(fresh)); // a new explicit human decision under the secret posture
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'paused' });
  await pipelineRepository.updatePipeline(pipeline.id, { status: 'running' });
  const resumed = { ...caller, metadata: { ...caller.metadata, nodeKey: 'qa', attemptId: 'two' } };
  expect(await routeApprovalFor(resumed, call, { level: 'ASK', source: 'flow-guard' })).toMatchObject({ route: 'execute' });
  expect(await askStillAuthorized('pipeline-approval', resumed, call, 'flow-guard')).toBe(true);
  expect(await askStillAuthorized('pipeline-approval', resumed, { ...call, args: { command: call.args.command + '?different' } }, 'flow-guard')).toBe(false);
});

test.each(['secret', 'private'] as const)('a %s flag gained while approval waits is not silently included in its receipt', async flag => {
  const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
  const { getPermissionManager } = await import('./permissions');
  const { observeFlow } = await import('./flow-guard');
  const { rememberRunDecision } = await import('./pipeline-permissions');
  const { askStillAuthorized } = await import('./approved-calls');
  const fresh = (await seedSession({ userId, channelId: rand(8) })).id;
  const profile = pipelinePermissionProfileSchema.parse({ repoPath: '/repo', overnight: true });
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId: fresh, userId, title: 'prompt posture', type: 'development', status: 'running', metadata: { permissionProfile: { profile, repoPath: '/repo', approvedBy: userId } } });
  const caller = { userId, sessionId: fresh, workspaceId: null, metadata: { pipelineId: pipeline.id, nodeKey: 'test', attemptId: 'one', projectPath: '/repo' } };
  const args = { command: 'curl --data fixed https://approved.example/hook' };
  const pm = getPermissionManager();
  const id = await pm.requestApproval(userId, 'prompt-worker', 'shell', 'execute', args, fresh, 'run');
  observeFlow(fresh, { toolId: 'fixture', action: 'read' }, { taints: [flag] });
  await pm.approve(id, userId);
  const consent = await pm.getApprovedFlowConsent(id, caller);
  expect(consent?.[flag]).toBe(false);
  const call = { toolId: 'shell', toolName: 'run', action: 'execute', args };
  await rememberRunDecision(caller, call, consent);
  expect(await askStillAuthorized(`approval:${id}`, caller, call, 'flow-guard')).toBe(false);
  expect(await askStillAuthorized('pipeline-approval', caller, call, 'flow-guard')).toBe(false);
  await pm.waitForApproval(id, { agentId: 'prompt-worker' });
});

test('native CLI approval refuses a credential flag gained while its prompt waits', async () => {
  const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
  const { getPermissionManager } = await import('./permissions');
  const { observeFlow } = await import('./flow-guard');
  const { answerCliPermissionRequest } = await import('@/core/cli-permissions');
  const fresh = (await seedSession({ userId, channelId: rand(8) })).id;
  const now = new Date();
  const context: import('@/core/types').AgentContext = { id: 'native-prompt-worker', userId, sessionId: fresh, workspaceId: null, role: 'coding', topic: 'coding', model: 'fixture', status: 'running', createdAt: now, updatedAt: now, attended: true, trigger: 'user', funding: 'own', space: null, metadata: {} };
  const pm = getPermissionManager(); await pm.setPermission(userId, 'cli-native:Bash', 'Bash', 'ASK');
  const stop = pm.onRequest(request => {
    observeFlow(fresh, { toolId: 'fixture', action: 'read' }, { taints: ['secret'] });
    void pm.approve(request.requestId, userId);
  });
  try {
    const result = await answerCliPermissionRequest({ type: 'control_request', request_id: 'native-posture', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'curl --data fixed https://approved.example/hook' } } }, context, () => {});
    expect(result).toMatchObject({ response: { response: { behavior: 'deny' } } });
  } finally { stop(); }
});

test('a Review health GET with a fallback marker uses original consent and executes the static command', async () => {
  const { ShellTool } = await import('@/tools/shell');
  const { ToolExecutor } = await import('@/core/tool-executor');
  const { observeFlow } = await import('./flow-guard');
  const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
  const { getPermissionManager } = await import('./permissions');
  const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
  const repo = '/home/patrice/docker-services/solar-system-map';
  const command = 'curl --fail --silent --show-error --max-time 20 http://192.168.1.156:3002/api/health';
  const annotated = command + '\n# octipus-fallback: approved public health GET';
  const profile = pipelinePermissionProfileSchema.parse({ repoPath: repo, commands: [command], overnight: true });
  const pipeline = await pipelineRepository.create({ rootAgentId: 'root', sessionId, userId, title: 'Review health comment regression', type: 'development', status: 'running', metadata: { permissionProfile: { profile, repoPath: repo, approvedBy: userId } } });
  const exec = vi.fn<import('@/tools/shell/operations').ShellOperations['exec']>(async () => ({ exitCode: 0, stdout: '{}', stderr: '', killed: false, timedOut: false, aborted: false, signal: null }));
  const shell = new ShellTool({ exec, spawnBackground: async () => ({ pid: undefined }), which: async () => null, getEnv: async () => ({}) });
  await shell.initialize();
  await getPermissionManager().setPermission(userId, 'shell', 'execute', 'ASK');
  observeFlow(sessionId, { toolId: 'fixture', action: 'read' }, { taints: ['secret'] });
  const now = new Date();
  const context: import('@/core/types').AgentContext = { id: 'review-worker', userId, sessionId, workspaceId: null, role: 'coding', topic: 'coding', model: 'fixture', status: 'running', createdAt: now, updatedAt: now, attended: false, trigger: 'user', funding: 'own', space: null, metadata: { pipelineId: pipeline.id, nodeKey: 'n2', attemptId: 'review', projectPath: repo } };
  const executor = new ToolExecutor(context, () => {});
  executor.registerTool(shell.getToolHandlers().find(tool => tool.name === 'shell__run')!);
  const result = await executor.handleToolCalls([{ id: rand(8), name: 'shell__run', arguments: { command: annotated, cwd: repo, network: true } }]);
  expect(exec).toHaveBeenCalledOnce();
  expect(exec.mock.calls[0][0]).toBe(command);
  expect(exec.mock.calls[0][2]?.unsafe).toBe(false);
  expect(result.find(message => message.role === 'tool')?.content).toContain('without its fallback comment');
  expect((await pipelineRepository.findById(pipeline.id))?.metadata?.deniedRequests).toBeUndefined();
});
