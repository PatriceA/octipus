/**
 * `/api/modules` (docs/MODULES.md): every signed-in user reads what is on;
 * only admins switch, and a refused change is a 409.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';

const fixture = vi.hoisted(() => ({
  user: null as { id: string; username: string; isAdmin: boolean } | null,
  enabled: [] as string[],
  audit: [] as unknown[],
}));

vi.mock('@/api/context', async () => ({
  apiContext: new (await import('@/api/http')).App().derive(() => ({
    user: fixture.user,
    principal: fixture.user ? principalFromUser(fixture.user) : { kind: 'anonymous' },
  })),
}));
vi.mock('@/config', () => ({ getConfig: () => ({ modules: { enabled: fixture.enabled } }) }));
vi.mock('@/config/settings-service', () => ({
  getSettingsService: () => ({
    update: async (_key: string, change: (v: unknown) => unknown) => {
      fixture.enabled = change(fixture.enabled) as string[];
      return fixture.enabled;
    },
  }),
}));

vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async (entry: unknown) => { fixture.audit.push(entry); } } }));
vi.mock('@/modules', async () => {
  const real = await vi.importActual<typeof import('@/modules')>('@/modules');
  const needsMail = { id: 'needs-mail', title: 'Needs mail', description: '', profiles: [], dependsOn: ['mail'], routes: [], pages: [], tools: [], jobs: [], caseEntities: [] };
  return { MODULES: [...real.MODULES, needsMail] };
});

const { moduleRoutes } = await import('./modules');
const app = new App().use(moduleRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://test${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', isAdmin: true };
const MEMBER = { id: '22222222-2222-4222-8222-222222222222', username: 'member', isAdmin: false };

beforeEach(() => { fixture.enabled = []; fixture.user = null; fixture.audit = []; });

describe('/api/modules', () => {
  test('signed out: 401', async () => {
    expect((await call('GET', '/modules')).status).toBe(401);
  });

  test('a member reads what is on but cannot switch', async () => {
    fixture.user = MEMBER;
    fixture.enabled = ['mail'];
    const res = await call('GET', '/modules');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toEqual(['mail']);
    expect(res.body.modules.find((m: { id: string }) => m.id === 'mail').on).toBe(true);
    expect((await call('PUT', '/modules/business', { on: true })).status).toBe(403);
    expect(fixture.enabled).toEqual(['mail']);
  });

  test('an admin switches; unknown modules are 404', async () => {
    fixture.user = ADMIN;
    const res = await call('PUT', '/modules/business', { on: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toEqual(['business']);
    expect((await call('PUT', '/modules/business', { on: false })).body.enabled).toEqual([]);
    expect((await call('PUT', '/modules/nope', { on: true })).status).toBe(404);
    expect(fixture.audit).toHaveLength(2);
    expect(fixture.audit[0]).toMatchObject({ action: 'settings_changed', details: { module: 'business', on: true } });
  });

  test('enable turns on several (with dependencies) and turns nothing off; admins only', async () => {
    fixture.user = MEMBER;
    expect((await call('POST', '/modules/enable', { ids: ['business'] })).status).toBe(403);
    fixture.user = ADMIN;
    fixture.enabled = ['protection'];
    const res = await call('POST', '/modules/enable', { ids: ['business', 'needs-mail'] });
    expect(res.status).toBe(200);
    expect(fixture.enabled).toEqual(['business', 'mail', 'protection', 'needs-mail']);
    expect((await call('POST', '/modules/enable', { ids: ['nope'] })).status).toBe(404);
  });

  test('on brings its dependencies; off is a 409 while something needs it', async () => {
    fixture.user = ADMIN;
    expect((await call('PUT', '/modules/needs-mail', { on: true })).body.enabled).toEqual(['mail', 'needs-mail']);
    const refused = await call('PUT', '/modules/mail', { on: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/needs-mail needs mail/);
    expect(fixture.enabled).toEqual(['mail', 'needs-mail']);
  });
});
