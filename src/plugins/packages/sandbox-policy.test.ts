/**
 * `plugins.sandbox` (docs/PLUGIN-PACKAGES.md#the-sandbox): a plugin package
 * runs in a sandbox runner unless the setting is off and it is not from the
 * marketplace; where a runner is required and none works, it does not run,
 * and the declarations never say "sandboxed" or "no network" where that is
 * not enforced on this host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getConfig } from '@/config';
import { defaultConfig } from '@/config/defaults';
import { configSchema } from '@/config/schema';
import { _forceNoSandboxRunnerForTests, _forceSandboxRunnerForTests, _resetSandboxDetectionForTests, sandboxRunnerHelp } from '@/security/shell-sandbox';
import { declarationItems, guidanceTone } from '@/shared/plugin-declarations';
import { computePermissions } from './permissions';
import { hostEnforcement, pluginSandboxHost, pluginSandboxPlan, pluginSandboxSetting, pluginSandboxView } from './sandbox-policy';

// The test lanes run plugin fixtures with the sandbox off (src/test-setup.ts); this suite sets it itself.
let setting: 'required' | 'off';
beforeEach(() => { setting = getConfig().plugins.sandbox; getConfig().plugins.sandbox = 'required'; });
afterEach(() => {
  _resetSandboxDetectionForTests();
  getConfig().plugins.sandbox = setting;
});

const none = (setting: 'required' | 'off') => ({ setting, runner: null, unavailable: 'no sandbox runner found: install bubblewrap' });
const bwrap = (setting: 'required' | 'off') => ({ setting, runner: 'bwrap' as const, unavailable: null });

describe('plugins.sandbox', () => {
  test('defaults to required, apart from security.shellSandbox (off by default)', () => {
    expect(configSchema.shape.plugins.parse({}).sandbox).toBe('required');
    expect(defaultConfig.plugins?.sandbox).toBe('required');
    expect(configSchema.shape.security.shape.shellSandbox.parse(undefined)).toBe('off');
    expect(pluginSandboxSetting()).toBe('required');
    expect(configSchema.shape.plugins.safeParse({ sandbox: 'auto' }).success).toBe(false);
  });

  test('required: wrapped where a runner works, refused where none does, naming what to install', () => {
    expect(pluginSandboxPlan({ source: 'directory' }, bwrap('required'))).toEqual({ required: true, runner: 'bwrap', problem: null });
    const refused = pluginSandboxPlan({ source: 'directory' }, none('required'));
    expect(refused.runner).toBeNull();
    expect(refused.problem).toMatch(/Not sandboxed on this host.*plugins.sandbox is required.*install bubblewrap/);
  });

  test('off: a local package runs unwrapped; a marketplace package still needs a runner', () => {
    expect(pluginSandboxPlan({ source: 'directory' }, bwrap('off'))).toEqual({ required: false, runner: null, problem: null });
    expect(pluginSandboxPlan(null, none('off'))).toEqual({ required: false, runner: null, problem: null });
    expect(pluginSandboxPlan({ source: 'marketplace' }, bwrap('off'))).toEqual({ required: true, runner: 'bwrap', problem: null });
    expect(pluginSandboxPlan({ source: 'marketplace' }, none('off')).problem).toMatch(/a plugin from the marketplace always runs in a sandbox/);
  });

  test('the host state comes from the runner found, not from security.shellSandbox', () => {
    _forceSandboxRunnerForTests('firejail', '/usr/bin/firejail');
    expect(pluginSandboxHost()).toMatchObject({ setting: 'required', runner: 'firejail', unavailable: null });
    expect(pluginSandboxView().summary).toBe('active runner firejail');
    _resetSandboxDetectionForTests();
    _forceNoSandboxRunnerForTests();
    const host = pluginSandboxHost();
    expect(host.runner).toBeNull();
    expect(host.unavailable).toContain(sandboxRunnerHelp());
    expect(pluginSandboxView().summary).toMatch(/^unavailable: /);
  });

  test('the help names the runner for each platform, and Windows plainly', () => {
    expect(sandboxRunnerHelp('linux')).toMatch(/bubblewrap.*bwrap --ro-bind \/ \/ true.*firejail/);
    expect(sandboxRunnerHelp('darwin')).toMatch(/sandbox-exec/);
    expect(sandboxRunnerHelp('win32')).toMatch(/native Windows plugin runner.*build:sandbox:windows/);
  });
});

describe('the declarations tell the truth about this host', () => {
  const manifest = { name: 'demo-pkg', version: '1.0.0', apiVersion: '1.0.0', title: 'Demo', description: 'Demo', server: { command: 'node', args: ['s.mjs'] }, tools: { t: { effect: 'read' as const } } };
  const offline = computePermissions(manifest);
  const online = computePermissions({ ...manifest, network: ['api.example.com'] });
  const byId = (items: ReturnType<typeof declarationItems>) => new Map(items.map((i) => [i.id, i]));

  test('with a runner: sandboxed, and no network of its own', () => {
    const items = byId(declarationItems(offline, manifest, hostEnforcement({ source: 'directory' }, bwrap('required'))));
    expect(items.get('runtime')?.label).toBe('Runs as a separate program in a sandbox (bwrap)');
    expect(items.get('network:none')?.label).toBe('No network access of its own');
  });

  test('plugins.sandbox off: NOT sandboxed, network not enforced, both as warnings', () => {
    const host = hostEnforcement({ source: 'directory' }, bwrap('off'));
    const items = byId(declarationItems(offline, manifest, host));
    const runtime = items.get('runtime');
    expect(runtime?.label).toBe('NOT sandboxed on this host');
    expect(runtime?.guidance).toMatch(/database URL and master key/);
    const net = items.get('network:none');
    expect(net?.label).toBe('Network not enforced on this host');
    expect(guidanceTone(runtime!)).toBe('warning');
    expect(guidanceTone(net!)).toBe('warning');
    const hosts = byId(declarationItems(online, manifest, host)).get('network:api.example.com');
    expect(hosts?.guidance).toMatch(/^Network not enforced on this host/);
    for (const item of declarationItems(offline, manifest, host)) {
      expect(item.label).not.toMatch(/\bsandboxed program\b|No network access of its own/);
    }
  });

  test('required with no runner: says it does not run here, and why', () => {
    const items = byId(declarationItems(offline, manifest, hostEnforcement({ source: 'marketplace' }, none('off'))));
    expect(items.get('runtime')?.label).toBe('NOT sandboxed on this host, so it does not run here');
    expect(items.get('runtime')?.guidance).toMatch(/install bubblewrap/);
  });

  test('without host information it only says what is declared', () => {
    for (const item of declarationItems(offline, manifest)) expect(item.label).not.toMatch(/sandboxed|No network access of its own/);
  });
});
