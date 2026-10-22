/**
 * /api/onboarding over embedded PGlite: what the guide reads about the
 * install, the caller's saved progress (never a secret), and the standing
 * instructions note the heartbeat reads.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const adminId = '66666666-6666-6666-6666-666666666666';
const userId = '77777777-7777-7777-7777-777777777777';
let adminApp: ElysiaLike;
let userApp: ElysiaLike;
let anonApp: ElysiaLike;
let queryRaw: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
let executeRaw: (sql: string) => Promise<unknown>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-onboarding-'));
  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  executeRaw = pg.executeRaw as typeof executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin, preferences) VALUES
    ('${adminId}', 'boss', true, '{"theme":"dark"}'), ('${userId}', 'pat', false, '{}') ON CONFLICT DO NOTHING`);

  const { onboardingRoutes } = await import('./onboarding');
  const { principalFromUser } = await import('@/security/principal');
  const build = (u: { id: string; username: string; isAdmin: boolean } | null): ElysiaLike => new Elysia()
    .derive(() => ({ user: u, session: null, principal: u ? principalFromUser(u) : null }))
    .group('/api', (a) => a.use(onboardingRoutes)) as unknown as ElysiaLike;
  adminApp = build({ id: adminId, username: 'boss', isAdmin: true });
  userApp = build({ id: userId, username: 'pat', isAdmin: false });
  anonApp = build(null);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function send(app: ElysiaLike, method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/onboarding', () => {
  test('refuses an unauthenticated caller', async () => {
    expect((await send(anonApp, 'GET', '/api/onboarding')).status).toBe(401);
  });

  test('a fresh install: nothing set up, a default area, the shipped pipelines', async () => {
    const { status, body } = await send(adminApp, 'GET', '/api/onboarding');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      isAdmin: true,
      setupComplete: false,
      models: { textReady: false, embeddingReady: false },
      mailbox: null,
      standingInstructions: false,
      permissions: { tasksWrite: 'ASK', messagingSend: 'ASK' },
      progress: {},
    });
    expect(body.workspaces).toEqual([expect.objectContaining({ kind: 'personal', isDefault: true })]);
    // Presets are seeded at boot, not by migrations: the list is there, empty here.
    expect(Array.isArray(body.pipelineTemplates)).toBe(true);
    expect(Array.isArray(body.cliTools)).toBe(true);
  });

  test('install-wide details are for admins only', async () => {
    const { body } = await send(userApp, 'GET', '/api/onboarding');
    expect(body.isAdmin).toBe(false);
    expect(body.cliTools).toEqual([]);
    expect(body.mcpServers).toEqual([]);
    expect(body.models.names).toEqual([]);
    expect(body.workspaceRoot).toBeNull();
  });
});

describe('PUT /api/onboarding/progress', () => {
  test('keeps the answers without secrets, and the user\'s other preferences', async () => {
    const r = await send(adminApp, 'PUT', '/api/onboarding/progress', {
      useCases: ['company', 'nonsense'],
      answers: { 'company.name': 'Acme', 'models.key': 'sk-secret', 'chat.telegramToken': '1:x' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ useCases: ['company'], answers: { 'company.name': 'Acme' } });
    await send(adminApp, 'PUT', '/api/onboarding/progress', { completed: true, dismissed: true });
    const { rows } = await queryRaw(`SELECT preferences FROM users WHERE id = '${adminId}'`);
    const prefs = rows[0].preferences as Record<string, unknown>;
    expect(prefs.theme).toBe('dark');
    expect(prefs.onboarding).toMatchObject({ useCases: ['company'], dismissed: true, completedAt: expect.any(String) });
    expect(JSON.stringify(prefs)).not.toContain('sk-secret');
    expect((await send(adminApp, 'GET', '/api/onboarding')).body.progress).toMatchObject({ dismissed: true });
  });
});

describe('PUT /api/onboarding/standing-instructions', () => {
  test('writes a pinned user-level heartbeat note, then appends without losing what was there', async () => {
    const first = await send(userApp, 'PUT', '/api/onboarding/standing-instructions', { body: '# HEARTBEAT\n\nAbout Acme: a studio.' });
    expect(first.status).toBe(200);
    expect(first.body.appended).toBe(false);
    const { rows } = await queryRaw(`SELECT body, pinned, workspace_id FROM notes WHERE user_id = '${userId}' AND slug = 'heartbeat'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pinned: true, workspace_id: null });

    const again = await send(userApp, 'PUT', '/api/onboarding/standing-instructions', { body: '# HEARTBEAT\n\n- Never send email.' });
    expect(again.body.appended).toBe(true);
    const { rows: after } = await queryRaw(`SELECT body FROM notes WHERE user_id = '${userId}' AND slug = 'heartbeat'`);
    expect(String(after[0].body)).toContain('About Acme: a studio.');
    expect(String(after[0].body)).toContain('Added by the setup guide');
    expect(String(after[0].body)).toContain('- Never send email.');
    expect((await send(userApp, 'GET', '/api/onboarding')).body.standingInstructions).toBe(true);
  });

  test('the heartbeat finds a heartbeat note written inside a workspace (as the web app writes them)', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const ws = await getOrgWorkspaceManager().ensureDefaultWorkspace(adminId);
    const wsId = (ws as { id: string }).id;
    const body = 'Only ping me for the bank.';
    const sha = createHash('sha256').update(body).digest('hex');
    await executeRaw(`INSERT INTO notes (user_id, workspace_id, slug, title, body, body_sha256) VALUES ('${adminId}', '${wsId}', 'heartbeat', 'HEARTBEAT', '${body}', '${sha}')`);
    const { findStandingNote } = await import('@/core/heartbeat');
    expect((await findStandingNote(adminId))?.body).toBe('Only ping me for the bank.');
  });
});
