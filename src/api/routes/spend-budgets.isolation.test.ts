/**
 * Route-level isolation test for GET /api/spend-budgets/me.
 *
 * The route is scoped by the authenticated principal, never by a parameter:
 * alice sees her own budgets (user, role and workspace scopes) with this
 * period's spend and state, and nothing of bob's. Also covers the state
 * judgement (ok / warned / paused against the current period start), the
 * reset time, and the "unmeasured" flag for $0-cost CLI / subscription calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const OWN = { funding: 'own' as const, spaceId: null };
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '31111111-1111-1111-1111-111111111111';
const bobId = '32222222-2222-2222-2222-222222222222';
const aliceWs = '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
let anonApp: ElysiaLike;
let adminApp: ElysiaLike;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-spend-iso-'));

  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false),
       ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );
  await executeRaw(
    `INSERT INTO workspaces (id, user_id, slug, name, is_default, files_dir)
     VALUES ('${aliceWs}', '${aliceId}', 'client-a', 'Client A', false, '${aliceWs}')`,
  );

  const { upsertBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
  _resetSpendBudgetsForTests();
  // alice: a monthly user budget at 50% ($5 of $10) with one $0 CLI call,
  // a daily role budget with no spend, a workspace budget.
  await upsertBudget({ userId: aliceId, scopeKind: 'user', period: 'month', limitUsd: 10 });
  await upsertBudget({ userId: aliceId, scopeKind: 'role', scopeRef: 'coder', period: 'day', limitUsd: 2, warnRatio: 0.5 });
  await upsertBudget({ userId: aliceId, scopeKind: 'workspace', scopeRef: aliceWs.toUpperCase(), period: 'month', limitUsd: 100 });
  // bob: a daily user budget he has blown through, plus a stale pause stamp
  // on a second budget from last month.
  await upsertBudget({ userId: bobId, scopeKind: 'user', period: 'day', limitUsd: 1 });
  const stale = await upsertBudget({ userId: bobId, scopeKind: 'user', period: 'month', limitUsd: 1000, warnRatio: 0.9 });
  await executeRaw(
    `UPDATE spend_budgets SET paused_at = now() - interval '40 days', warned_at = now() - interval '40 days'
     WHERE id = '${stale.id}'`,
  );

  await executeRaw(
    `INSERT INTO cost_log (user_id, model_name, input_tokens, output_tokens, total_cost, metadata) VALUES
       ('${aliceId}', 'm', 1, 1, 4, '{"costSource":"reported"}'),
       ('${aliceId}', 'm', 1, 1, 1, '{"costSource":"estimated"}'),
       ('${aliceId}', 'claude-cli', 1, 1, 0, '{"costSource":"unknown"}'),
       ('${bobId}', 'm', 1, 1, 3, '{"costSource":"reported"}')`,
  );

  const { spendBudgetRoutes } = await import('./spend-budgets');
  const { adminRoutes } = await import('./admin');
  const { principalFromUser, ANONYMOUS_PRINCIPAL } = await import('@/security/principal');

  const buildApp = (uid: string | null, isAdmin = false): ElysiaLike =>
    new Elysia()
      .derive(() => {
        if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
        const u = { id: uid, username: uid === aliceId ? 'alice' : 'bob', isAdmin };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(spendBudgetRoutes).use(adminRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId);
  bobApp = buildApp(bobId);
  anonApp = buildApp(null);
  adminApp = buildApp(bobId, true);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}

type View = {
  id: string; userId: string; scopeKind: string; scopeRef: string | null; scopeName: string | null;
  period: string; limitUsd: number; warnRatio: number; spentUsd: number; estimatedUsd: number;
  unmeasuredCalls: number; unmeasured: boolean; percent: number; state: string;
  periodStart: string; resetsAt: string; pausedAt: string | null; warnedAt: string | null;
};

describe('GET /api/spend-budgets/me', () => {
  test('alice sees only her own budgets, every scope', async () => {
    const r = await get(aliceApp, '/api/spend-budgets/me');
    expect(r.status).toBe(200);
    const budgets = r.body.budgets as View[];
    expect(budgets).toHaveLength(3);
    expect(budgets.every((b) => b.userId === aliceId)).toBe(true);
    expect(budgets.map((b) => b.scopeKind)).toEqual(['user', 'role', 'workspace']);
  });

  test('bob sees only his own budgets', async () => {
    const r = await get(bobApp, '/api/spend-budgets/me');
    const budgets = r.body.budgets as View[];
    expect(budgets).toHaveLength(2);
    expect(budgets.every((b) => b.userId === bobId)).toBe(true);
  });

  test('user scope: current-period spend, percent, split by how it was measured', async () => {
    const [user] = (await get(aliceApp, '/api/spend-budgets/me')).body.budgets as View[];
    expect(user.spentUsd).toBeCloseTo(5);
    expect(user.estimatedUsd).toBeCloseTo(1);
    expect(user.percent).toBe(50);
    expect(user.limitUsd).toBe(10);
    expect(user.warnRatio).toBeCloseTo(0.8);
    expect(user.state).toBe('ok');
    // The CLI call logged $0: the figure under-counts and says so.
    expect(user.unmeasuredCalls).toBe(1);
    expect(user.unmeasured).toBe(true);
    // Monthly: resets at the first of next month, 00:00 UTC.
    const start = new Date(user.periodStart);
    const resets = new Date(user.resetsAt);
    expect(start.getUTCDate()).toBe(1);
    expect(resets.getUTCDate()).toBe(1);
    expect(resets.getTime()).toBeGreaterThan(Date.now());
    expect((resets.getUTCMonth() - start.getUTCMonth() + 12) % 12).toBe(1);
  });

  test('role and workspace scopes carry a display name; unrelated rows do not count', async () => {
    const [, role, ws] = (await get(aliceApp, '/api/spend-budgets/me')).body.budgets as View[];
    // No agent rows with role "coder" → nothing attributed.
    expect(role.scopeName).toBe('coder');
    expect(role.spentUsd).toBe(0);
    expect(role.state).toBe('ok');
    expect(new Date(role.resetsAt).getTime() - new Date(role.periodStart).getTime()).toBe(86_400_000);
    // Workspace ids are stored lowercased and resolved to the workspace name.
    expect(ws.scopeRef).toBe(aliceWs);
    expect(ws.scopeName).toBe('Client A');
    expect(ws.spentUsd).toBe(0);
  });

  test('state is paused at the limit, and a stamp from an earlier period is inert', async () => {
    const budgets = (await get(bobApp, '/api/spend-budgets/me')).body.budgets as View[];
    const day = budgets.find((b) => b.period === 'day')!;
    const month = budgets.find((b) => b.period === 'month')!;
    expect(day.spentUsd).toBeCloseTo(3);
    expect(day.percent).toBe(300);
    expect(day.state).toBe('paused');
    expect(day.unmeasured).toBe(false);
    // Paused 40 days ago: last period's stamps are reported as null.
    expect(month.state).toBe('ok');
    expect(month.pausedAt).toBeNull();
    expect(month.warnedAt).toBeNull();
  });

  test('reading is side-effect free: no pause stamp, no notification', async () => {
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT paused_at FROM spend_budgets WHERE user_id = '${bobId}' AND period = 'day'`,
    );
    expect((rows[0] as { paused_at: unknown }).paused_at).toBeNull();
    const n = await queryRaw(`SELECT id FROM notifications WHERE user_id = '${bobId}'`);
    expect(n.rows).toHaveLength(0);
  });

  test('a paused stamp in the current period reads as paused and carries pausedAt', async () => {
    const { checkSpend, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    _resetSpendBudgetsForTests();
    await expect(checkSpend({ userId: bobId, ...OWN })).rejects.toThrow(/Spend budget exceeded/);
    const day = ((await get(bobApp, '/api/spend-budgets/me')).body.budgets as View[]).find((b) => b.period === 'day')!;
    expect(day.state).toBe('paused');
    expect(day.pausedAt).not.toBeNull();
  });

  test('unauthenticated → 401, no budgets', async () => {
    const r = await get(anonApp, '/api/spend-budgets/me');
    expect(r.status).toBe(401);
    expect(r.body.budgets).toBeUndefined();
  });
});

describe('admin views', () => {
  test('GET /api/admin/spend-budgets?userId= adds the same status view', async () => {
    const r = await get(adminApp, `/api/admin/spend-budgets?userId=${aliceId}`);
    expect(r.status).toBe(200);
    expect(r.body.budgets).toHaveLength(3);
    const statuses = r.body.statuses as View[];
    expect(statuses.map((s) => s.userId)).toEqual([aliceId, aliceId, aliceId]);
    expect(statuses[0].spentUsd).toBeCloseTo(5);
  });

  test('GET /api/admin/users/:id/workspaces lists that user’s workspaces; non-admins are refused', async () => {
    const r = await get(adminApp, `/api/admin/users/${aliceId}/workspaces`);
    expect(r.body.workspaces.map((w: { name: string }) => w.name)).toContain('Client A');
    const denied = await get(aliceApp, `/api/admin/users/${aliceId}/workspaces`);
    expect(denied.status).toBe(403);
    const deniedList = await get(aliceApp, `/api/admin/spend-budgets?userId=${bobId}`);
    expect(deniedList.status).toBe(403);
  });
});
