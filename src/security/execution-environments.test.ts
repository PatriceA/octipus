import { afterEach, describe, expect, it } from 'vitest';
import { getConfig } from '@/config';
import { executionEnvironmentSchema, executionEnvironmentsSchema } from '@/shared/execution-environment';
import { executionEnvironmentFor, pathInEnvironment, withExecutionEnvironment, activeHostServiceEnvironment } from './execution-environments';
import { environmentCwd, environmentShellOptions } from './environment-runtime';

const userId = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const original = getConfig().security.executionEnvironments;
afterEach(() => { getConfig().security.executionEnvironments = original; });
const profile = (extra = {}) => executionEnvironmentSchema.parse({ id: 'host', name: 'Computer', userId, backend: 'host', roots: ['/projects'], ...extra });
const caller = (extra = {}) => ({ userId, metadata: {}, ...extra });

describe('execution environments', () => {
  it('preserves existing installations until a profile is configured', () => {
    getConfig().security.executionEnvironments = [];
    expect(executionEnvironmentFor(caller())).toBeUndefined();
  });
  it('selects longest project match, then workspace default, then account default', () => {
    getConfig().security.executionEnvironments = [profile({ isDefault: true }), profile({ id: 'project', roots: ['/projects/app'] }), profile({ id: 'workspace', roots: ['/elsewhere'], workspaceId: other, isDefault: true })];
    expect(executionEnvironmentFor(caller({ metadata: { projectPath: '/projects/app/src' } }))?.id).toBe('project');
    expect(executionEnvironmentFor(caller({ workspaceId: other }))?.id).toBe('workspace');
    expect(executionEnvironmentFor(caller())?.id).toBe('host');
  });
  it('rejects ambiguity instead of selecting an arbitrary machine', () => {
    getConfig().security.executionEnvironments = [profile(), profile({ id: 'remote', backend: 'ssh', ssh: { host: 'server', user: 'deploy' } })];
    expect(() => executionEnvironmentFor(caller({ metadata: { projectPath: '/projects/a' } }))).toThrow('Multiple');
  });
  it('never inherits another owner or workspace identity', () => {
    getConfig().security.executionEnvironments = [profile({ userId: other, isDefault: true }), profile({ id: 'scoped', workspaceId: other })];
    expect(executionEnvironmentFor(caller())).toBeUndefined();
    expect(() => executionEnvironmentFor(caller({ metadata: { executionEnvironmentId: 'host' } }))).toThrow('unavailable');
    expect(() => executionEnvironmentFor(caller({ metadata: { executionEnvironmentId: 'scoped' } }))).toThrow('unavailable');
  });
  it('revokes a pinned environment without falling back to legacy or another default', () => {
    getConfig().security.executionEnvironments = [profile({ enabled: false }), profile({ id: 'alternative', isDefault: true })];
    expect(() => executionEnvironmentFor(caller({ metadata: { executionEnvironmentId: 'host' } }))).toThrow('disabled');
    expect(() => executionEnvironmentFor(caller({ metadata: { projectPath: '/projects/app' } }))).not.toThrow();
  });
  it('does not attach personal environments to shared spaces', () => {
    getConfig().security.executionEnvironments = [profile({ isDefault: true, hostServices: true })];
    expect(executionEnvironmentFor(caller({ space: { workspaceId: other } }))).toBeUndefined();
    expect(withExecutionEnvironment(caller({ space: {} }), () => activeHostServiceEnvironment(userId))).toBeUndefined();
  });
  it('requires an active owner-scoped trusted host grant to lift Docker isolation', () => {
    getConfig().security.executionEnvironments = [profile({ isDefault: true, hostServices: true })];
    expect(activeHostServiceEnvironment(userId)).toBeUndefined();
    withExecutionEnvironment(caller(), () => {
      expect(activeHostServiceEnvironment(userId)?.id).toBe('host');
      expect(activeHostServiceEnvironment(other)).toBeUndefined();
    });
  });
  it('contains descendants without accepting sibling prefixes or traversal', () => {
    expect(pathInEnvironment('/projects/a', '/projects/a/src')).toBe(true);
    expect(pathInEnvironment('/projects/a', '/projects/ab')).toBe(false);
    expect(pathInEnvironment('/projects/a', '/projects/a/../../etc')).toBe(false);
    expect(() => environmentCwd(profile(), '/etc')).toThrow('outside');
  });
  it('requires isolation even when the install otherwise runs commands on the host', () => {
    getConfig().security.executionEnvironments = [profile({ backend: 'sandbox', isDefault: true })];
    expect(environmentShellOptions(caller())).toMatchObject({ sandboxMode: 'required', inheritHostIdentity: false, allowHostSshAgent: false });
  });
  it('rejects inconsistent identities, duplicate defaults and runtime-control bindings', () => {
    expect(() => profile({ backend: 'sandbox', hostIdentity: true })).toThrow();
    expect(() => profile({ backend: 'ssh' })).toThrow();
    expect(() => profile({ credentials: [{ variable: 'NODE_OPTIONS', secret: 'secret' }] })).toThrow();
    expect(() => executionEnvironmentsSchema.parse([profile({ isDefault: true }), profile({ id: 'another', isDefault: true })])).toThrow();
  });
});
