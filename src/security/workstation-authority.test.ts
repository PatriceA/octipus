import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '@/config';
import { executionEnvironmentSchema, workstationAutomationPreset } from '@/shared/execution-environment';
import { hasAccountAuthority, hasPipelineAutonomy } from './execution-environments';
import { environmentShellOptions, resolveEnvironmentCwd } from './environment-runtime';
import { nativeCliEnvironment } from './environment-identity';
import { installedProgramPaths } from './runtime-path';
import { ENVIRONMENT_INVENTORY_PROGRAM } from './environment-inventory';
import { WorkspaceFS } from './workspace-fs';
import { buildAgentContext } from '@/core/agent/context';
import { LocalShellOperations } from '@/tools/shell/local-operations';
import { routeApprovalFor } from './approval-route';
import { approvesUnattended } from '@/core/agent/pipeline-manager';
const original = getConfig().security.executionEnvironments;
const userId = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'account-authority-')); dirs.push(dir); return dir; };
afterEach(() => { getConfig().security.executionEnvironments = original; vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function configure(root = directory()) {
  const profile = { ...workstationAutomationPreset(userId, 'workstation', [root]), isDefault: true };
  getConfig().security.executionEnvironments = [profile];
  const caller = buildAgentContext({ id: 'workstation-worker', userId, sessionId: 'workstation-test', role: 'general', topic: 'general', model: 'fixture', status: 'running', attended: false,
    scope: { workspaceId: null, space: null, trigger: 'schedule', funding: 'own' }, metadata: { executionEnvironmentId: profile.id, projectPath: root } });
  return { profile, caller, root };
}
test('the workstation preset is one grant for commands, account access, remote work and pipeline consent', () => {
  const { profile, caller } = configure();
  expect(profile).toMatchObject({ authority: 'account', installedPrograms: 'all', hostIdentity: true, hostServices: true, background: 'automatic', approval: 'automatic', network: true, allowDataTransfer: true });
  expect(hasPipelineAutonomy(caller)).toBe(true);
  expect(approvesUnattended(caller, { autoApproveUnattended: false })).toBe(true);
  getConfig().security.executionEnvironments[0].pipelineAutonomy = false;
  expect(approvesUnattended(caller, { autoApproveUnattended: false })).toBe(false);
});
test('old environments do not acquire account authority or pipeline consent', () => {
  expect(executionEnvironmentSchema.parse({ id: 'old', userId, name: 'Old profile', backend: 'host', roots: [directory()] })).toMatchObject({ authority: 'tools', installedPrograms: 'approved', pipelineAutonomy: false });
});
test('shared and remotely requested work cannot borrow account authority', () => {
  const { caller } = configure();
  expect(hasAccountAuthority({ ...caller, space: {} })).toBe(false);
  expect(hasAccountAuthority({ ...caller, trigger: 'remote' })).toBe(false);
});
test('new remote command forms need no overnight command list; deliberate DENY still wins', async () => {
  const { caller } = configure();
  for (const command of ['ssh tower docker compose up -d', 'oc rollout status deployment/api', 'tea repos list', 'ssh second-machine systemctl restart app']) {
    expect((await routeApprovalFor(caller, { toolId: 'shell', action: 'execute', args: { command } }, { level: 'ASK' })).route).toBe('execute');
  }
  for (const source of ['permission:stored-deny', 'rule']) {
    expect((await routeApprovalFor(caller, { toolId: 'shell', action: 'execute' }, { level: 'DENY', source })).route).toBe('deny');
  }
  expect((await routeApprovalFor(caller, { toolId: 'shell', action: 'execute_elevated' }, { level: 'DENY', source: 'manifest' })).route).toBe('execute');
});
test('account filesystem and cwd match command authority, including another project/worktree', () => {
  const { caller } = configure();
  const other = directory();
  expect(WorkspaceFS.forAgent(caller).resolve(join(other, 'worktree.txt'))).toBe(join(other, 'worktree.txt'));
  expect(resolveEnvironmentCwd(other, caller)).toBe(other);
  getConfig().security.executionEnvironments[0].authority = 'tools';
  getConfig().security.executionEnvironments[0].pipelineAutonomy = false;
  expect(() => WorkspaceFS.forAgent(caller).resolve(join(other, 'worktree.txt'))).toThrow();
  expect(() => resolveEnvironmentCwd(other, caller)).toThrow();
});
test.skipIf(process.platform === 'win32')('installed and newly added programs work together without registering binary names', async () => {
  const { caller, root } = configure();
  const bin = join(root, 'bin'); mkdirSync(bin);
  getConfig().security.executionEnvironments[0].pathDirectories = [bin];
  for (const name of ['gh', 'oc', 'tea', 'future-cli']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' '${name}-works'\n`, { mode: 0o755 });
    const result = await new LocalShellOperations().exec(name, root, environmentShellOptions(caller));
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe(`${name}-works`);
  }
  const native = nativeCliEnvironment(caller, { HOME: '/vendor-home', CODEX_HOME: '/vendor-home/.codex' });
  expect(native.HOME).toBe(homedir()); expect(native.CODEX_HOME).toBe('/vendor-home/.codex');
  expect(native.PATH.split(delimiter)).toContain(bin);
});
test.skipIf(process.platform === 'win32')('program discovery excludes sensitive descendants and symlink targets', () => {
  const home = directory(); vi.stubEnv('HOME', home);
  const bin = join(home, 'bin'); const secret = join(home, '.ssh', 'bin'); mkdirSync(bin); mkdirSync(secret, { recursive: true });
  const key = join(secret, 'key-tool'); writeFileSync(key, 'sensitive', { mode: 0o755 }); symlinkSync(key, join(bin, 'alias'));
  const paths = installedProgramPaths([home, bin, secret].join(delimiter));
  expect(paths).toContain(bin); expect(paths).not.toContain(home); expect(paths).not.toContain(secret); expect(paths).not.toContain(key);
});
test('readiness inventory observes configuration without executing SSH Match commands or claiming authentication', () => {
  const home = directory(); mkdirSync(join(home, '.ssh'));
  const sentinel = join(home, 'should-not-exist');
  writeFileSync(join(home, '.ssh/config'), `Host tower second-machine *.internal\n Match exec "touch ${sentinel}"\n`);
  const scan = spawnSync(process.execPath, ['-e', ENVIRONMENT_INVENTORY_PROGRAM], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  expect(scan.status).toBe(0);
  const result = JSON.parse(scan.stdout);
  expect(result.sshAliases).toEqual(['second-machine', 'tower']); expect(existsSync(sentinel)).toBe(false);
});

test('credential bindings cannot replace the native agent bridge or vendor configuration directory', () => {
  const { profile } = configure();
  for (const variable of ['OCTIPUS_AGENT_KEY', 'OCTIPUS_AGENT_URL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
    expect(executionEnvironmentSchema.safeParse({ ...profile, credentials: [{ variable, secret: 'example' }] }).success).toBe(false);
  }
});
test.skipIf(process.platform === 'win32')('program exposure excludes canonical private directory aliases and custom XDG configuration', () => {
  const home = directory(); vi.stubEnv('HOME', home);
  const privateDir = directory(); const bin = join(privateDir, 'vendor', 'bin'); mkdirSync(bin, { recursive: true });
  symlinkSync(privateDir, join(home, '.config'));
  const custom = directory(); vi.stubEnv('XDG_CONFIG_HOME', custom);
  expect(installedProgramPaths([bin, custom, join(home, '.config/vendor/bin')].join(delimiter))).toEqual([]);
});
