/**
 * Outbound notification targets: hooks, notifications, monitors and
 * unattended agents may only message the owner's own chats or shared
 * destinations an admin approved (src/channels/ownership.ts).
 *
 * Before this, a user could store `notifyChannels: ['telegram:<any chat>']`
 * (or a channelType / channelId pair, or an execute_tool hook on
 * messaging.send_message) and make the bot message another user's chat, or
 * any chat the bot is in.
 *
 * Seeds (PGlite):
 *  - alice: verified identities telegram:tg-alice, slack:U-ALICE, teams:aad-alice;
 *    an UNVERIFIED identity whatsapp:wa-alice-unverified; a legacy JSON binding
 *    slack:U-ALICE-LEGACY (no row: owned via the canonical fallback); a stale
 *    legacy JSON binding telegram:tg-relinked whose row now belongs to bob.
 *  - bob: telegram:tg-bob, telegram:tg-relinked.
 *  - carol: linked only through channel_identities (the redeem path), no JSON.
 *  - an org "acme" with alice as member; shared destinations: slack:C-ALERTS
 *    (everyone), telegram:-100-acme (acme only), telegram:-100-other (another org).
 *
 * UMI is mocked (sends are recorded); the Teams channel is driven with real
 * Bot Framework activity shapes so its conversation references are real.
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

// execute_tool hooks: the messaging tool runs for real, with a permission
// policy that ALLOWs messaging.send — the case where the old code sent
// anywhere without anyone approving it.
vi.mock('@/security/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/security/permissions')>();
  return { ...actual, getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW' }) }) };
});
const registry = vi.hoisted(() => ({ tools: new Map<string, unknown>() }));
vi.mock('@/tools/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/tools/registry')>()),
  getToolRegistry: () => ({ get: (id: string) => registry.tools.get(id) }),
}));

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
const carolId = '33333333-3333-3333-3333-333333333333';
const adminId = '44444444-4444-4444-4444-444444444444';
const acmeOrg = '55555555-5555-5555-5555-555555555555';
const otherOrg = '66666666-6666-6666-6666-666666666666';
const alicePersonalConv = 'a:1AlicePersonalConversationId';
const groupConv = '19:groupchat123@thread.v2';

let aliceApp: ElysiaLike;
let adminApp: ElysiaLike;
let aliceHookId: string;

let principalMod: typeof import('@/security/principal');

function appFor(uid: string, isAdmin: boolean, plugins: unknown[]): ElysiaLike {
  const { principalFromUser } = principalMod;
  return new Elysia()
    .derive(() => {
      const u = { id: uid, username: 'u', isAdmin };
      return { user: u, session: null, principal: principalFromUser(u) };
    })
    // biome-ignore lint/suspicious/noExplicitAny: plugin chain of heterogeneous route groups
    .group('/api', (a: any) => plugins.reduce((acc: any, p) => acc.use(p), a) as any) as unknown as ElysiaLike;
}

/**
 * A signed-in `/gateway` connection of `userId` on the real hub — the
 * in-app surface `webchat:<userId>` delivers to (one per browser tab). A
 * tab on the chat page subscribes to `chat:inbox`, as the web does.
 */
async function openTab(userId: string, chatPage = true): Promise<{ connectionId: string; frames: Array<Record<string, any>>; close: () => void }> {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const hub = getGatewayHub();
  hub.setSessionValidator(async (token) => (token.startsWith('tab:') ? { userId: token.slice(4), username: 'u', isAdmin: false } : null));
  hub.setWorkspaceResolver(async () => '77777777-7777-4777-8777-777777777777');
  const frames: Array<Record<string, any>> = [];
  const ws = { data: {}, readyState: 1, send: (frame: string) => frames.push(JSON.parse(frame)), close: () => {} };
  const connectionId = hub.connectionManager.handleOpen(ws, '127.0.0.1')!;
  await hub.connectionManager.handleMessage(connectionId, JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token: `tab:${userId}` }, clientType: 'webchat' }));
  expect(frames.at(-1)).toMatchObject({ type: 'auth_ok', userId });
  if (chatPage) {
    await hub.connectionManager.handleMessage(connectionId, JSON.stringify({ type: 'subscribe', resources: ['chat:inbox'] }));
    await vi.waitFor(() => expect(frames.at(-1)).toEqual({ type: 'subscribed', resources: ['chat:inbox'] }));
  }
  return { connectionId, frames, close: () => hub.connectionManager.handleClose(connectionId, 1000) };
}

