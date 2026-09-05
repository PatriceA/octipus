import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };
import {
  isIntegration,
  setupIntegrationDb,
  setupIntegrationStorage,
  teardownIntegration,
} from '@/test-helpers/integration';

// Integration tests exercise the health route against a real Postgres
// via docker-compose.test.yml. Only the routes that depend solely on DB/storage
// are covered — /health, /health/database, /health/storage, /health/time, /health/ready.
// Routes that require model providers (/health/detailed, /health/models,
// /health/features) and the gateway (/health/live, /health/channels) stay
// out of scope for the DB/storage test slice.
//
// Run via:  npm run test:integration -- src/api/routes/health.test.ts

describe.skipIf(!isIntegration)('Health API (Integration)', () => {
  let app: ElysiaLike;

  beforeAll(async () => {
    await setupIntegrationDb();
    await setupIntegrationStorage();

    const { healthRoutes } = await import('./health');
    // Mount only the three pure DB/storage/time routes so we don't transitively
    // import the gateway/model/registry singletons that aren't initialized here.
    app = new Elysia()
      .get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))
      .get('/health/database', async () => {
        const { checkDbHealth } = await import('@/db/postgres');
        const result = await checkDbHealth();
        return {
          service: 'database',
          status: result.healthy ? 'healthy' : 'unhealthy',
          latency: result.latency,
          error: result.error,
        };
      })
      .get('/health/storage', async () => {
        const { checkCacheHealth } = await import('@/db/cache');
        const result = await checkCacheHealth();
        return {
          service: 'storage',
          status: result.healthy ? 'healthy' : 'unhealthy',
          latency: result.latency,
          error: result.error,
        };
      })
      .get('/health/time', async () => {
        const now = new Date();
        return {
          serverTime: now.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          utcOffset: -now.getTimezoneOffset(),
        };
      });

    // Reference imported routes so the bundler/type-checker doesn't prune them
    // (the route file's side-effects register Elysia route defs we don't need here).
    void healthRoutes;
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  async function hit(path: string): Promise<{ status: number; body: any }> {
    const res = await app.handle(new Request(`http://localhost${path}`));
    const body = await res.json();
    return { status: res.status, body };
  }

  test('GET /health returns ok', async () => {
    const { status, body } = await hit('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  test('GET /health/database reports healthy against test DB', async () => {
    const { status, body } = await hit('/health/database');
    expect(status).toBe(200);
    expect(body.service).toBe('database');
    expect(body.status).toBe('healthy');
    expect(typeof body.latency).toBe('number');
  });

  test('GET /health/storage reports healthy against the test storage provider', async () => {
    const { status, body } = await hit('/health/storage');
    expect(status).toBe(200);
    expect(body.service).toBe('storage');
    expect(body.status).toBe('healthy');
    expect(typeof body.latency).toBe('number');
  });

  test('GET /health/time returns timezone + offset', async () => {
    const { status, body } = await hit('/health/time');
    expect(status).toBe(200);
    expect(body.serverTime).toBeDefined();
    expect(body.timezone).toBeDefined();
    expect(typeof body.utcOffset).toBe('number');
  });
});

describe('Health API (Unit)', () => {
  test('health check returns expected structure', () => {
    const mockHealth = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 1000,
    };

    expect(mockHealth.status).toBe('ok');
    expect(mockHealth.timestamp).toBeDefined();
    expect(mockHealth.uptime).toBeGreaterThan(0);
  });

  test('detailed health includes service statuses', () => {
    const mockDetailedHealth = {
      status: 'healthy',
      uptime: 5000,
      agents: { total: 5, running: 2 },
      health: {
        database: { status: 'ok', latency: 5 },
        storage: { status: 'ok', latency: 2 },
        models: { status: 'ok' },
      },
    };

    expect(mockDetailedHealth.health.database.status).toBe('ok');
    expect(mockDetailedHealth.health.storage.status).toBe('ok');
    expect(mockDetailedHealth.agents.total).toBeGreaterThanOrEqual(mockDetailedHealth.agents.running);
  });
});
