import { expect, it, vi } from 'vitest';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';
const user = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', isAdmin: true };
const fixture = vi.hoisted(() => ({ principal: {} as unknown }));
vi.mock('@/api/context', async () => ({ apiContext: new (await import('@/api/http')).App().derive(() => ({ user, principal: fixture.principal })) }));
const { sessionRoutes } = await import('./sessions');
const app = new App().use(sessionRoutes);
it('a read-only API token cannot change runtime or project paths', async () => {
  fixture.principal = { ...principalFromUser(user), scopes: ['api:read'] };
  const response = await app.handle(new Request('http://test/sessions/33333333-3333-4333-8333-333333333333/execution-environment', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environmentId: 'host', projectPath: '/elsewhere' }) }));
  expect(response.status).toBe(403); expect((await response.json()).error).toContain('Chat scope');
});
