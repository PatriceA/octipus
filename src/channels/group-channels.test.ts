/**
 * Group channel enrolment, per-member thread sessions and the owner/admin
 * routes, against embedded Postgres (migrations 0121 and 0122 included).
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
  test('first join enrols the channel; a repeat is a no-op', async () => {
    const first = await enrol('C1', annaId);
    expect(first.status).toBe('enrolled');
    if (first.status !== 'enrolled') return;
    expect(first.group).toMatchObject({ channelId: 'C1', ownerUserId: annaId, label: '#release' });
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
    // Not cached: a deactivation pauses the channel immediately.
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

  test('a chat that changes id (Telegram supergroup upgrade) keeps its enrolment and sessions', async () => {
    await gc.joinGroupChannel({ channelType: 'telegram', channelId: '-41', label: 'Crew', userId: annaId });
    const group = (await gc.findGroupChannel('telegram', '-41'))!;
    const sessionId = await gc.resolveGroupSession({ userId: annaId, group, threadId: 'main' });
    expect(await gc.moveGroupChannel('telegram', '-41', '-10041')).toBe(true);
    expect(await gc.findGroupChannel('telegram', '-41')).toBeNull();
    expect(await gc.findGroupChannel('telegram', '-10041')).toMatchObject({ id: group.id, ownerUserId: annaId });
    expect((await sessionRepository.findById(sessionId))?.channelId).toBe('-10041');
    expect(await gc.moveGroupChannel('telegram', '-99', '-10099')).toBe(false);
  });

  test('an enrolment change is visible at once, not after the cache expires', async () => {
    expect(await gc.findGroupChannel('slack', 'C1')).toBeNull();
    await enrol('C1', annaId);
    expect(await gc.findGroupChannel('slack', 'C1')).not.toBeNull();
  });
});

describe('modes and unprompted posts (phase 4)', () => {
  test('the owner, or an admin, sets the mode, quiet hours and rate limit; nobody else; bad values are refused', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    expect(r.group).toMatchObject({ mode: 'mention', timezone: 'UTC', maxUnpromptedPerDay: 8, minMinutesBetween: 60, quietHoursStart: null });

    const set = await gc.updateGroupChannelSettings(r.group.id, { userId: annaId, isAdmin: false }, {
      mode: 'listen', quietHoursStart: 19, quietHoursEnd: 8, timezone: 'Europe/Berlin', maxUnpromptedPerDay: 4,
    });
    expect(set).toMatchObject({ mode: 'listen', quietHoursStart: 19, quietHoursEnd: 8, timezone: 'Europe/Berlin', maxUnpromptedPerDay: 4, minMinutesBetween: 60 });
    // The cached lookup sees it at once.
    expect((await gc.findGroupChannel('slack', 'C1'))?.mode).toBe('listen');
    expect((await gc.listUnpromptedGroupChannels()).map(g => g.id)).toEqual([r.group.id]);

    expect(await gc.updateGroupChannelSettings(r.group.id, { userId: bobId, isAdmin: false }, { mode: 'proactive' })).toBeNull();
    expect(await gc.updateGroupChannelSettings(r.group.id, { userId: adminId, isAdmin: true }, { mode: 'proactive' })).toMatchObject({ mode: 'proactive' });

    for (const bad of [{ timezone: 'Mars/Olympus' }, { quietHoursStart: 22 }, { quietHoursStart: 25, quietHoursEnd: 3 }, { maxUnpromptedPerDay: 0 }, { minMinutesBetween: 5 }]) {
      await expect(gc.updateGroupChannelSettings(r.group.id, { userId: annaId, isAdmin: false }, bad)).rejects.toThrow(gc.GroupChannelSettingsError);
    }
    expect(await gc.updateGroupChannelSettings(r.group.id, { userId: annaId, isAdmin: false }, { quietHoursStart: null, quietHoursEnd: null }))
      .toMatchObject({ quietHoursStart: null, quietHoursEnd: null });

    // Only the settings: an owner cannot move the enrolment, hand it to someone else or reset its counters.
    const sneaky = { mode: 'listen', ownerUserId: bobId, channelId: 'C999', unpromptedCount: -50 } as unknown as Parameters<typeof gc.updateGroupChannelSettings>[2];
    expect(await gc.updateGroupChannelSettings(r.group.id, { userId: annaId, isAdmin: false }, sneaky))
      .toMatchObject({ ownerUserId: annaId, channelId: 'C1', unpromptedCount: 0, mode: 'listen' });
  });

  test('a takeover puts the channel back in mention mode: the new owner opts in again', async () => {
    const r = await enrol('C1', carolId);
    if (r.status !== 'enrolled') throw new Error('setup');
    await gc.updateGroupChannelSettings(r.group.id, { userId: carolId, isAdmin: false }, { mode: 'proactive' });
    await executeRaw(`UPDATE users SET is_active = false WHERE id = '${carolId}'`);
    const taken = await enrol('C1', bobId);
    expect(taken).toMatchObject({ status: 'took_over', group: { ownerUserId: bobId, mode: 'mention' } });
  });

  test('the unprompted slot: one claim per gap, up to the daily cap, counted per local day', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    const group = (await gc.updateGroupChannelSettings(r.group.id, { userId: annaId, isAdmin: false }, { mode: 'listen', maxUnpromptedPerDay: 2, minMinutesBetween: 30 }))!;
    const t0 = new Date('2026-10-04T09:00:00Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    expect(await gc.claimUnpromptedSlot(group, t0, '2026-10-04')).toBe(true);
    expect(await gc.claimUnpromptedSlot(group, at(10), '2026-10-04')).toBe(false); // within the gap
    expect(await gc.claimUnpromptedSlot(group, at(31), '2026-10-04')).toBe(true);
    expect(await gc.claimUnpromptedSlot(group, at(90), '2026-10-04')).toBe(false); // the cap of 2
    expect(await gc.claimUnpromptedSlot(group, at(24 * 60), '2026-10-05')).toBe(true); // a new day
    expect(await gc.findGroupChannelById(group.id)).toMatchObject({ unpromptedDay: '2026-10-05', unpromptedCount: 1 });

    // Back in mention mode, no slot is ever claimed.
    await gc.updateGroupChannelSettings(group.id, { userId: annaId, isAdmin: false }, { mode: 'mention' });
    expect(await gc.claimUnpromptedSlot(group, at(48 * 60), '2026-10-06')).toBe(false);
  });

  test('feedback: one per member and message, replaced by a second reaction, withdrawn by value, counted in the list', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    const g = r.group.id;
    await gc.recordGroupFeedback({ groupChannelId: g, messageId: '98.0', threadId: '90.0', userId: annaId, value: 1 });
    await gc.recordGroupFeedback({ groupChannelId: g, messageId: '98.0', userId: bobId, value: -1 });
    await gc.recordGroupFeedback({ groupChannelId: g, messageId: '98.0', userId: bobId, value: 1 }); // bob changed his mind
    expect((await gc.listGroupChannelsForOwner(annaId))[0]!.feedback).toEqual({ up: 2, down: 0 });

    // Taking off an ❌ that is no longer there leaves the ✅.
    await gc.removeGroupFeedback({ groupChannelId: g, messageId: '98.0', userId: bobId, value: -1 });
    expect((await gc.listAllGroupChannels())[0]!.feedback).toEqual({ up: 2, down: 0 });
    await gc.removeGroupFeedback({ groupChannelId: g, messageId: '98.0', userId: bobId, value: 1 });
    expect((await gc.listAllGroupChannels())[0]!.feedback).toEqual({ up: 1, down: 0 });
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

  test('removing an enrolment keeps every thread session a group session, even several per member', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    // bob has two active threads in the same channel (two rows for user/slack/C1).
    const t1 = await gc.resolveGroupSession({ userId: bobId, group: r.group, threadId: '90.0' });
    const t2 = await gc.resolveGroupSession({ userId: bobId, group: r.group, threadId: '95.0' });
    expect(await gc.removeGroupChannel(r.group.id, { userId: annaId, isAdmin: false })).not.toBeNull();
    for (const id of [t1, t2]) {
      expect(await sessionRepository.findById(id)).toMatchObject({ userId: bobId, groupChannelId: r.group.id, status: 'active' });
    }
    // still never mistaken for bob's 1:1 chat with the bot
    expect(await sessionRepository.findByUserAndChannel(bobId, 'slack', 'C1')).toBeNull();
  });

  test('deleting the owner removes the enrolment without touching members\' sessions', async () => {
    await executeRaw(`INSERT INTO users (id, username) VALUES ('aaaaaaaa-0000-4000-8000-000000000009', 'dave')`);
    const daveId = 'aaaaaaaa-0000-4000-8000-000000000009';
    const r = await enrol('C3', daveId);
    if (r.status !== 'enrolled') throw new Error('setup');
    const s1 = await gc.resolveGroupSession({ userId: bobId, group: r.group, threadId: '1.0' });
    const s2 = await gc.resolveGroupSession({ userId: bobId, group: r.group, threadId: '2.0' });
    await executeRaw(`DELETE FROM users WHERE id = '${daveId}'`);
    gc.clearGroupChannelCache();
    expect(await gc.findGroupChannel('slack', 'C3')).toBeNull();
    for (const id of [s1, s2]) {
      expect(await sessionRepository.findById(id)).toMatchObject({ userId: bobId, groupChannelId: r.group.id, status: 'active' });
    }
  });

  test('thread activity: a new thread session is visible at once, through the cache', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    expect(await gc.isGroupThreadActive(r.group.id, '70.0')).toBe(false); // caches "no"
    await gc.resolveGroupSession({ userId: annaId, group: r.group, threadId: '70.0' });
    expect(await gc.isGroupThreadActive(r.group.id, '70.0')).toBe(true);
  });
});

describe('routes', () => {
  test('owner lists and removes their own; others get 404', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    const anna = appFor(annaId, false);
    const bob = appFor(bobId, false);

    const list = await call(anna, 'GET', '/me/group-channels');
    expect(list.status).toBe(200);
    expect(list.json.groupChannels).toEqual([expect.objectContaining({ id: r.group.id, ownerName: 'anna', ownerActive: true })]);
    expect((await call(bob, 'GET', '/me/group-channels')).json.groupChannels).toEqual([]);

    expect((await call(bob, 'DELETE', `/me/group-channels/${r.group.id}`)).status).toBe(404);
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

  test('PATCH: the owner and admins change the mode; others get 404 (owner route) or 403 (admin route); bad values 400/422', async () => {
    const r = await enrol('C1', annaId);
    if (r.status !== 'enrolled') throw new Error('setup');
    const anna = appFor(annaId, false);
    const ok = await call(anna, 'PATCH', `/me/group-channels/${r.group.id}`, { mode: 'listen', quietHoursStart: 20, quietHoursEnd: 8 });
    expect(ok.status).toBe(200);
    expect(ok.json.groupChannel).toMatchObject({ mode: 'listen', quietHoursStart: 20, quietHoursEnd: 8 });
    expect((await call(appFor(bobId, false), 'PATCH', `/me/group-channels/${r.group.id}`, { mode: 'proactive' })).status).toBe(404);
    expect((await call(anna, 'PATCH', `/me/group-channels/${r.group.id}`, { timezone: 'Nowhere/Land' })).status).toBe(400);
    expect((await call(anna, 'PATCH', `/me/group-channels/${r.group.id}`, { mode: 'shout' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(anna, 'PATCH', `/me/group-channels/${r.group.id}`, { mode: 'listen', ownerUserId: bobId })).status).toBeGreaterThanOrEqual(400);
    expect((await gc.findGroupChannelById(r.group.id))?.ownerUserId).toBe(annaId);

    expect((await call(anna, 'PATCH', `/admin/group-channels/${r.group.id}`, { mode: 'proactive' })).status).toBe(403);
    const admin = await call(appFor(adminId, true), 'PATCH', `/admin/group-channels/${r.group.id}`, { mode: 'proactive' });
    expect(admin.json.groupChannel).toMatchObject({ mode: 'proactive' });
  });
});
