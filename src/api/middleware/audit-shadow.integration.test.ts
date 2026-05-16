/**
 * Integration test for the shadow-mode audit middleware.
 *
 * Backed by an ephemeral PGlite instance — no Docker required, runs in
 * the standard `bun test` slice. Verifies:
 *   - state-changing requests insert one audit_log row with action='api_request'
 *   - GET requests are not logged in shadow mode
 *   - skip-list paths (health, webhooks) are not logged
 *   - feature flag (multiuser.auditShadow=false) disables the middleware
 *
 * The test stands up a minimal Elysia app that mirrors the real server's
 * derive() + middleware order so we exercise the full plugin lifecycle
 * rather than mocking.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

// Defensive — bun's test preload (bunfig.test.toml) doesn't fire reliably
// for every invocation path, so seed the security secrets here too. The
// values are random per process and never resemble production keys.
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let app: ElysiaLike;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'octipus-audit-'));
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = dataDir;
  // Single-user installs commonly set MULTIUSER_AUDIT_SHADOW=false in
  // .env; the middleware short-circuits when the flag is off, which
  // would make this whole file pass-by-doing-nothing. Force the flag
  // on for the test and reset cached config so the value is honoured.
  process.env.MULTIUSER_AUDIT_SHADOW = 'true';
  const { resetConfig } = await import('@/config');
  resetConfig();

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { ANONYMOUS_PRINCIPAL } = await import('@/security/principal');
  const { auditShadowMiddleware } = await import('./audit-shadow');

  app = new Elysia()
    .derive(() => ({ principal: ANONYMOUS_PRINCIPAL }))
    .use(auditShadowMiddleware)
    .post('/api/sessions', () => ({ ok: true }))
    .get('/api/sessions', () => ({ ok: true }))
    .delete('/api/sessions/:id', () => ({ ok: true }))
    .post('/api/health/ping', () => ({ ok: true })) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function countAuditRows(): Promise<number> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT COUNT(*)::int AS c FROM audit_log WHERE action='api_request'`);
  return Number(rows[0]?.c ?? 0);
}

async function clearAudit(): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw(`DELETE FROM audit_log WHERE action='api_request'`);
}

describe('audit-shadow middleware (integration)', () => {
  test('POST /api/sessions writes one audit_log row', async () => {
    await clearAudit();
    const res = await app.handle(new Request('http://localhost/api/sessions', { method: 'POST' }));
    expect(res.status).toBe(200);
    // onAfterHandle fires asynchronously alongside the response; give the
    // Elysia microtask a tick to flush before counting.
    await new Promise((r) => setTimeout(r, 5));
    expect(await countAuditRows()).toBe(1);
  });

  test('GET requests are not logged', async () => {
    await clearAudit();
    const res = await app.handle(new Request('http://localhost/api/sessions'));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(await countAuditRows()).toBe(0);
  });

  test('DELETE writes a row tagged with the resource type', async () => {
    await clearAudit();
    const res = await app.handle(new Request('http://localhost/api/sessions/abc', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT resource_type, details FROM audit_log WHERE action='api_request'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_type).toBe('sessions');
    const details = typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
    expect(details.method).toBe('DELETE');
    expect(details.path).toBe('/api/sessions/abc');
  });

  test('health paths are skipped', async () => {
    await clearAudit();
    const res = await app.handle(new Request('http://localhost/api/health/ping', { method: 'POST' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(await countAuditRows()).toBe(0);
  });

  test('feature flag disables the middleware', async () => {
    await clearAudit();
    const { getConfig } = await import('@/config');
    const cfg = getConfig();
    const original = cfg.multiuser.auditShadow;
    cfg.multiuser.auditShadow = false;
    try {
      const res = await app.handle(new Request('http://localhost/api/sessions', { method: 'POST' }));
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 5));
      expect(await countAuditRows()).toBe(0);
    } finally {
      cfg.multiuser.auditShadow = original;
    }
  });

  test('anonymous principal yields null user_id and principalKind=anonymous', async () => {
    await clearAudit();
    await app.handle(new Request('http://localhost/api/sessions', { method: 'POST' }));
    await new Promise((r) => setTimeout(r, 5));

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT user_id, details FROM audit_log WHERE action='api_request'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    const details = typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
    expect(details.principalKind).toBe('anonymous');
  });

  test('writeApiAudit records userId and principalKind for an authenticated principal', async () => {
    await clearAudit();
    const { writeApiAudit } = await import('./audit-shadow');
    const { principalFromUser } = await import('@/security/principal');

    // Need a real user row because audit_log.user_id is text but we want to
    // verify we round-trip a UUID-shaped value when the principal carries one.
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    const userId = '11111111-1111-1111-1111-111111111111';
    await executeRaw(
      `INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'alice-${Date.now()}', false) ON CONFLICT DO NOTHING`,
    );

    await writeApiAudit({
      principal: principalFromUser({ id: userId, username: 'alice', isAdmin: false }),
      method: 'POST',
      pathname: '/api/sessions',
      status: 201,
      durationMs: 7,
      ipAddress: '10.0.0.1',
      userAgent: 'curl/8',
    });

    const { rows } = await queryRaw(
      `SELECT user_id, ip_address, user_agent, details FROM audit_log WHERE action='api_request'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userId);
    expect(String(rows[0].ip_address)).toBe('10.0.0.1');
    expect(rows[0].user_agent).toBe('curl/8');
    const details = typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
    expect(details.principalKind).toBe('user');
    expect(details.status).toBe(201);
  });
});