/** A Bot Framework message activity, as the Teams webhook delivers it. */
function teamsActivity(conversation: { id: string; conversationType: string }, from: { id: string; aadObjectId: string; name: string }) {
  return {
    type: 'message',
    id: `act-${rand(4)}`,
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    from,
    recipient: { id: '28:bot-app-id', name: 'Octipus' },
    conversation,
    text: 'hello',
  };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-notify-owner-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const aliceLegacy = JSON.stringify([
    { channelType: 'slack', channelUserId: 'U-ALICE-LEGACY', isVerified: true, createdAt: '2026-01-01' },
    { channelType: 'telegram', channelUserId: 'tg-relinked', isVerified: true, createdAt: '2026-01-01' },
    { channelType: 'whatsapp', channelUserId: 'wa-legacy-unverified', isVerified: false, createdAt: '2026-01-01' },
  ]);
  await executeRaw(
    `INSERT INTO users (id, username, is_admin, channel_bindings) VALUES
       ('${aliceId}', 'alice', false, '${aliceLegacy}'::jsonb),
       ('${bobId}', 'bob', false, '[]'::jsonb),
       ('${carolId}', 'carol', false, '[]'::jsonb),
       ('${adminId}', 'admin', true, '[]'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
  await executeRaw(
    `INSERT INTO channel_identities (user_id, channel_type, external_id, verified_at) VALUES
       ('${aliceId}', 'telegram', 'tg-alice', now()),
       ('${aliceId}', 'slack', 'U-ALICE', now()),
       ('${aliceId}', 'teams', 'aad-alice', now()),
       ('${aliceId}', 'whatsapp', 'wa-alice-unverified', NULL),
       ('${bobId}', 'telegram', 'tg-bob', now()),
       ('${bobId}', 'telegram', 'tg-relinked', now()),
       ('${carolId}', 'telegram', 'tg-carol', now())`,
  );
  await executeRaw(
    `INSERT INTO organizations (id, slug, name) VALUES ('${acmeOrg}', 'acme', 'Acme'), ('${otherOrg}', 'other', 'Other')`,
  );
  await executeRaw(`INSERT INTO org_members (org_id, user_id) VALUES ('${acmeOrg}', '${aliceId}')`);
  await executeRaw(
    `INSERT INTO notification_destinations (org_id, channel_type, channel_id, label) VALUES
       (NULL, 'slack', 'C-ALERTS', '#alerts'),
       ('${acmeOrg}', 'telegram', '-100-acme', 'acme group'),
       ('${otherOrg}', 'telegram', '-100-other', 'other group')`,
  );
  await executeRaw(
    `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled)
     VALUES ('${aliceId}', 'alice-notify', 'message_received', '{}'::jsonb, 'notify', '{}'::jsonb, true)`,
  );
  const { rows } = await queryRaw(`SELECT id FROM hooks WHERE name = 'alice-notify'`);
  aliceHookId = (rows[0] as { id: string }).id;

  // Teams: alice's 1:1 chat with the bot, and a group chat she spoke in.
  const { teamsChannel } = await import('@/channels/teams');
  const aliceFrom = { id: '29:alice-teams-id', aadObjectId: 'aad-alice', name: 'Alice' };
  for (const conversation of [
    { id: alicePersonalConv, conversationType: 'personal' },
    { id: groupConv, conversationType: 'groupChat' },
  ]) {
    await teamsChannel.handleActivity({
      activity: teamsActivity(conversation, aliceFrom),
      sendActivity: async () => undefined,
    } as never);
  }

  const { MessagingTool } = await import('@/tools/messaging');
  const messaging = new MessagingTool();
  await messaging.initialize();
  registry.tools.set('messaging', messaging);

  principalMod = await import('@/security/principal');
  const { hookRoutes } = await import('@/api/routes/hooks');
  const { recurringTaskRoutes } = await import('@/api/routes/recurring-tasks');
  const { sessionRoutes } = await import('@/api/routes/sessions');
  const { adminRoutes } = await import('@/api/routes/admin');
  aliceApp = appFor(aliceId, false, [hookRoutes, recurringTaskRoutes, sessionRoutes, adminRoutes]);
  adminApp = appFor(adminId, true, [adminRoutes]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(() => {
  sent.calls.length = 0;
});

function hookOf(action: Hook['action'], actionConfig: Record<string, unknown>, userId = aliceId): Hook {
  return {
    id: 'hook-under-test', userId, name: 'n', trigger: 'message_received', triggerConfig: {},
    action, actionConfig, isEnabled: true, sessionId: null,
  } as unknown as Hook;
}

async function notify(actionConfig: Record<string, unknown>, userId?: string) {
  const { executeAction } = await import('./actions');
  return executeAction(hookOf('notify', { notifyMessage: 'hi', ...actionConfig }, userId), {} as never);
}

const sentTo = () => sent.calls.map((c) => `${c.type}:${c.id}`);

describe('canNotify', () => {
  test('own verified identities are allowed; foreign, unknown and unverified ones are not', async () => {
    const { canNotify } = await import('@/channels/ownership');
    expect(await canNotify(aliceId, 'telegram', 'tg-alice')).toBe(true);
    expect(await canNotify(aliceId, 'slack', 'U-ALICE')).toBe(true);
    expect(await canNotify(aliceId, 'telegram', 'tg-bob')).toBe(false);
    expect(await canNotify(aliceId, 'telegram', 'tg-unknown')).toBe(false);
    expect(await canNotify(aliceId, 'slack', 'tg-alice')).toBe(false); // right id, wrong type
    // channel_identities row with verified_at NULL
    expect(await canNotify(aliceId, 'whatsapp', 'wa-alice-unverified')).toBe(false);
    // unverified legacy JSON entry
    expect(await canNotify(aliceId, 'whatsapp', 'wa-legacy-unverified')).toBe(false);
  });

  test('legacy JSON counts only through the canonical lookup', async () => {
    const { canNotify } = await import('@/channels/ownership');
    // no row: only alice holds a verified legacy entry, so it is hers
    expect(await canNotify(aliceId, 'slack', 'U-ALICE-LEGACY')).toBe(true);
    // stale: the chat was relinked to bob, alice's JSON entry no longer counts
    expect(await canNotify(aliceId, 'telegram', 'tg-relinked')).toBe(false);
    expect(await canNotify(bobId, 'telegram', 'tg-relinked')).toBe(true);
  });

  test('resolving targets never writes (no backfill outside the inbound path)', async () => {
    const { canNotify, loadNotifyScope } = await import('@/channels/ownership');
    const { queryRaw } = await import('@/db/postgres');
    await loadNotifyScope(aliceId);
    expect(await canNotify(aliceId, 'slack', 'U-ALICE-LEGACY')).toBe(true);
    const { rows } = await queryRaw(`SELECT 1 FROM channel_identities WHERE external_id = 'U-ALICE-LEGACY'`);
    expect(rows).toHaveLength(0);
  });

  test('a legacy chat claimed (verified) by two users belongs to neither', async () => {
    const { executeRaw } = await import('@/db/postgres');
    const shared = { channelType: 'slack', channelUserId: 'U-SHARED', isVerified: true, createdAt: '2026-01-01' };
    for (const id of [aliceId, bobId]) {
      await executeRaw(
        `UPDATE users SET channel_bindings = channel_bindings || '${JSON.stringify([shared])}'::jsonb WHERE id = '${id}'`,
      );
    }
    const { canNotify } = await import('@/channels/ownership');
    expect(await canNotify(aliceId, 'slack', 'U-SHARED')).toBe(false);
    expect(await canNotify(bobId, 'slack', 'U-SHARED')).toBe(false);
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    expect(await getChannelBindingManager().findUserByExternalId('slack', 'U-SHARED')).toBeNull();
  });

  test('the inbound lookup ignores unverified legacy entries', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    expect(await getChannelBindingManager().findUserByExternalId('whatsapp', 'wa-legacy-unverified')).toBeNull();
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT 1 FROM channel_identities WHERE external_id = 'wa-legacy-unverified'`);
    expect(rows).toHaveLength(0);
  });

  test('admin-approved shared destinations: instance-wide, and per org for members only', async () => {
    const { canNotify } = await import('@/channels/ownership');
    expect(await canNotify(aliceId, 'slack', 'C-ALERTS')).toBe(true);
    expect(await canNotify(bobId, 'slack', 'C-ALERTS')).toBe(true);
    expect(await canNotify(aliceId, 'telegram', '-100-acme')).toBe(true);
    expect(await canNotify(bobId, 'telegram', '-100-acme')).toBe(false);
    expect(await canNotify(aliceId, 'telegram', '-100-other')).toBe(false);
  });

  test('webchat/api: only the user’s own id', async () => {
    const { canNotify } = await import('@/channels/ownership');
    expect(await canNotify(aliceId, 'webchat', aliceId)).toBe(true);
    expect(await canNotify(aliceId, 'api', aliceId)).toBe(true);
    expect(await canNotify(aliceId, 'webchat', bobId)).toBe(false);
    const tab = await openTab(aliceId);
    try {
      // a raw connection id is not a target, even the user's own
      expect(await canNotify(aliceId, 'webchat', tab.connectionId)).toBe(false);
    } finally {
      tab.close();
    }
  });

  test('Teams: the owner’s identity and 1:1 conversation, never a group chat she spoke in', async () => {
    const { canNotify } = await import('@/channels/ownership');
    expect(await canNotify(aliceId, 'teams', 'aad-alice')).toBe(true);
    expect(await canNotify(aliceId, 'teams', alicePersonalConv)).toBe(true);
    expect(await canNotify(aliceId, 'teams', groupConv)).toBe(false);
    expect(await canNotify(bobId, 'teams', alicePersonalConv)).toBe(false);
  });

  test('Teams conversation references survive a restart (persisted in kv_store)', async () => {
    const { teamsChannel } = await import('@/channels/teams');
    await teamsChannel.disconnect(); // drops the in-memory references, as a restart would
    expect(teamsChannel.hasConversation(alicePersonalConv)).toBe(false);
    const { canNotify, loadNotifyScope, resolveTarget } = await import('@/channels/ownership');
    expect(await canNotify(aliceId, 'teams', alicePersonalConv)).toBe(true); // reloaded lazily
    expect(teamsChannel.personalConversationsFor('aad-alice')).toEqual([alicePersonalConv]);
    // a conversation the bot has never seen: ownership can't be told yet
    const r = await resolveTarget(await loadNotifyScope(aliceId), 'teams', 'a:never-seen');
    expect(r.allowed).toBe(false);
    expect(!r.allowed && r.reason).toBe('unresolved');
    expect(!r.allowed && r.error).toMatch(/must message the bot in Teams once/);
  });
});

