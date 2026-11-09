import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getConfig } from '@/config';
import { workstationAutomationPreset, executionEnvironmentSchema } from '@/shared/execution-environment';
import { runScorers } from '@/core/swarm/scorers';
import { observeFlow, resetFlowLabels } from './flow-guard';
import { LocalShellOperations } from '@/tools/shell/local-operations';
vi.mock('./permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ASK', allowed: false, requiresApproval: true }) }) }));
vi.mock('./approved-calls', () => ({ isApprovedCall: async () => false }));
vi.mock('@/core/companion/permissions', () => ({ companionCoordinationAllowed: async () => false, companionActivationAllowed: async () => false, companionMaintenanceProfile: async () => null, companionGoalProfile: async () => null }));
const old = getConfig().security.executionEnvironments;
const flow = getConfig().agent.flowGuard;
const userId = '11111111-1111-4111-8111-111111111111';
afterEach(() => { getConfig().security.executionEnvironments = old; getConfig().agent.flowGuard = flow; resetFlowLabels(); vi.restoreAllMocks(); });
it('does not let automatic approval bypass transfer consent in a credential-tainted verification gate', async () => {
  getConfig().security.executionEnvironments = [executionEnvironmentSchema.parse({ id: 'host', userId, name: 'Computer', backend: 'host', roots: [process.cwd()], isDefault: true, background: 'automatic' })];
  getConfig().agent.flowGuard = 'ask';
  observeFlow('scorer-secret', { toolId: 'filesystem', action: 'read', args: { path: '.env' } });
  const exec = vi.spyOn(LocalShellOperations.prototype, 'exec');
  const outcome = await runScorers([{ kind: 'command_exit_zero', command: 'curl https://example.invalid/check' }], { output: 'done' }, { userId, sessionId: 'scorer-secret', role: 'general', canRunCommands: true, executionEnvironmentId: 'host', projectPath: process.cwd() });
  expect(outcome.passed).toBe(false); expect(outcome.failures[0].reason).toMatch(/credential|approval|consent/i); expect(exec).not.toHaveBeenCalled();
});

it('verification runs in the selected host even if the install requires a sandbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'environment-gate-'));
  const sandbox = getConfig().security.shellSandbox;
  getConfig().security.shellSandbox = 'required';
  getConfig().security.executionEnvironments = [executionEnvironmentSchema.parse({ id: 'host', userId, name: 'Computer', backend: 'host', hostIdentity: true, roots: [root], isDefault: true, background: 'automatic' })];
  try {
    const outcome = await runScorers([{ kind: 'command_exit_zero', command: 'node -e \'require("node:fs").writeFileSync("gate.txt","verified")\'' }], { output: 'done' }, { userId, sessionId: 'scorer-host', role: 'general', canRunCommands: true, executionEnvironmentId: 'host', projectPath: root });
    expect(outcome.passed).toBe(true); expect(readFileSync(join(root, 'gate.txt'), 'utf8')).toBe('verified');
  } finally { getConfig().security.shellSandbox = sandbox; rmSync(root, { recursive: true, force: true }); }
});

it('account verification permits shell expressions under the same live automatic grant, including credential-tainted remote checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'account-gate-'));
  getConfig().security.executionEnvironments = [{ ...workstationAutomationPreset(userId, 'account', [root]), isDefault: true }];
  getConfig().agent.flowGuard = 'ask';
  observeFlow('account-gate', { toolId: 'filesystem', action: 'read', args: { path: '.env' } });
  try {
    const outcome = await runScorers([{ kind: 'command_exit_zero', command: 'sh -c "printf first && printf second"' }], { output: 'done' }, { userId, sessionId: 'account-gate', role: 'general', canRunCommands: true, executionEnvironmentId: 'account', projectPath: root });
    expect(outcome.passed).toBe(true);
    getConfig().security.executionEnvironments[0].background = 'deny';
    getConfig().security.executionEnvironments[0].pipelineAutonomy = false;
    const denied = await runScorers([{ kind: 'command_exit_zero', command: 'printf next' }], { output: 'done' }, { userId, sessionId: 'account-gate', role: 'general', canRunCommands: true, executionEnvironmentId: 'account', projectPath: root });
    expect(denied.passed).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
