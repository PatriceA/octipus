import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

// /api/health: the probes stay public, the install's state does not. The
// services behind each route are mocked — the gate and the response shapes
// are under test.
const fixture = vi.hoisted(() => ({
  user: null as { id: string; username: string; isAdmin: boolean } | null,
  db: { healthy: false, latency: 3, error: 'connect ECONNREFUSED 10.0.0.5:5432' } as { healthy: boolean; latency?: number; error?: string },
  warn: vi.fn(),
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');
  return {
    apiContext: new App().derive(() => ({
      user: fixture.user,
      session: null,
      principal: fixture.user ? principalFromUser(fixture.user) : ANONYMOUS_PRINCIPAL,
    })),
  };
});
vi.mock('@/utils/logger', () => ({ apiLogger: { warn: fixture.warn, info: vi.fn(), error: vi.fn() } }));
vi.mock('@/db/postgres', () => ({ checkDbHealth: () => Promise.resolve(fixture.db) }));
vi.mock('@/db/cache', () => ({ checkCacheHealth: () => Promise.resolve(fixture.db) }));
vi.mock('@/utils/version', () => ({ getAppVersion: () => '9.9.9' }));
vi.mock('@/core/gateway', () => ({
  getGateway: () => ({
    isRunning: () => true,
    getStatus: () => Promise.resolve({ state: 'running', uptime: 1, startedAt: new Date(), agents: [], health: { database: {}, storage: {} } }),
  }),
}));
vi.mock('@/channels/interface', () => ({
  getUMI: () => ({ getAllChannels: () => [{ type: 'slack', name: 'slack', isConnected: () => true }] }),
}));
vi.mock('@/models/health-checker', () => ({
  getHealthChecker: () => ({
    checkAllProviders: () => Promise.resolve([]),
    checkDirectProvider: () => Promise.resolve({ status: 'healthy' }),
    getSystemHealth: () => Promise.resolve({}),
  }),
}));
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getAllModels: () => Promise.resolve([]),
    getDefaultModel: () => Promise.resolve(null),
    getModelForTopic: () => Promise.resolve(null),
  }),
}));
vi.mock('@/models/providers', () => ({ getProviderRouter: () => ({ getAllProviders: () => [] }) }));
vi.mock('@/api/browser-bridge', () => ({ getBrowserBridge: () => ({ connected: false }) }));
import { healthRoutes } from './health';
import { isPublicPath } from '../middleware/auth-guard';

const app = new App().group('/api', (route) => route.use(healthRoutes));
const ADMIN = { id: '00000000-0000-4000-8000-000000000001', username: 'root', isAdmin: true };
const MEMBER = { id: '00000000-0000-4000-8000-000000000002', username: 'alice', isAdmin: false };
const get = async (path: string) => {
  const res = await app.handle(new Request(`http://test/api${path}`));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  fixture.user = null;
  fixture.warn.mockClear();
});

describe('health — public paths (auth-guard)', () => {
  test.each(['/api/health', '/api/health/', '/api/health/live', '/api/health/ready', '/api/health/database', '/api/health/storage'])(
    '%s stays public', (path) => { expect(isPublicPath(path)).toBe(true); });
  test.each(['/api/health/detailed', '/api/health/models', '/api/health/channels', '/api/health/features', '/api/health/time', '/api/health/browser-bridge'])(
    '%s needs a sign-in', (path) => { expect(isPublicPath(path)).toBe(false); });
});

describe('health — admin-only install state', () => {
  test.each(['/health/models', '/health/channels', '/health/features'])('anonymous gets 401 on %s', async (path) => {
    expect((await get(path)).status).toBe(401);
  });
  test.each(['/health/models', '/health/channels', '/health/features'])('non-admin gets 403 on %s', async (path) => {
    fixture.user = MEMBER;
    const r = await get(path);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Admin access required' });
  });
  test.each([['/health/models', 'providers'], ['/health/channels', 'channels'], ['/health/features', 'features']])(
    'admin reads %s', async (path, key) => {
      fixture.user = ADMIN;
      const r = await get(path);
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty(key);
    });
});

describe('health — /detailed', () => {
  test('anonymous gets 401', async () => {
    expect((await get('/health/detailed')).status).toBe(401);
  });
  test('a non-admin gets status and version only', async () => {
    fixture.user = MEMBER;
    const r = await get('/health/detailed');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok', version: '9.9.9' });
  });
  test('an admin gets the per-service breakdown', async () => {
    fixture.user = ADMIN;
    const r = await get('/health/detailed');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('health');
    expect(r.body).toHaveProperty('agents');
  });
});

describe('health — sign-in routes', () => {
  test.each(['/health/time', '/health/browser-bridge'])('anonymous gets 401 on %s', async (path) => {
    expect((await get(path)).status).toBe(401);
  });
  test.each(['/health/time', '/health/browser-bridge'])('a signed-in non-admin reads %s', async (path) => {
    fixture.user = MEMBER;
    expect((await get(path)).status).toBe(200);
  });
});

describe('health — public probes do not leak raw errors', () => {
  test.each(['database', 'storage'])('/health/%s logs the error and leaves it out', async (svc) => {
    const r = await get(`/health/${svc}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ service: svc, status: 'unhealthy', latency: 3 });
    expect(JSON.stringify(r.body)).not.toContain('ECONNREFUSED');
    expect(fixture.warn).toHaveBeenCalledWith({ error: 'connect ECONNREFUSED 10.0.0.5:5432' }, `${svc} health check failed`);
  });
});
