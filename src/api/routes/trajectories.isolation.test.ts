/**
 * Route-level cross-tenant isolation test for /api/trajectories.
 *
 * Pre-Phase-1a, /api/trajectories/ listed every user's trajectory runs
 * because the route never set the userId filter on the unscoped repo.
 * Now the scoped repo enforces it; admins still see everything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceApp: ElysiaLike;
let adminApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
const adminId = '33333333-3333-3333-3333-333333333333';
let aliceTrajId: string;
let bobTrajId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-traj-iso-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  // Seed via raw SQL — see multiuser-fixtures.ts for why we don't go
  // through repository singletons here.
  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
    { id: adminId, username: 'root', isAdmin: true },
  ]);
  const aliceSession = await seedSession({ userId: aliceId, channelId: 'a-1' });
  const bobSession = await seedSession({ userId: bobId, channelId: 'b-1' });

  await executeRaw(
    `INSERT INTO trajectory_runs (user_id, root_session_id, outcome, started_at, ended_at, total_tokens, jsonl_path, jsonl_line)
     VALUES
       ('${aliceId}', '${aliceSession.id}', 'success', now(), now(), 100, '/tmp/a.jsonl', 1),
       ('${bobId}',   '${bobSession.id}',   'success', now(), now(), 100, '/tmp/b.jsonl', 1)`,
  );
  const { rows } = await queryRaw(`SELECT id, user_id FROM trajectory_runs`);
  aliceTrajId = rows.find((r: any) => r.user_id === aliceId).id;
  bobTrajId = rows.find((r: any) => r.user_id === bobId).id;

  const { trajectoryRoutes } = await import('./trajectories');
  const { principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string, isAdmin: boolean): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: 'u', isAdmin };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(trajectoryRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId, false);
  adminApp = buildApp(adminId, true);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/trajectories', () => {
  test('alice sees only her own trajectory runs', async () => {
    const r = await get(aliceApp, '/api/trajectories');
    expect(r.body.trajectories.find((t: any) => t.id === bobTrajId)).toBeUndefined();
    expect(r.body.trajectories.find((t: any) => t.id === aliceTrajId)).toBeDefined();
  });

  test('admin sees every user’s runs', async () => {
    const r = await get(adminApp, '/api/trajectories');
    const ids = r.body.trajectories.map((t: any) => t.id);
    expect(ids).toContain(aliceTrajId);
    expect(ids).toContain(bobTrajId);
  });
});

describe('GET /api/trajectories/:id', () => {
  test('alice cannot fetch bob’s trajectory — 404', async () => {
    const r = await get(aliceApp, `/api/trajectories/${bobTrajId}`);
    expect(r.status).toBe(404);
  });

  test('admin can fetch any user’s trajectory', async () => {
    const r = await get(adminApp, `/api/trajectories/${bobTrajId}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(bobTrajId);
  });
});
