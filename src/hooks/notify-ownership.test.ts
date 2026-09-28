/**
 * Notify hooks may only message chats linked to the hook owner.
 *
 * Before this check a user could store `notifyChannels: ['telegram:<any
 * chat id>']` (or a channelType / channelId pair) and make the bot message
 * another user's chat, or any chat the bot is in. These tests seed alice and
 * bob with linked chats and verify that:
 *  - executeNotify sends to the owner's own linked chats (channel_identities
 *    rows and verified legacy bindings);
 *  - another user's chat or an unknown chat is skipped, and a hook with no
 *    allowed target returns an error result;
 *  - POST / PATCH /api/hooks reject a foreign target with 400.
 *
 * UMI is mocked: sends are recorded, nothing leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import type { Hook } from '@/core/types';

const sent = vi.hoisted(() => ({ calls: [] as Array<{ type: string; id: string; content: string }> }));
vi.mock('@/channels/interface', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/channels/interface')>()),
  getUMI: () => ({
    isChannelAvailable: () => true,
    send: async (type: string, id: string, res: { content: string }) => {
      sent.calls.push({ type, id, content: res.content });
      return 'msg-1';
    },
  }),
}));

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
const aliceTeams = '19:alice-conv@thread.skype';
let aliceApp: ElysiaLike;
let aliceHookId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-notify-owner-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const aliceLegacy = JSON.stringify([
    { channelType: 'slack', channelUserId: 'U-ALICE', isVerified: true, createdAt: '2026-01-01' },
    { channelType: 'whatsapp', channelUserId: 'wa-alice-unverified', isVerified: false, createdAt: '2026-01-01' },
  ]);
  await executeRaw(
    `INSERT INTO users (id, username, is_admin, channel_bindings) VALUES
       ('${aliceId}', 'alice', false, '${aliceLegacy}'::jsonb),
       ('${bobId}', 'bob', false, '[]'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
  await executeRaw(
    `INSERT INTO channel_identities (user_id, channel_type, external_id, verified_at) VALUES
       ('${aliceId}', 'telegram', 'tg-alice', now()),
       ('${aliceId}', 'teams', '${aliceTeams}', now()),
       ('${bobId}', 'telegram', 'tg-bob', now())`,
  );
  await executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled)
     VALUES ('${aliceId}', 'alice-notify', 'message_received', '{}'::jsonb, 'notify', '{}'::jsonb, true)`,
  );
  const { rows } = await queryRaw(`SELECT id FROM hooks WHERE name = 'alice-notify'`);
  aliceHookId = (rows[0] as { id: string }).id;

  const { hookRoutes } = await import('@/api/routes/hooks');
  const { principalFromUser } = await import('@/security/principal');
  aliceApp = new Elysia()
    .derive(() => {
      const u = { id: aliceId, username: 'alice', isAdmin: false };
      return { user: u, session: null, principal: principalFromUser(u) };
    })
    .group('/api', (a) => a.use(hookRoutes)) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(() => {
  sent.calls.length = 0;
});

function notifyHook(actionConfig: Record<string, unknown>, userId = aliceId): Hook {
  return {
    id: 'hook-notify', userId, name: 'n', trigger: 'message_received', triggerConfig: {},
    action: 'notify', actionConfig: { notifyMessage: 'hi', ...actionConfig }, isEnabled: true,
  } as unknown as Hook;
}

async function run(actionConfig: Record<string, unknown>, userId?: string) {
  const { executeAction } = await import('./actions');
  return executeAction(notifyHook(actionConfig, userId), {} as never);
}

describe('userOwnsChannel', () => {
  test('recognises channel identities, verified legacy bindings and nothing else', async () => {
    const { userOwnsChannel } = await import('@/channels/ownership');
    expect(await userOwnsChannel(aliceId, 'telegram', 'tg-alice')).toBe(true);
    expect(await userOwnsChannel(aliceId, 'slack', 'U-ALICE')).toBe(true);
    expect(await userOwnsChannel(aliceId, 'telegram', 'tg-bob')).toBe(false);
    expect(await userOwnsChannel(aliceId, 'telegram', 'tg-unknown')).toBe(false);
    // right id, wrong channel type
    expect(await userOwnsChannel(aliceId, 'slack', 'tg-alice')).toBe(false);
    // unverified legacy binding
    expect(await userOwnsChannel(aliceId, 'whatsapp', 'wa-alice-unverified')).toBe(false);
    // in-app surfaces: only the user's own id
    expect(await userOwnsChannel(aliceId, 'webchat', aliceId)).toBe(true);
    expect(await userOwnsChannel(aliceId, 'webchat', bobId)).toBe(false);
    expect(await userOwnsChannel(aliceId, 'api', bobId)).toBe(false);
  });
});

describe('executeNotify target ownership', () => {
  test('sends to the owner’s own linked chats', async () => {
    const r = await run({ notifyChannels: ['telegram:tg-alice', 'slack:U-ALICE', `teams:${aliceTeams}`] });
    expect(r.success).toBe(true);
    expect(sent.calls.map((c) => `${c.type}:${c.id}`)).toEqual([
      'telegram:tg-alice', 'slack:U-ALICE', `teams:${aliceTeams}`,
    ]);
  });

  test('the channelType / channelId pair is checked too', async () => {
    const own = await run({ channelType: 'telegram', channelId: 'tg-alice' });
    expect(own.success).toBe(true);
    expect(sent.calls).toHaveLength(1);

    sent.calls.length = 0;
    const foreign = await run({ channelType: 'telegram', channelId: 'tg-bob' });
    expect(foreign.success).toBe(false);
    expect(foreign.error).toMatch(/linked to your account/);
    expect(sent.calls).toHaveLength(0);
  });

  test('another user’s chat and an unknown chat are skipped, with an error result', async () => {
    const r = await run({ notifyChannels: ['telegram:tg-bob', 'telegram:tg-unknown'] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('telegram:tg-bob');
    expect(r.error).toContain('telegram:tg-unknown');
    expect(sent.calls).toHaveLength(0);
  });

  test('a mix sends only to the owner’s chat and reports the skipped one', async () => {
    const r = await run({ notifyChannels: ['telegram:tg-alice', 'telegram:tg-bob'] });
    expect(r.success).toBe(true);
    expect(sent.calls.map((c) => c.id)).toEqual(['tg-alice']);
    expect((r.data as { skipped: string[] }).skipped).toEqual(['telegram:tg-bob']);
  });

  test('bob’s hook cannot reach alice’s chat', async () => {
    const r = await run({ notifyChannels: ['telegram:tg-alice'] }, bobId);
    expect(r.success).toBe(false);
    expect(sent.calls).toHaveLength(0);
  });

  test('notifyOwner still sends to the owner’s verified legacy bindings', async () => {
    const r = await run({ notifyOwner: true });
    expect(r.success).toBe(true);
    expect(sent.calls.map((c) => `${c.type}:${c.id}`)).toEqual(['slack:U-ALICE']);
  });
});

async function send(method: string, path: string, body: unknown) {
  const res = await aliceApp.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe('hook routes reject foreign notify targets', () => {
  const create = (actionConfig: Record<string, unknown>) => send('POST', '/api/hooks', {
    name: `h-${rand(4)}`, trigger: 'message_received', triggerConfig: {}, action: 'notify', actionConfig,
  });

  test('POST accepts the caller’s own chat', async () => {
    const r = await create({ notifyChannels: ['telegram:tg-alice'] });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
  });

  test('POST rejects another user’s chat with 400', async () => {
    const r = await create({ notifyChannels: ['telegram:tg-bob'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/linked to your account.*telegram:tg-bob/);
  });

  test('POST rejects an unknown chat in the channelType / channelId pair with 400', async () => {
    const r = await create({ channelType: 'slack', channelId: 'C-RANDOM' });
    expect(r.status).toBe(400);
  });

  test('PATCH rejects a foreign chat with 400 and leaves the hook unchanged', async () => {
    const r = await send('PATCH', `/api/hooks/${aliceHookId}`, { actionConfig: { notifyChannels: ['telegram:tg-bob'] } });
    expect(r.status).toBe(400);
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT action_config FROM hooks WHERE id = '${aliceHookId}'`);
    expect((rows[0] as { action_config: Record<string, unknown> }).action_config).toEqual({});
  });

  test('PATCH accepts the caller’s own chat', async () => {
    const r = await send('PATCH', `/api/hooks/${aliceHookId}`, { actionConfig: { notifyChannels: ['slack:U-ALICE'] } });
    expect(r.status).toBe(200);
    expect(r.body.actionConfig).toEqual({ notifyChannels: ['slack:U-ALICE'] });
  });
});
