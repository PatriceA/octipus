/**
 * Per-plugin usage and cancelling a plugin's background run
 * (docs/PLUGIN-PACKAGES.md#usage, #host-api): usage sums the cost rows
 * tagged `plugin:<name>` and those of the plugin's run sessions, all users
 * for an admin and one user's own otherwise; a run is cancelled only by the
 * same package for the same user, or by that user or an admin from the app.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { HostTokenGrant } from './host-api';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const admin = '33333333-3333-4333-8333-333333333333';
const PLUGIN = 'research';

function grant(over: Partial<HostTokenGrant> = {}): HostTokenGrant {
  return { plugin: PLUGIN, userId: alice, workspaceId: null, sessionId: null, scopes: ['agent:run'], maxProtection: 1, tool: 'go', effect: 'write', expiresAt: Date.now() + 30_000, ...over };
}

async function cost(userId: string, requestType: string | null, sessionId: string | null, tokens: number, usd: number): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw(`INSERT INTO cost_log (user_id, session_id, model_name, input_tokens, output_tokens, total_cost, request_type)
    VALUES ('${userId}', ${sessionId ? `'${sessionId}'` : 'NULL'}, 'm', ${tokens}, ${tokens}, ${usd}, ${requestType ? `'${requestType}'` : 'NULL'})`);
}

async function run(userId: string, plugin = PLUGIN): Promise<{ id: string; sessionId: string }> {
  const { backgroundJobRepository } = await import('@/db/repositories/background-job-repository');
  const sessionId = randomUUID();
  const row = await backgroundJobRepository.create({ kind: 'agent', userId, title: 't', status: 'running', payload: { plugin, tool: 'go', role: 'research', sessionId } });
  return { id: row.id, sessionId };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-usage-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  for (const [id, name, isAdmin] of [[alice, 'alice', false], [bob, 'bob', false], [admin, 'admin', true]] as const) {
    await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${id}', '${name}', ${isAdmin}) ON CONFLICT DO NOTHING`);
  }
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('usage', () => {
  test('sums model calls and runs of one plugin: all users for the admin view, one user\'s own otherwise', async () => {
    const aliceRun = await run(alice);
    const bobRun = await run(bob);
    await run(alice, 'other');
    await cost(alice, `plugin:${PLUGIN}`, null, 10, 0.5);
    await cost(alice, null, aliceRun.sessionId, 100, 1);
    await cost(bob, `plugin:${PLUGIN}`, null, 20, 2);
    await cost(bob, null, bobRun.sessionId, 200, 3);
    await cost(alice, 'plugin:other', null, 1000, 50);
    await cost(alice, 'chat', null, 1000, 50);
    const { pluginUsageRepository } = await import('@/db/repositories/plugin-usage-repository');
    const since = new Date(Date.now() - 86_400_000);
    const all = await pluginUsageRepository.usage(PLUGIN, since);
    expect(all).toMatchObject({ modelCalls: 2, runs: 2, inputTokens: 330, outputTokens: 330, cost: 6.5 });
    expect(all.byUser.map((u) => u.userId).sort()).toEqual([alice, bob].sort());
    const mine = await pluginUsageRepository.usage(PLUGIN, since, alice);
    expect(mine).toMatchObject({ modelCalls: 1, runs: 1, inputTokens: 110, outputTokens: 110, cost: 1.5 });
    expect(mine.byUser.map((u) => u.userId)).toEqual([alice]);
    expect((await pluginUsageRepository.usage(PLUGIN, new Date(Date.now() + 86_400_000))).modelCalls).toBe(0);
  });
});

describe('cancelling a background run', () => {
  test('another package or another user cannot cancel it; the same package for the same user can', async () => {
    const { cancelPluginAgentRun } = await import('./host-agent');
    const { backgroundJobRepository } = await import('@/db/repositories/background-job-repository');
    const r = await run(alice);
    expect(await cancelPluginAgentRun(grant({ plugin: 'other' }), r.id)).toMatchObject({ ok: false, status: 404 });
    expect(await cancelPluginAgentRun(grant({ userId: bob }), r.id)).toMatchObject({ ok: false, status: 404 });
    expect((await backgroundJobRepository.findById(r.id))?.status).toBe('running');
    expect(await cancelPluginAgentRun(grant(), r.id)).toEqual({ ok: true, value: { id: r.id, status: 'cancelled' } });
    expect((await backgroundJobRepository.findById(r.id))?.status).toBe('cancelled');
    expect(await cancelPluginAgentRun(grant(), r.id)).toMatchObject({ ok: false, status: 409 });
  });

  test('from the app: the user who started it or an admin; anyone else is not found', async () => {
    const { cancelRunFromApp } = await import('./host-agent');
    const r = await run(alice);
    expect(await cancelRunFromApp(PLUGIN, r.id, { userId: bob, isAdmin: false })).toMatchObject({ ok: false, status: 404 });
    expect(await cancelRunFromApp('other', r.id, { userId: alice, isAdmin: false })).toMatchObject({ ok: false, status: 404 });
    expect(await cancelRunFromApp(PLUGIN, r.id, { userId: admin, isAdmin: true })).toMatchObject({ ok: true, value: { status: 'cancelled', userId: alice } });
    const s = await run(alice);
    expect(await cancelRunFromApp(PLUGIN, s.id, { userId: alice, isAdmin: false })).toMatchObject({ ok: true });
    expect(await cancelRunFromApp(PLUGIN, 'not-a-uuid', { userId: alice, isAdmin: false })).toMatchObject({ ok: false, status: 404 });
  });
});
