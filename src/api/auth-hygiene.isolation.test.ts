/**
 * Coworking S0b — auth hygiene on the path.
 *
 * Drives the real `/auth` and `/devices` routes against PGlite, with the
 * Postgres-backed KV store:
 *
 *   - Register writes a `user_created` audit row; login writes `login` on
 *     success and `login_failed` (with the reason) on failure.
 *   - Login and register accept a same-origin `returnTo`, echo it back, and
 *     refuse anything else before doing any work.
 *   - A device pairing code is stored only as `sha256(code)` and redeems once,
 *     even under two concurrent requests.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const aliceId = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'Correct-horse-1';

let app: ElysiaLike;
let queryRaw: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-auth-hygiene-'));

  const db = await import('@/db/postgres');
  await db.initializeDb();
  queryRaw = db.queryRaw as typeof queryRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  // Pairing codes go through the Postgres-backed KV store (`kv_store`).
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  // A first user exists, so registrations below are not the admin bootstrap.
  await seedUsers([{ id: aliceId, username: 'alice' }]);

  const { Elysia } = await import('@/api/http');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');
  const { authRoutes } = await import('./routes/auth');
  const { deviceRoutes } = await import('./routes/devices');

  // Alice is signed in when the request says so; everything else is anonymous.
  app = new Elysia()
    .derive(({ request }) => {
      if (request.headers.get('x-test-user') !== 'alice') {
        return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
      }
      const user = { id: aliceId, username: 'alice', isAdmin: false };
      return { user, session: null, principal: principalFromUser(user) };
    })
    .group('/api', (a) => a.use(authRoutes).use(deviceRoutes)) as unknown as ElysiaLike;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await app.handle(new Request(`http://localhost/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'auth-hygiene-test', ...headers },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function auditRows(action: string, username: string) {
  const { rows } = await queryRaw(
    `SELECT user_id, action, resource_type, resource_id, channel_type, user_agent, details
       FROM audit_log WHERE action = $1 AND details->>'username' = $2 ORDER BY created_at`,
    [action, username],
  );
  return rows;
}

describe('register and login write audit rows', () => {
  test('register writes user_created for the new user', async () => {
    const { status, body } = await post('/auth/register', { username: 'carol', password: PASSWORD });
    expect(status).toBe(200);

    const rows = await auditRows('user_created', 'carol');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: body.id,
      resource_type: 'user',
      resource_id: body.id,
      channel_type: 'web',
      user_agent: 'auth-hygiene-test',
    });
    expect(rows[0].details).toMatchObject({ selfRegistered: true, isAdmin: false });
  });

  test('a successful login writes login; a bad password and an unknown user write login_failed', async () => {
    await post('/auth/register', { username: 'dave', password: PASSWORD });

    expect((await post('/auth/login', { username: 'dave', password: 'Wrong-pass-1' })).status).toBe(401);
    expect((await post('/auth/login', { username: 'nobody', password: PASSWORD })).status).toBe(401);
    const ok = await post('/auth/login', { username: 'dave', password: PASSWORD });
    expect(ok.status).toBe(200);

    const success = await auditRows('login', 'dave');
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({ user_id: ok.body.user.id, channel_type: 'web' });

    const failed = await auditRows('login_failed', 'dave');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ user_id: ok.body.user.id });
    expect(failed[0].details).toMatchObject({ reason: 'bad_password' });

    const unknown = await auditRows('login_failed', 'nobody');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ user_id: null, resource_id: null });
    expect(unknown[0].details).toMatchObject({ reason: 'unknown_user' });
  });

  test('a mobile login is audited on its own channel', async () => {
    await post('/auth/register', { username: 'erin', password: PASSWORD });
    expect((await post('/auth/login-mobile', { username: 'erin', password: PASSWORD })).status).toBe(200);
    const rows = await auditRows('login', 'erin');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_type: 'mobile' });
  });
});

describe('returnTo', () => {
  test('login and register echo a same-origin path back, and default to /', async () => {
    const reg = await post('/auth/register', { username: 'frank', password: PASSWORD, returnTo: '/notes?id=1' });
    expect(reg.status).toBe(200);
    expect(reg.body.returnTo).toBe('/notes?id=1');

    const withTarget = await post('/auth/login', { username: 'frank', password: PASSWORD, returnTo: '/chat' });
    expect(withTarget.body.returnTo).toBe('/chat');
    const without = await post('/auth/login', { username: 'frank', password: PASSWORD });
    expect(without.body.returnTo).toBe('/');
  });

  test.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'chat'])(
    'refuses %s before signing in or creating anyone',
    async (returnTo) => {
      const login = await post('/auth/login', { username: 'frank', password: PASSWORD, returnTo });
      expect(login.status).toBe(400);
      const mobile = await post('/auth/login-mobile', { username: 'frank', password: PASSWORD, returnTo });
      expect(mobile.status).toBe(400);

      const username = `ghost${rand(3)}`;
      const reg = await post('/auth/register', { username, password: PASSWORD, returnTo });
      expect(reg.status).toBe(400);
      const { rows } = await queryRaw('SELECT 1 FROM users WHERE username = $1', [username]);
      expect(rows).toHaveLength(0);
    },
  );
});

describe('device pairing codes', () => {
  async function generateCode(): Promise<string> {
    const { status, body } = await post('/devices/pair/generate', {}, { 'x-test-user': 'alice' });
    expect(status).toBe(200);
    return body.code as string;
  }

  test('only sha256(code) is stored', async () => {
    const code = await generateCode();
    const hashed = createHash('sha256').update(code).digest('hex');
    const { rows } = await queryRaw(`SELECT key FROM kv_store WHERE key LIKE 'device:pair:%'`);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain(`device:pair:${hashed}`);
    expect(keys).not.toContain(`device:pair:${code}`);
  });

  test('a code redeems once under two concurrent requests', async () => {
    const code = await generateCode();
    const [a, b] = await Promise.all([
      post('/devices/pair/redeem', { code, deviceName: 'phone-a' }),
      post('/devices/pair/redeem', { code, deviceName: 'phone-b' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const winner = a.status === 200 ? a : b;
    expect(winner.body.user.id).toBe(aliceId);
    expect(typeof winner.body.token).toBe('string');

    // And it stays spent.
    expect((await post('/devices/pair/redeem', { code })).status).toBe(400);
  });
});
