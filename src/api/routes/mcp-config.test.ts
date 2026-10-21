import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { MCPConfigConflict } from '@/mcp/config-store';
const fixture = vi.hoisted(() => ({
  user: { id: 'admin', isAdmin: true } as { id: string; isAdmin: boolean } | null,
  getEditableConfig: vi.fn(), editServer: vi.fn(),
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  const { principalFromUser, ANONYMOUS_PRINCIPAL } = await import('@/security/principal');
  return { apiContext: new App().derive(() => ({ user: fixture.user, principal: fixture.user ? principalFromUser({ ...fixture.user, username: fixture.user.id }) : ANONYMOUS_PRINCIPAL })) };
});
vi.mock('@/mcp/bridge', () => ({ getMCPBridge: () => fixture }));
import { mcpRoutes } from './mcp';
const app = new App().group('/api', group => group.use(mcpRoutes));
const request = (method: string, body?: unknown) => app.handle(new Request('http://test/api/mcp/servers/a/config', {
  method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));
beforeEach(() => {
  vi.resetAllMocks(); fixture.user = { id: 'admin', isAdmin: true };
  fixture.editServer.mockResolvedValue(true);
  fixture.getEditableConfig.mockResolvedValue({ id: 'a', revision: 'rev', hasAuthorization: true, envNames: ['TOKEN'] });
});
test.each(['GET', 'PUT'])('%s requires an administrator', async method => {
  fixture.user = null;
  expect((await request(method, method === 'PUT' ? { revision: 'rev' } : undefined)).status).toBe(401);
  fixture.user = { id: 'member', isAdmin: false };
  expect((await request(method, method === 'PUT' ? { revision: 'rev' } : undefined)).status).toBe(403);
  expect(fixture.editServer).not.toHaveBeenCalled();
  expect(fixture.getEditableConfig).not.toHaveBeenCalled();
});
test('accepts a credential replacement without echoing it', async () => {
  const body = { revision: 'rev', authorization: 'Bearer test', sseUrl: 'https://example.com' };
  const response = await request('PUT', body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(fixture.editServer).toHaveBeenCalledWith('a', body);
});
test('rejects invalid edits and reports storage conflicts', async () => {
  expect((await request('PUT', { revision: 'rev', env: { TOKEN: 'bad' } })).status).toBe(400);
  expect(fixture.editServer).not.toHaveBeenCalled();
  fixture.editServer.mockRejectedValue(new MCPConfigConflict('Reload configuration'));
  const response = await request('PUT', { revision: 'rev', authorization: null });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'Reload configuration' });
});
test('missing server returns 404', async () => {
  fixture.getEditableConfig.mockResolvedValue(undefined);
  fixture.editServer.mockResolvedValue(false);
  expect((await request('GET')).status).toBe(404);
  expect((await request('PUT', { revision: 'rev' })).status).toBe(404);
});
