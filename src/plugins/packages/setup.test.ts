import { beforeEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ environments: [{ id: 'env', name: 'Workstation', enabled: true, backend: 'host', userId: 'owner', workspaceId: null, roots: ['/projects'] }], connections: [{ id: 'tracker', userId: 'owner', workspaceId: null, credential: 'vault-ref', http: { origin: 'https://example.com', pathPrefix: '/api', git: false }, stdio: [] }] }));
vi.mock('@/security/execution-environments', async original => ({ ...await original<typeof import('@/security/execution-environments')>(), configuredExecutionEnvironments: () => state.environments }));
vi.mock('@/security/credential-connections', async original => ({ ...await original<typeof import('@/security/credential-connections')>(), readAvailableConnectionProfiles: async () => state.connections }));
import { parseManifest } from './manifest';
import { setupConfiguration, setupResources, validateSetupSettings } from './setup';
import { pluginCapabilityPreflight } from './authoring/preflight';
import { repositoryRemotePath } from './setup-repositories';
const base = { name: 'guided-test', version: '1.0.0', apiVersion: '1.2.0', title: 'Guided', description: 'Guided setup', server: { command: 'node', args: ['server.mjs'] }, tools: { health: { effect: 'read' } } };
beforeEach(() => { state.environments[0].enabled = true; });
test('declarations reject write tests, unknown resources and publisher-chosen classification', () => {
 expect(() => parseManifest({ ...base, tools: { health: { effect: 'write' } }, setup: { check: { tool: 'health' } } })).toThrow(/read-only/);
 expect(() => parseManifest({ ...base, setup: { resources: [{ setting: 'missing', kind: 'folder' }] } })).toThrow(/must name/);
 expect(() => parseManifest({ ...base, settings: [{ key: 'level', label: 'Level', type: 'text' }], setup: { defaults: { level: '1' }, resources: [{ setting: 'level', kind: 'protection' }] } })).toThrow(/classification/);
});
test('compatibility is checked before building without changing the requested level', () => {
 expect(pluginCapabilityPreflight({ protectionLevel: 2, interface: 'page', host: [] })).toMatchObject({ compatible: false, requestedProtection: 2, supportedProtection: 1 });
 expect(pluginCapabilityPreflight({ protectionLevel: 3, interface: 'tools', host: ['store:read'] })).toMatchObject({ compatible: true });
});
test('discovery returns public metadata only and disabled environments disappear', async () => {
 const caller = { userId: 'owner', workspaceId: null };
 expect(JSON.stringify(await setupResources(caller))).not.toContain('vault-ref');
 state.environments[0].enabled = false;
 expect((await setupResources(caller)).environments).toHaveLength(0);
 expect(await setupResources({ ...caller, space: true })).toEqual({ environments: [], connections: [] });
});
test('resource revocation and unsupported classification fail preflight instead of installing', async () => {
 const manifest = parseManifest({ ...base, ui: { pages: [{ title: 'Main', path: 'main', entry: 'index.html' }] }, settings: [{ key: 'folder', label: 'Folder', type: 'text' }, { key: 'level', label: 'Level', type: 'text' }], setup: { resources: [{ setting: 'folder', kind: 'folder' }, { setting: 'level', kind: 'protection' }] } });
 const caller = { userId: 'owner', workspaceId: null };
 await expect(validateSetupSettings(manifest, { folder: '/outside' }, caller)).rejects.toThrow(/outside/);
 await expect(validateSetupSettings(manifest, { level: '2' }, caller)).rejects.toThrow(/classification/);
 expect(setupConfiguration(manifest).maxProtection).toBe(1);
});
test('Git origin discovery never exposes username, password or URL query credentials', () => {
 expect(repositoryRemotePath('https://user:synthetic-secret@example.com/group/repo.git?access_token=canary')).toBe('/group/repo.git');
 expect(repositoryRemotePath('git@example.com:group/repo.git')).toBe('/group/repo.git');
 expect(repositoryRemotePath('/local/repo')).toBeNull();
});

test('repository discovery enforces per-path denials and refuses metadata outside approved roots', async () => {
 const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const { execFileSync } = await import('node:child_process');
 const { setupRepositories } = await import('./setup-repositories');
 const root = mkdtempSync(join(tmpdir(), 'setup-repositories-'));
 const outside = mkdtempSync(join(tmpdir(), 'setup-outside-'));
 const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
 try {
   state.environments[0].roots = [root];
   const repo = join(root, 'service'); mkdirSync(repo); git(repo, 'init', '-q');
   const { getPermissionManager } = await import('@/security/permissions');
   const check = vi.spyOn(getPermissionManager(), 'check').mockImplementation(async (_owner, _tool, _action, args) => ({ level: args?.path === join(root, 'private') ? 'DENY' : 'ALLOW', allowed: args?.path !== join(root, 'private'), requiresApproval: false }));
   const hidden = join(root, 'private'); mkdirSync(hidden); mkdirSync(join(hidden, '.git'));
   const found = await setupRepositories({ userId: 'owner' }, 'env', root);
   expect(found).toMatchObject({ repositories: [{ name: 'service' }], hidden: 1 });
   await expect(setupRepositories({ userId: 'owner' }, 'env', root, hidden)).rejects.toThrow(/deny/);
   await expect(setupRepositories({ userId: 'owner' }, 'env', root, outside)).rejects.toThrow(/outside/);
   check.mockRestore();
 } finally { state.environments[0].roots = ['/projects']; rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