describe('executeNotify', () => {
  test('sends to the owner’s own linked chats', async () => {
    const r = await notify({ notifyChannels: ['telegram:tg-alice', 'slack:U-ALICE'] });
    expect(r.success).toBe(true);
    expect(sentTo()).toEqual(['telegram:tg-alice', 'slack:U-ALICE']);
  });

  test('another user’s chat and an unknown chat are skipped, with an error result', async () => {
    const r = await notify({ notifyChannels: ['telegram:tg-bob', 'telegram:tg-unknown'] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('telegram:tg-bob');
    expect(r.error).toContain('Admin → Notification destinations');
    expect(sent.calls).toHaveLength(0);
  });

  test('the channelType / channelId pair is checked too', async () => {
    expect((await notify({ channelType: 'telegram', channelId: 'tg-bob' })).success).toBe(false);
    expect(sent.calls).toHaveLength(0);
    expect((await notify({ channelType: 'telegram', channelId: 'tg-alice' })).success).toBe(true);
    expect(sentTo()).toEqual(['telegram:tg-alice']);
  });

  test('a mix sends only to allowed targets and reports the skipped ones', async () => {
    const r = await notify({ notifyChannels: ['telegram:tg-alice', 'telegram:tg-bob', 'slack:C-ALERTS'] });
    expect(r.success).toBe(true);
    expect(sentTo()).toEqual(['telegram:tg-alice', 'slack:C-ALERTS']);
    expect((r.data as { skipped: string[] }).skipped).toEqual(['telegram:tg-bob']);
  });

  test('an approved org destination works for members only', async () => {
    expect((await notify({ notifyChannels: ['telegram:-100-acme'] })).success).toBe(true);
    expect((await notify({ notifyChannels: ['telegram:-100-acme'] }, bobId)).success).toBe(false);
  });

  test('a Teams identity is delivered to the owner’s 1:1 conversation', async () => {
    const r = await notify({ notifyChannels: ['teams:aad-alice'] });
    expect(r.success).toBe(true);
    expect(sentTo()).toEqual([`teams:${alicePersonalConv}`]);
  });

  test('webchat:<ownId> is delivered to all of the owner’s gateway tabs as a user-stamped chat.message', async () => {
    const tabs = [await openTab(aliceId), await openTab(aliceId)];
    const bobTab = await openTab(bobId);
    try {
      const r = await notify({ notifyChannels: [`webchat:${aliceId}`] });
      expect(r.success).toBe(true);
      for (const tab of tabs) {
        const delivered = tab.frames.filter((f) => f.type === 'event' && f.event.type === 'chat.message');
        expect(delivered).toHaveLength(1);
        expect(delivered[0].event).toMatchObject({ userId: aliceId, payload: { role: 'assistant', proactive: true } });
      }
      expect(bobTab.frames.filter((f) => f.type === 'event')).toEqual([]);
    } finally {
      for (const tab of [...tabs, bobTab]) tab.close();
    }
  });

  test('webchat:<ownId> is not delivered when no open connection shows the chat page', async () => {
    const terminal = await openTab(aliceId, false);
    try {
      const r = await notify({ notifyChannels: [`webchat:${aliceId}`] });
      expect(r.success).toBe(false);
      expect(terminal.frames.filter((f) => f.type === 'event' && f.event.type === 'chat.message')).toEqual([]);
    } finally {
      terminal.close();
    }
  });

  test('notifyOwner uses canonical identities: a redeem-only user gets "Notify me"', async () => {
    const r = await notify({ notifyOwner: true }, carolId);
    expect(r.success).toBe(true);
    expect(sentTo()).toEqual(['telegram:tg-carol']);
  });

  test('notifyOwner skips unverified and relinked chats', async () => {
    await notify({ notifyOwner: true });
    const targets = sentTo();
    expect(targets).toContain('telegram:tg-alice');
    expect(targets).toContain(`teams:${alicePersonalConv}`);
    expect(targets).not.toContain('telegram:tg-relinked');
    expect(targets).not.toContain('whatsapp:wa-alice-unverified');
  });
});

describe('execute_tool hooks on the messaging tool run unattended', () => {
  async function runTool(toolAction: string, toolParams: Record<string, unknown>) {
    const { executeAction } = await import('./actions');
    return executeAction(hookOf('execute_tool', { toolId: 'messaging', toolAction, toolParams }), {} as never);
  }

  test('send_message to another user’s chat is refused', async () => {
    const r = await runTool('send_message', { channel: 'telegram', target: 'tg-bob', message: 'x' });
    expect((r.data as { success: boolean }).success).toBe(false);
    expect(sent.calls).toHaveLength(0);
  });

  test('send_message to the owner’s chat or an approved destination goes through', async () => {
    await runTool('send_message', { channel: 'telegram', target: 'tg-alice', message: 'x' });
    await runTool('send_message', { channel: 'slack', target: 'C-ALERTS', message: 'x' });
    expect(sentTo()).toEqual(['telegram:tg-alice', 'slack:C-ALERTS']);
  });

  test('send_to_user can only target the hook owner', async () => {
    const other = await runTool('send_to_user', { user_id: bobId, message: 'x' });
    expect((other.data as { success: boolean }).success).toBe(false);
    expect(sent.calls).toHaveLength(0);
    const self = await runTool('send_to_user', { user_id: aliceId, message: 'x', channel: 'telegram' });
    expect((self.data as { success: boolean }).success).toBe(true);
    expect(sentTo()).toEqual(['telegram:tg-alice']);
  });

  test('an admin’s execute_tool hook cannot send_to_user another user either (run time and save time agree)', async () => {
    const { executeAction, notifyTargetsError } = await import('./actions');
    const cfg = { toolId: 'messaging', toolAction: 'send_to_user', toolParams: { user_id: aliceId, message: 'x' } };
    const r = await executeAction(hookOf('execute_tool', cfg, adminId), {} as never);
    expect((r.data as { success: boolean }).success).toBe(false);
    expect(sent.calls).toHaveLength(0);
    expect(await notifyTargetsError(adminId, cfg)).toMatch(/can only message you/);
  });
});

async function send(app: ElysiaLike, method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe('save-time validation', () => {
  const create = (action: string, actionConfig: Record<string, unknown>) => send(aliceApp, 'POST', '/api/hooks', {
    name: `h-${rand(4)}`, trigger: 'message_received', triggerConfig: {}, action, actionConfig,
  });

  test('POST /api/hooks accepts own chats and approved destinations', async () => {
    const r = await create('notify', { notifyChannels: ['telegram:tg-alice', 'slack:C-ALERTS', `webchat:${aliceId}`] });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
  });

  test('POST /api/hooks rejects a foreign chat with a 400 pointing at the admin allowlist', async () => {
    const r = await create('notify', { notifyChannels: ['telegram:tg-bob'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(
      'telegram:tg-bob is not linked to you and not an approved shared destination; ask an admin to add it under Admin → Notification destinations',
    );
  });

  test('POST /api/hooks rejects a raw webchat connection id', async () => {
    const tab = await openTab(aliceId);
    try {
      expect((await create('notify', { notifyChannels: [`webchat:${tab.connectionId}`] })).status).toBe(400);
    } finally {
      tab.close();
    }
  });

  test('POST /api/hooks rejects execute_tool messaging hooks aimed at someone else', async () => {
    const msg = await create('execute_tool', { toolId: 'messaging', toolAction: 'send_message', toolParams: { channel: 'telegram', target: 'tg-bob', message: 'x' } });
    expect(msg.status).toBe(400);
    const toUser = await create('execute_tool', { toolId: 'messaging', toolAction: 'send_to_user', toolParams: { user_id: bobId, message: 'x' } });
    expect(toUser.status).toBe(400);
    const own = await create('execute_tool', { toolId: 'messaging', toolAction: 'send_message', toolParams: { channel: 'telegram', target: 'tg-alice', message: 'x' } });
    expect(own.status).toBe(200);
  });

  test('PATCH /api/hooks rejects a foreign chat and leaves the hook unchanged', async () => {
    const r = await send(aliceApp, 'PATCH', `/api/hooks/${aliceHookId}`, { actionConfig: { notifyChannels: ['telegram:tg-bob'] } });
    expect(r.status).toBe(400);
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT action_config FROM hooks WHERE id = '${aliceHookId}'`);
    expect((rows[0] as { action_config: Record<string, unknown> }).action_config).toEqual({});
    const ok = await send(aliceApp, 'PATCH', `/api/hooks/${aliceHookId}`, { actionConfig: { notifyChannels: ['slack:U-ALICE'] } });
    expect(ok.status).toBe(200);
  });

  test('a hook holding an old invalid target stays editable; only new targets are checked; GET flags it', async () => {
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled)
       VALUES ('${aliceId}', 'legacy-team-hook', 'message_received', '{}'::jsonb, 'notify',
               '{"notifyChannels":["slack:general"],"notifyMessage":"old"}'::jsonb, true) RETURNING id`,
    );
    const id = (rows[0] as { id: string }).id;
    try {
      const got = await send(aliceApp, 'GET', `/api/hooks/${id}`);
      expect(got.body.invalidTargets).toEqual(['slack:general']);
      const list = await send(aliceApp, 'GET', '/api/hooks');
      expect(list.body.hooks.find((h: { id: string }) => h.id === id).invalidTargets).toEqual(['slack:general']);

      // editing the message (target unchanged) is allowed
      const edit = await send(aliceApp, 'PATCH', `/api/hooks/${id}`, { actionConfig: { notifyChannels: ['slack:general'], notifyMessage: 'new' } });
      expect(edit.status).toBe(200);
      // adding another invalid target is not
      const add = await send(aliceApp, 'PATCH', `/api/hooks/${id}`, { actionConfig: { notifyChannels: ['slack:general', 'telegram:tg-bob'] } });
      expect(add.status).toBe(400);
      expect(add.body.error).toContain('telegram:tg-bob');
      expect(add.body.error).not.toContain('slack:general');

      const { reportInvalidHookTargets } = await import('./actions');
      const report = await reportInvalidHookTargets();
      expect(report.find((r) => r.userId === aliceId)).toMatchObject({ hooks: 1, targets: 1 });
    } finally {
      await executeRaw(`DELETE FROM hooks WHERE id = '${id}'`);
    }
  });

  test('migration 0117 rewrites stored in-app targets to webchat:<ownerId>', async () => {
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `INSERT INTO hooks (user_id, name, trigger, trigger_config, action, action_config, is_enabled) VALUES
         ('${aliceId}', 'webchat-conn', 'message_received', '{}'::jsonb, 'notify', '{"notifyChannels":["webchat:conn-123","telegram:tg-alice","api:x"]}'::jsonb, false),
         ('${aliceId}', 'webchat-pair', 'message_received', '{}'::jsonb, 'notify', '{"channelType":"api","channelId":"whatever"}'::jsonb, false)
       RETURNING id, name`,
    );
    const { readFileSync } = await import('node:fs');
    const sqlText = readFileSync(join(process.cwd(), 'src/db/migrations/0117_hook_inapp_targets.sql'), 'utf8');
    for (const stmt of sqlText.split('--> statement-breakpoint')) await executeRaw(stmt);
    const after = await queryRaw(`SELECT name, action_config FROM hooks WHERE name IN ('webchat-conn', 'webchat-pair')`);
    const byName = Object.fromEntries(after.rows.map((r: any) => [r.name, r.action_config]));
    expect([...byName['webchat-conn'].notifyChannels].sort()).toEqual(['telegram:tg-alice', `webchat:${aliceId}`].sort());
    expect(byName['webchat-pair']).toMatchObject({ channelType: 'webchat', channelId: aliceId });
    await executeRaw(`DELETE FROM hooks WHERE id IN (${rows.map((r: any) => `'${r.id}'`).join(',')})`);
  });

  test('POST /api/recurring-tasks rejects an execute_tool messaging task aimed at someone else', async () => {
    const r = await send(aliceApp, 'POST', '/api/recurring-tasks', {
      name: 'nightly', cronExpression: '0 3 * * *', actionType: 'execute_tool',
      actionConfig: { toolId: 'messaging', toolAction: 'send_message', toolParams: { channel: 'telegram', target: 'tg-bob', message: 'x' } },
    });
    expect(r.status).toBe(400);
  });

  test('POST /api/sessions only creates sessions on channels the caller may notify', async () => {
    const foreign = await send(aliceApp, 'POST', '/api/sessions', { channelType: 'telegram', channelId: 'tg-bob' });
    expect(foreign.status).toBe(400);
    const own = await send(aliceApp, 'POST', '/api/sessions', { channelType: 'telegram', channelId: 'tg-alice' });
    expect(own.status).toBe(200);
    const inApp = await send(aliceApp, 'POST', '/api/sessions', { channelType: 'webchat', channelId: 'chat-123' });
    expect(inApp.status).toBe(200);
  });

  test.each(['mcp', 'tui', 'acp', 'mobile', 'web'])('POST /api/sessions still creates %s client sessions', async (channelType) => {
    const r = await send(aliceApp, 'POST', '/api/sessions', { channelType, channelId: `${channelType}-${rand(4)}` });
    expect(r.status).toBe(200);
    expect(r.body.channelType).toBe(channelType);
  });

  test('PATCH /api/sessions cannot move a session to another chat', async () => {
    const own = await send(aliceApp, 'POST', '/api/sessions', { channelType: 'webchat', channelId: 'chat-x' });
    const r = await send(aliceApp, 'PATCH', `/api/sessions/${own.body.id}`, { title: 't', channelType: 'telegram', channelId: 'tg-bob' });
    expect(r.status).toBe(200);
    expect(r.body.channelType).toBe('webchat');
    expect(r.body.channelId).toBe('chat-x');
  });
});

describe('monitor delivery', () => {
  async function deliverTo(channelType: string, channelId: string) {
    const { queryRaw } = await import('@/db/postgres');
    // Seeded directly: a session row is what a gateway client or an older
    // POST /api/sessions could leave behind.
    const existing = await queryRaw(
      `SELECT id FROM sessions WHERE user_id = '${aliceId}' AND channel_type = '${channelType}' AND channel_id = '${channelId}'`,
    );
    const { rows } = existing.rows.length > 0 ? existing : await queryRaw(
      `INSERT INTO sessions (user_id, channel_type, channel_id) VALUES ('${aliceId}', '${channelType}', '${channelId}') RETURNING id`,
    );
    const sessionId = (rows[0] as { id: string }).id;
    const { deliverMonitorResponse } = await import('@/core/monitors/delivery');
    return deliverMonitorResponse(
      { id: 'mon', sessionId, userId: aliceId, generation: '' } as never,
      { response: 'done', sessionId, classification: { type: 'casual', confidence: 1 } } as never,
    );
  }

  test('replies reach the owner’s own chat', async () => {
    await deliverTo('telegram', 'tg-alice');
    expect(sentTo()).toEqual(['telegram:tg-alice']);
  });

  test('a session pointed at another user’s chat gets no reply', async () => {
    await expect(deliverTo('telegram', 'tg-bob')).rejects.toThrow(/Admin → Notification destinations/);
    expect(sent.calls).toHaveLength(0);
  });
});

describe('admin notification destinations', () => {
  test('non-admins cannot list or add', async () => {
    expect((await send(aliceApp, 'GET', '/api/admin/notification-destinations')).status).toBe(403);
    expect((await send(aliceApp, 'POST', '/api/admin/notification-destinations', { channelType: 'slack', channelId: 'C-X' })).status).toBe(403);
  });

  test('add, list, reject duplicates, delete; each change is audited and takes effect', async () => {
    const { canNotify } = await import('@/channels/ownership');
    expect(await canNotify(bobId, 'slack', 'C-OPS')).toBe(false);

    const added = await send(adminApp, 'POST', '/api/admin/notification-destinations', { channelType: 'slack', channelId: 'C-OPS', label: '#ops' });
    expect(added.status).toBe(201);
    expect(await canNotify(bobId, 'slack', 'C-OPS')).toBe(true);

    const dup = await send(adminApp, 'POST', '/api/admin/notification-destinations', { channelType: 'slack', channelId: 'C-OPS' });
    expect(dup.status).toBe(409);
    expect((await send(adminApp, 'POST', '/api/admin/notification-destinations', { channelType: 'webchat', channelId: aliceId })).status).toBe(400);
    expect((await send(adminApp, 'POST', '/api/admin/notification-destinations', { channelType: 'slack', channelId: 'C-Y', orgId: '77777777-7777-7777-7777-777777777777' })).status).toBe(404);

    const list = await send(adminApp, 'GET', '/api/admin/notification-destinations');
    expect(list.body.destinations.map((d: { channelId: string }) => d.channelId)).toContain('C-OPS');

    const del = await send(adminApp, 'DELETE', `/api/admin/notification-destinations/${added.body.id}`);
    expect(del.body).toEqual({ deleted: true });
    expect(await canNotify(bobId, 'slack', 'C-OPS')).toBe(false);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT details FROM audit_log WHERE resource_type = 'notification_destination' AND resource_id = '${added.body.id}'`,
    );
    expect(rows).toHaveLength(2);
  });
});

describe('unbind', () => {
  test('removes the legacy JSON entry from every user so the chat does not come back', async () => {
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    const entry = '[{"channelType":"telegram","channelUserId":"tg-dan","isVerified":true,"createdAt":"2026-01-01"}]';
    await executeRaw(`UPDATE users SET channel_bindings = '${entry}'::jsonb WHERE id = '${carolId}'`);
    // a stale copy on another user (and one stored as a JSON string)
    await executeRaw(`UPDATE users SET channel_bindings = to_jsonb('${entry}'::text) WHERE id = '${adminId}'`);
    await executeRaw(`INSERT INTO channel_identities (user_id, channel_type, external_id, verified_at) VALUES ('${carolId}', 'telegram', 'tg-dan', now())`);
    const { canNotify } = await import('@/channels/ownership');
    expect(await canNotify(carolId, 'telegram', 'tg-dan')).toBe(true);
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    expect(await getChannelBindingManager().unbind(carolId, 'telegram', 'tg-dan')).toBe(true);
    expect(await canNotify(carolId, 'telegram', 'tg-dan')).toBe(false);
    expect(await getChannelBindingManager().findUserByExternalId('telegram', 'tg-dan')).toBeNull();
    const { rows } = await queryRaw(`SELECT id FROM users WHERE channel_bindings::text LIKE '%tg-dan%'`);
    expect(rows).toHaveLength(0);
  });
});
