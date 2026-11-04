import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixture = vi.hoisted(() => ({ user: { id: 'owner', isAdmin: true } as { id: string; isAdmin: boolean } | null, entries: [] as unknown[], identities: [] as unknown[], audit: vi.fn() }));
vi.mock('@/api/context', async () => ({ apiContext: new (await import('@/api/http')).App().derive(() => ({ user: fixture.user })) }));
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({
  get: async (key: string) => key === 'security.cliKubeconfigs' ? fixture.identities : fixture.entries,
  update: async (key: string, change: (current: unknown) => unknown) => { if (key === 'security.cliKubeconfigs') fixture.identities = change(fixture.identities) as unknown[]; else fixture.entries = change(fixture.entries) as unknown[]; },
}) }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: fixture.audit } }));
const { settingsRoutes } = await import('./settings');
const app = new App().use(settingsRoutes);
const call = (method: string, suffix = '', body?: unknown) => app.handle(new Request(`http://test/settings/cli-tools${suffix}`, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
}));
beforeEach(() => { fixture.user = { id: 'owner', isAdmin: true }; fixture.entries = []; fixture.identities = []; fixture.audit.mockClear(); });
test('only admins can discover, approve or remove host executable runtimes', async () => {
  for (const user of [null, { id: 'member', isAdmin: false }]) {
    fixture.user = user;
    for (const method of ['GET', 'PUT', 'DELETE']) expect((await call(method, method === 'GET' ? '' : '/oc', method === 'PUT' ? { path: '/bin/true' } : undefined)).status).toBe(403);
  }
  expect(fixture.entries).toEqual([]);
});
test('approve, reload and remove are persistent and audited; discovery does not execute the tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-cli-api-'));
  const path = join(dir, 'oc'); const sentinel = join(dir, 'ran');
  writeFileSync(path, `#!/bin/sh\ntouch '${sentinel}'\n`); chmodSync(path, 0o755);
  try {
    expect((await call('PUT', '/oc', { path })).status).toBe(200);
    expect(fixture.entries).toEqual([{ name: 'oc', path, resolvedPath: path }]);
    const state = await (await call('GET')).json();
    expect(state.approved).toEqual([{ name: 'oc', path, resolvedPath: path, available: true }]);
    expect(() => require('node:fs').statSync(sentinel)).toThrow();
    rmSync(path);
    expect((await (await call('GET')).json()).approved[0].available).toBe(false);
    expect((await call('DELETE', '/oc')).status).toBe(200);
    expect(fixture.entries).toEqual([]); expect(fixture.audit).toHaveBeenCalledTimes(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('rejects missing paths, directories and mismatched names without recording an approval', async () => {
  for (const path of ['/nonexistent/octipus-cli/oc', '/tmp', 'relative/oc', '/bin/true']) expect((await call('PUT', '/oc', { path })).status).toBe(400);
  expect(fixture.entries).toEqual([]); expect(fixture.audit).not.toHaveBeenCalled();
});

const kubeCall = (path: string | null) => app.handle(new Request('http://test/settings/cli-tools-kubeconfig', { method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({path}) }));
test('personal kubeconfig selection is owner-bound, metadata-only, removable and admin-controlled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-kube-api-')); const path=join(dir,'config');
  writeFileSync(path, JSON.stringify({'current-context':'test',contexts:[{name:'test',context:{cluster:'cluster',user:'user'}}],clusters:[{name:'cluster',cluster:{server:'https://example.test'}}],users:[{name:'user',user:{token:'synthetic-secret'}}]}));
  try {
    expect((await kubeCall(path)).status).toBe(200);
    expect(fixture.identities).toEqual([{userId:'owner',path,resolvedPath:path,context:'test'}]);
    const state=await (await call('GET')).json();
    expect(state.kubeconfig).toEqual({path,context:'test'});expect(JSON.stringify(state)).not.toContain('synthetic-secret');
    fixture.user={id:'member',isAdmin:false}; expect((await kubeCall(path)).status).toBe(403);
    fixture.user={id:'owner',isAdmin:true};expect((await kubeCall(null)).status).toBe(200);expect(fixture.identities).toEqual([]);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
