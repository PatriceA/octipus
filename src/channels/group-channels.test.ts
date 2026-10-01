/**
 * Group channel enrolment, per-member thread sessions and the owner/admin
 * routes, against embedded Postgres (migration 0120 included).
 *
 * Seeds: anna (owner-to-be), bob (another member), carol (deactivated),
 * admin. Each gets a default workspace on first use.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const annaId = 'aaaaaaaa-0000-4000-8000-000000000001';
const bobId = 'aaaaaaaa-0000-4000-8000-000000000002';
const carolId = 'aaaaaaaa-0000-4000-8000-000000000003';
const adminId = 'aaaaaaaa-0000-4000-8000-000000000004';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

let gc: typeof import('./group-channels');
let executeRaw: (sql: string) => Promise<unknown>;
let sessionRepository: typeof import('@/db/repositories/session-repository').sessionRepository;
let principalMod: typeof import('@/security/principal');
let routes: { group: unknown; admin: unknown };

function appFor(uid: string, isAdmin: boolean): ElysiaLike {
  const { principalFromUser } = principalMod;
  return new Elysia()
    .derive(() => {
      const u = { id: uid, username: 'u', isAdmin };
      return { user: u, session: null, principal: principalFromUser(u) };
    })
    // biome-ignore lint/suspicious/noExplicitAny: plugin chain of heterogeneous route groups
    .group('/api', (a: any) => a.use(routes.group).use(routes.admin) as any) as unknown as ElysiaLike;
}

async function call(app: ElysiaLike, method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-group-channels-'));
  const db = await import('@/db/postgres');
  await db.initializeDb();
  executeRaw = db.executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(
    `INSERT INTO users (id, username, is_admin, is_active) VALUES
       ('${annaId}', 'anna', false, true),
       ('${bobId}', 'bob', false, true),
       ('${carolId}', 'carol', false, true),
       ('${adminId}', 'admin', true, true)`,
  );
  gc = await import('./group-channels');
  sessionRepository = (await import('@/db/repositories/session-repository')).sessionRepository;
  principalMod = await import('@/security/principal');
  routes = {
    group: (await import('@/api/routes/group-channels')).groupChannelRoutes,
    admin: (await import('@/api/routes/admin')).adminRoutes,
  };
});

beforeEach(async () => {
  await executeRaw('DELETE FROM sessions');
  await executeRaw('DELETE FROM group_channels');
  await executeRaw(`UPDATE users SET is_active = true`);
  gc.clearGroupChannelCache();
});

const enrol = (channelId: string, userId: string) =>
  gc.joinGroupChannel({ channelType: 'slack', channelId, label: '#release', userId });

describe('enrolment', () => {
  test('first join enrols into the member\'s default workspace; a repeat is a no-op', async () => {
    const first = await enrol('C1', annaId);
    expect(first.status).toBe('enrolled');
    if (first.status !== 'enrolled') return;
    expect(first.group).toMatchObject({ channelId: 'C1', ownerUserId: annaId, label: '#release' });
    expect(first.workspaceName).toBeTruthy();
    expect((await enrol('C1', annaId)).status).toBe('already_yours');
    expect(await gc.findGroupChannel('slack', 'C1')).toMatchObject({ ownerUserId: annaId });
    expect(await gc.findGroupChannel('slack', 'C-OTHER')).toBeNull();
  });

  test('another active member cannot take it; told who holds it', async () => {
    await enrol('C1', annaId);
    expect(await enrol('C1', bobId)).toEqual({ status: 'taken', ownerName: 'anna' });
  });

  test('a deactivated owner pauses the channel until another member takes it over', async () => {
    await enrol('C1', carolId);
    const group = (await gc.findGroupChannel('slack', 'C1'))!;
    expect(await gc.isGroupChannelActive(group)).toBe(true);
    await executeRaw(`UPDATE users SET is_active = false WHERE id = '${carolId}'`);
    expect(await gc.isGroupChannelActive(group)).toBe(false);

    const taken = await enrol('C1', bobId);
    expect(taken).toMatchObject({ status: 'took_over', previousOwner: 'carol' });
    const now = (await gc.findGroupChannel('slack', 'C1'))!;
    expect(now.ownerUserId).toBe(bobId);
    expect(await gc.isGroupChannelActive(now)).toBe(true);
  });

  test('leave: only the owner or an admin', async () => {
    await enrol('C1', annaId);
    expect(await gc.leaveGroupChannel({ channelType: 'slack', channelId: 'C1', userId: bobId, isAdmin: false })).toBe('not_owner');
    expect(await gc.leaveGroupChannel({ channelType: 'slack', channelId: 'C1', userId: adminId, isAdmin: true })).toBe('left');
    expect(await gc.findGroupChannel('slack', 'C1')).toBeNull();
    expect(await gc.leaveGroupChannel({ channelType: 'slack', channelId: 'C1', userId: annaId, isAdmin: false })).toBe('not_enrolled');
  });

  test('an enrolment change is visible at once, not after the cache expires', async () => {
    expect(await gc.findGroupChannel('slack', 'C1')).toBeNull();
    await enrol('C1', annaId);
    expect(await gc.findGroupChannel('slack', 'C1')).not.toBeNull();
  });
});

describe('group thread sessions', () => {
  test('one session per member per thread, owned by that member, apart from their 1:1 chat', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    // anna also has an ordinary active session for the same chat id (the old behaviour).
    const { resolveSession } = await import('@/core/agent/session-resolver');
    const oneToOne = await resolveSession('slack-C1', annaId, 'slack');

    const annaT1 = await gc.resolveGroupSession({ userId: annaId, group: r.group, threadId: '90.0' });
    const annaT1again = await gc.resolveGroupSession({ userId: annaId, group: r.group, threadId: '90.0' });
    const annaT2 = await gc.resolveGroupSession({ userId: annaId, group: r.group, threadId: '95.0' });
    const bobT1 = await gc.resolveGroupSession({ userId: bobId, group: r.group, threadId: '90.0' });

    expect(annaT1again).toBe(annaT1);
    expect(new Set([oneToOne, annaT1, annaT2, bobT1]).size).toBe(4);
    expect(await sessionRepository.findById(bobT1)).toMatchObject({ userId: bobId, groupChannelId: r.group.id, threadId: '90.0', channelId: 'C1' });

    // The 1:1 lookup and the transcript aggregation never pick up group threads.
    expect((await sessionRepository.findByUserAndChannel(annaId, 'slack', 'C1'))?.id).toBe(oneToOne);
    expect((await sessionRepository.findAllByUserAndChannel(annaId, 'slack', 'C1')).map(s => s.id)).toEqual([oneToOne]);

    expect(await gc.isGroupThreadActive(r.group.id, '90.0')).toBe(true);
    expect(await gc.isGroupThreadActive(r.group.id, '99.9')).toBe(false);
  });

  test('removing the enrolment leaves the members\' sessions but detaches them', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    const s = await gc.resolveGroupSession({ userId: bobId, group: r.group, threadId: '90.0' });
    await gc.removeGroupChannel(r.group.id, { userId: annaId, isAdmin: false });
    expect(await sessionRepository.findById(s)).toMatchObject({ userId: bobId, groupChannelId: null });
  });
});

describe('routes', () => {
  test('owner lists, moves and removes their own; others get 404', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    const anna = appFor(annaId, false);
    const bob = appFor(bobId, false);

    const list = await call(anna, 'GET', '/me/group-channels');
    expect(list.status).toBe(200);
    expect(list.json.groupChannels).toEqual([expect.objectContaining({ id: r.group.id, ownerName: 'anna', ownerActive: true })]);
    expect((await call(bob, 'GET', '/me/group-channels')).json.groupChannels).toEqual([]);

    // bob cannot move or remove anna's enrolment, nor move it into his own workspace
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const bobWs = await getOrgWorkspaceManager().ensureDefaultWorkspace(bobId);
    expect((await call(bob, 'PATCH', `/me/group-channels/${r.group.id}`, { workspaceId: bobWs.id })).status).toBe(404);
    expect((await call(anna, 'PATCH', `/me/group-channels/${r.group.id}`, { workspaceId: bobWs.id })).status).toBe(404);
    expect((await call(bob, 'DELETE', `/me/group-channels/${r.group.id}`)).status).toBe(404);

    expect((await call(anna, 'PATCH', `/me/group-channels/${r.group.id}`, { workspaceId: r.group.workspaceId })).status).toBe(200);
    expect((await call(anna, 'DELETE', `/me/group-channels/${r.group.id}`)).json).toEqual({ deleted: true });
    expect(await gc.findGroupChannel('slack', 'C1')).toBeNull();
  });

  test('admin lists every enrolment and can revoke; non-admins cannot', async () => {
    await enrol('C1', annaId);
    const r2 = await enrol('C2', bobId);
    if (r2.status !== 'enrolled') throw new Error('setup');
    const admin = appFor(adminId, true);
    const list = await call(admin, 'GET', '/admin/group-channels');
    expect((list.json.groupChannels as unknown[]).length).toBe(2);
    expect((await call(appFor(annaId, false), 'GET', '/admin/group-channels')).status).toBe(403);
    expect((await call(appFor(annaId, false), 'DELETE', `/admin/group-channels/${r2.group.id}`)).status).toBe(403);
    expect((await call(admin, 'DELETE', `/admin/group-channels/${r2.group.id}`)).json).toEqual({ deleted: true });
    expect(await gc.findGroupChannel('slack', 'C2')).toBeNull();
  });
});
