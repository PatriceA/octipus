import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import type { CocoIndexStatus } from '@/shared/cocoindex';

const fixture = vi.hoisted(() => ({
  user: { id: 'admin', isAdmin: true } as { id: string; isAdmin: boolean } | null,
  status: vi.fn(), install: vi.fn(), remove: vi.fn(), resolvePath: vi.fn(),
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  return { apiContext: new App().derive(() => ({ user: fixture.user })) };
});
vi.mock('@/connectors/cocoindex', async importOriginal => {
  const original = await importOriginal<typeof import('@/connectors/cocoindex')>();
  return {
    ...original,
    getCocoIndexService: () => ({ getStatus: fixture.status, install: fixture.install, remove: fixture.remove }),
    resolveCocoIndexWorkspacePath: fixture.resolvePath,
  };
});
import { connectorRoutes } from './connectors';
const app = new App().group('/api', group => group.use(connectorRoutes));
const state: CocoIndexStatus = {
  id: 'cocoindex-code', installed: false, configured: false, workspacePath: '/private/repo',
  status: 'error', error: 'Private install diagnostic',
  progress: { phase: 'install', message: 'Private progress' },
  embedding: { provider: 'sentence-transformers', model: 'test/local-model', local: true },
};
const request = (method: string, suffix = '', body?: unknown) => app.handle(new Request(`http://test/api/connectors/cocoindex${suffix}`, {
  method, headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.user = { id: 'admin', isAdmin: true };
  fixture.status.mockResolvedValue(state);
  fixture.install.mockResolvedValue({ ...state, status: 'installing' });
  fixture.remove.mockResolvedValue({ ...state, status: 'not_installed' });
  fixture.resolvePath.mockResolvedValue('/workspace/repo');
});

test.each(['GET', 'POST', 'DELETE'])('unauthenticated %s cannot inspect or configure CocoIndex', async method => {
  fixture.user = null;
  const response = await request(method, method === 'POST' ? '/install' : '', method === 'POST' ? { workspacePath: '/repo' } : undefined);
  expect(response.status).toBe(401);
  expect(fixture.status).not.toHaveBeenCalled();
  expect(fixture.install).not.toHaveBeenCalled();
  expect(fixture.remove).not.toHaveBeenCalled();
});

test.each(['POST', 'DELETE'])('non-admin %s cannot install or remove the shared connector', async method => {
  fixture.user = { id: 'member', isAdmin: false };
  const response = await request(method, method === 'POST' ? '/install' : '', method === 'POST' ? { workspacePath: '/repo' } : undefined);
  expect(response.status).toBe(403);
  expect(fixture.resolvePath).not.toHaveBeenCalled();
  expect(fixture.install).not.toHaveBeenCalled();
  expect(fixture.remove).not.toHaveBeenCalled();
});

test('member status does not disclose backend paths or install diagnostics', async () => {
  fixture.user = { id: 'member', isAdmin: false };
  const response = await request('GET');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ workspacePath: null, status: 'error' });
  expect(body).not.toHaveProperty('error');
  expect(body).not.toHaveProperty('progress');
});

test('admin installation starts asynchronously using a validated backend path', async () => {
  const response = await request('POST', '/install', { workspacePath: '/repo', embeddingModel: 'test/local-model' });
  expect(response.status).toBe(202);
  expect(fixture.resolvePath).toHaveBeenCalledWith('/repo', 'admin');
  expect(fixture.install).toHaveBeenCalledWith('/workspace/repo', 'test/local-model');
  expect(await response.json()).toMatchObject({ status: 'installing' });
});

test('path validation failure does not launch an installer', async () => {
  fixture.resolvePath.mockRejectedValue(new Error('Workspace path must be under a configured workspace root'));
  const response = await request('POST', '/install', { workspacePath: '/etc' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('configured workspace root') });
  expect(fixture.install).not.toHaveBeenCalled();
});

test('a missing workspace path is rejected before installation', async () => {
  const response = await request('POST', '/install', {});
  expect(response.status).toBe(422);
  expect(fixture.install).not.toHaveBeenCalled();
});

test('admin removal uses the managed service instead of OAuth disconnect', async () => {
  const response = await request('DELETE');
  expect(response.status).toBe(200);
  expect(fixture.remove).toHaveBeenCalledOnce();
});

test('failed removal is reported as failure rather than disconnected success', async () => {
  fixture.remove.mockRejectedValue(new Error('Could not persist MCP configuration'));
  const response = await request('DELETE');
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Could not persist MCP configuration' });
});

test('status inspection failures do not leak private diagnostics to a member', async () => {
  fixture.user = { id: 'member', isAdmin: false };
  fixture.status.mockRejectedValue(new Error('Private executable path'));
  const response = await request('GET');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Could not inspect CocoIndex connector' });
});
