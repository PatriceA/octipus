/**
 * Route-level cross-tenant isolation test for /api/notifications.
 *
 * Closes the markRead gap: previously the service accepted any
 * notification id and flipped its read flag. Now the scoped repo
 * filters by owner; alice marking bob's notification read is a silent
 * no-op (returns success:false) and the row stays unread.
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
let bobApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let aliceNotifId: string;
let bobNotifId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-notif-iso-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false),
       ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );

  // Insert notifications directly so we have known IDs.
  await executeRaw(
    `INSERT INTO notifications (user_id, type, title, body, read) VALUES
       ('${aliceId}', 'info', 'alice-notif', 'a-body', false),
       ('${bobId}', 'info', 'bob-notif', 'b-body', false)`,
  );
  const { rows } = await queryRaw(`SELECT id, user_id FROM notifications`);
  aliceNotifId = rows.find((r: any) => r.user_id === aliceId).id;
  bobNotifId = rows.find((r: any) => r.user_id === bobId).id;

  const { notificationRoutes } = await import('./notifications');
  const { principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: uid === aliceId ? 'alice' : 'bob', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(notificationRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId);
  bobApp = buildApp(bobId);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function post(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'POST' }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/notifications', () => {
  test('list returns only own notifications', async () => {
    const r = await get(aliceApp, '/api/notifications');
    expect(r.body.notifications.find((n: any) => n.id === bobNotifId)).toBeUndefined();
    expect(r.body.notifications.find((n: any) => n.id === aliceNotifId)).toBeDefined();
    expect(r.body.unreadCount).toBe(1);
  });
});

describe('POST /api/notifications/:id/read cross-tenant', () => {
  test('alice cannot mark bob’s notification read', async () => {
    const r = await post(aliceApp, `/api/notifications/${bobNotifId}/read`);
    expect(r.body).toEqual({ success: false });

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT read FROM notifications WHERE id='${bobNotifId}'`);
    expect(rows[0].read).toBe(false);
  });

  test('bob can mark his own notification read', async () => {
    const r = await post(bobApp, `/api/notifications/${bobNotifId}/read`);
    expect(r.body).toEqual({ success: true });

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT read FROM notifications WHERE id='${bobNotifId}'`);
    expect(rows[0].read).toBe(true);
  });
});

describe('POST /api/notifications/read-all', () => {
  test('only the principal’s notifications get flipped', async () => {
    // Reset state
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE notifications SET read=false`);

    await post(aliceApp, '/api/notifications/read-all');

    const { rows } = await queryRaw(`SELECT user_id, read FROM notifications`);
    const aliceRow = rows.find((r: any) => r.user_id === aliceId);
    const bobRow = rows.find((r: any) => r.user_id === bobId);
    expect(aliceRow.read).toBe(true);
    expect(bobRow.read).toBe(false);
  });
});
