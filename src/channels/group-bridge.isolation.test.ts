/**
 * The group-channel bridge and space connectors (docs/plans/coworking-spec.md
 * §9.4, §9.5, §9.6).
 *
 *   - binding needs the acknowledgement and a space owner who owns the
 *     channel; it closes the members' thread sessions and is audited;
 *   - a linked member who is not in the space gets a private hint, no turn;
 *     a member's message becomes a room post and a room turn as them;
 *   - the room is read in the thread (relay); taken tasks land on the space's
 *     board, once per message;
 *   - a space secret is unusable through `{{secret:}}` and never exempts a
 *     call from the flow guard; personal paths never return it;
 *   - space connector routes: members list, owners connect and disconnect;
 *   - the GitHub tool in a space never uses the host's gh identity.
 *
 * Driven through the real routes (`createServer()`), the real group handler
 * and the real bridge. Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

/** What the bridge sent to the platform. */
const sent: Array<{ kind: 'send' | 'private'; channelId: string; userId?: string; content: string; threadId?: string }> = [];
vi.mock('@/channels/interface', () => ({
  getUMI: () => ({
    send: async (_type: string, channelId: string, r: { content: string; threadId?: string }) => {
      sent.push({ kind: 'send', channelId, content: r.content, threadId: r.threadId });
      return 'm';
    },
    sendPrivate: async (_type: string, channelId: string, userId: string, r: { content: string; threadId?: string }) => {
      sent.push({ kind: 'private', channelId, userId, content: r.content, threadId: r.threadId });
      return true;
    },
    setReaction: async () => undefined,
  }),
}));

const ownerId = randomUUID();
const editorId = randomUUID();
const outsiderId = randomUUID();
const otherOwnerId = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let spaceId: string;

async function call(who: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function enrol(owner: string, channelId: string) {
  const { joinGroupChannel } = await import('@/channels/group-channels');
  const result = await joinGroupChannel({ channelType: 'slack', channelId, label: `#${channelId}`, userId: owner });
  if (result.status !== 'enrolled') throw new Error(result.status);
  return result.group;
}

async function auditRows(resourceId: string) {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT action, user_id, workspace_id, details FROM audit_log WHERE resource_id = '${resourceId}' AND workspace_id IS NOT NULL ORDER BY created_at`);
  return rows as Array<{ action: string; user_id: string; workspace_id: string; details: Record<string, unknown> }>;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-bridge-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'owner' },
    { id: editorId, username: 'editor' },
    { id: outsiderId, username: 'outsider' },
    { id: otherOwnerId, username: 'other' },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', ownerId], ['editor', editorId], ['outsider', outsiderId], ['other', otherOwnerId]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { createServer } = await import('@/api/server');
  app = createServer();
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(ownerId, [[editorId, 'editor'], [otherOwnerId, 'editor']], 'Launch');
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('binding a channel (§9.4 points 1–2)', () => {
  test('needs the acknowledgement, a space owner, and the channel\'s owner; closes thread sessions; audited', async () => {
    const group = await enrol(ownerId, 'C-BIND');
    const { resolveGroupSession } = await import('@/channels/group-channels');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const editorThread = await resolveGroupSession({ userId: editorId, group, threadId: 't1' });

    // No acknowledgement: refused, nothing bound.
    let res = await call('owner', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: false });
    expect(res.status).toBe(400);
    // Someone else's channel answers like a missing one.
    res = await call('other', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    expect(res.status).toBe(404);
    // The channel's owner of a channel, but only an editor of the space.
    const othersGroup = await enrol(otherOwnerId, 'C-OTHER');
    res = await call('other', 'POST', `/api/me/group-channels/${othersGroup.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    expect(res.status).toBe(403);
    // A space the caller is not in: 404.
    res = await call('outsider', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    expect(res.status).toBe(404);
    expect((await sessionRepository.findById(editorThread))?.status).toBe('active');

    res = await call('owner', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    expect(res.status).toBe(200);
    expect((await res.json()).groupChannel.workspaceId).toBe(spaceId);
    expect((await sessionRepository.findById(editorThread))?.status).toBe('completed');
    const [row] = await auditRows(group.id);
    expect(row).toMatchObject({ action: 'space_updated', user_id: ownerId, workspace_id: spaceId });
    expect(row.details).toMatchObject({ bound: true, closedSessions: 1 });
    expect(String(row.details.acknowledged)).toContain('Everyone in this channel can read what the room shows');

    const list = await (await call('owner', 'GET', '/api/me/group-channels')).json();
    expect(list.groupChannels.find((g: { id: string }) => g.id === group.id)).toMatchObject({ workspaceId: spaceId, spaceName: 'Launch' });

    // Unbinding is audited too; the thread's rooms stay in the space.
    const roomId = await resolveGroupSession({ userId: editorId, group: { ...group, workspaceId: spaceId }, threadId: 't2', title: 'Hi' });
    res = await call('owner', 'DELETE', `/api/me/group-channels/${group.id}/bind`);
    expect(res.status).toBe(200);
    expect((await auditRows(group.id)).at(-1)?.details).toMatchObject({ bound: false, reason: 'unbound' });
    expect((await sessionRepository.findById(roomId))?.kind).toBe('room');
  });

  test('a take-over of the channel ends its binding', async () => {
    const group = await enrol(ownerId, 'C-TAKEOVER');
    await call('owner', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { eq } = await import('drizzle-orm');
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, ownerId));
    try {
      const { joinGroupChannel } = await import('@/channels/group-channels');
      const result = await joinGroupChannel({ channelType: 'slack', channelId: 'C-TAKEOVER', userId: editorId });
      expect(result.status).toBe('took_over');
      if (result.status === 'took_over') expect(result.group.workspaceId).toBeNull();
      expect((await auditRows(group.id)).at(-1)?.details).toMatchObject({ bound: false, reason: 'owner_changed' });
    } finally {
      await getDb().update(users).set({ isActive: true }).where(eq(users.id, ownerId));
    }
  });
});

describe('turns in a bound channel (§9.4 points 3–4)', () => {
  test('a linked member who is not in the space gets a private hint and no turn', async () => {
    const group = await enrol(ownerId, 'C-HINT');
    await call('owner', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    const { findGroupChannel } = await import('@/channels/group-channels');
    const bound = await findGroupChannel('slack', 'C-HINT');
    const { handleGroupMessage, groupHints } = await import('@/channels/group-handler');
    const members: Record<string, { id: string; username: string; isActive: boolean; isAdmin: boolean }> = {
      UOUT: { id: outsiderId, username: 'outsider', isActive: true, isAdmin: false },
      UED: { id: editorId, username: 'editor', isActive: true, isAdmin: false },
    };
    const privateHints: string[] = [];
    const dispatched: string[] = [];
    const deps = {
      botUserId: 'UBOT', bot: '<@UBOT>',
      hints: groupHints({ platform: 'Slack', linkHow: 'send me link', takeAlso: 'or react', followHow: 'I follow threads' }),
      findGroup: async () => bound,
      isGroupActive: async () => true,
      isThreadActive: async () => false,
      findMember: async (u: string) => members[u] ?? null,
      join: async () => { throw new Error('no'); },
      leave: async () => { throw new Error('no'); },
      channelLabel: async () => null,
      displayName: async (u: string) => u,
      postPrivate: async (_u: string, text: string) => { privateHints.push(text); },
      postInThread: async () => undefined,
      readContext: async () => '',
      readMessage: async () => null,
      permalink: async () => undefined,
      budgetPause: async () => null,
      shouldSendHint: () => true,
      dispatch: (input: { member: { id: string } }) => { dispatched.push(input.member.id); },
    };
    const base = { channelId: 'C-HINT', messageId: '1.1', replyThread: '1.1', text: 'what is the status?', mentioned: true, hasFiles: false };
    expect(await handleGroupMessage({ ...base, user: 'UOUT' }, deps)).toBe('hint');
    expect(privateHints[0]).toContain('not a member');
    expect(dispatched).toEqual([]);
    expect(await handleGroupMessage({ ...base, messageId: '1.2', replyThread: '1.2', user: 'UED' }, deps)).toBe('dispatched');
    expect(dispatched).toEqual([editorId]);
  });

  test('a member\'s message is a post in the thread\'s room and a room turn as them; the room is read in the thread', async () => {
    const group = await enrol(ownerId, 'C-TURN');
    await call('owner', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    const { findGroupChannel } = await import('@/channels/group-channels');
    const bound = (await findGroupChannel('slack', 'C-TURN'))!;
    const { getAgentService } = await import('@/core/agent');
    const asked = vi.spyOn(getAgentService(), 'handleRoomMessage').mockResolvedValue({ kind: 'queued', position: 0 });
    const { handleBridgedTurn, bridgedRoomOf, relayRoomMessage } = await import('@/channels/group-bridge');
    const message = {
      id: randomUUID(), channelType: 'slack' as const, channelId: 'C-TURN', userId: editorId, userName: 'Ed',
      content: 'summarise the launch plan', threadId: '9.9', timestamp: new Date(), metadata: { messageId: '9.9' },
    };
    // Outsider: refused privately, nothing posted.
    sent.length = 0;
    expect(await handleBridgedTurn({ message: { ...message, userId: outsiderId }, group: bound, context: '' })).toBe('refused');
    expect(sent).toEqual([expect.objectContaining({ kind: 'private', userId: outsiderId })]);
    expect(await bridgedRoomOf(bound.id, '9.9')).toBeNull();

    expect(await handleBridgedTurn({ message, group: bound, context: 'TRANSCRIPT' })).toBe('queued');
    const roomId = (await bridgedRoomOf(bound.id, '9.9'))!;
    expect(asked).toHaveBeenCalledWith(roomId, editorId, expect.any(String), expect.objectContaining({ requester: 'Ed', context: 'TRANSCRIPT' }));
    const { messageRepository } = await import('@/db/repositories/message-repository');
    const post = await messageRepository.findById(asked.mock.calls[0]![2]);
    expect(post).toMatchObject({ sessionId: roomId, authorUserId: editorId, content: 'summarise the launch plan' });

    // Relay: the bridged post is not echoed; a reply and a web post are.
    sent.length = 0;
    await relayRoomMessage(post!);
    const reply = await messageRepository.create({ sessionId: roomId, role: 'assistant', content: 'Here is the plan.' });
    await relayRoomMessage(reply);
    const { postRoomMessage } = await import('@/core/rooms/service');
    const web = await postRoomMessage({ userId: ownerId }, roomId, { content: 'from the web' });
    const webRow = await messageRepository.findById(web.message.id);
    await relayRoomMessage(webRow!);
    expect(sent).toEqual([
      expect.objectContaining({ kind: 'send', channelId: 'C-TURN', threadId: '9.9', content: 'Here is the plan.' }),
      expect.objectContaining({ kind: 'send', channelId: 'C-TURN', threadId: '9.9', content: expect.stringContaining('from the web') }),
    ]);
    asked.mockRestore();
  });

  test('taken tasks go on the space board, one task per message whoever takes it', async () => {
    const group = await enrol(ownerId, 'C-TAKE');
    await call('owner', 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId: spaceId, acknowledged: true });
    const { findGroupChannel } = await import('@/channels/group-channels');
    const bound = (await findGroupChannel('slack', 'C-TAKE'))!;
    const { getAgentService } = await import('@/core/agent');
    const asked = vi.spyOn(getAgentService(), 'handleRoomMessage').mockResolvedValue({ kind: 'queued', position: 0 });
    const { handleBridgedTurn } = await import('@/channels/group-bridge');
    const take = { text: 'Fix the release notes', messageKey: 'C-TAKE:5.5' };
    const base = { id: randomUUID(), channelType: 'slack' as const, channelId: 'C-TAKE', content: 'take this', threadId: '5.5', timestamp: new Date(), metadata: {} };
    expect(await handleBridgedTurn({ message: { ...base, userId: editorId, userName: 'Ed' }, group: bound, context: '', take })).toBe('queued');
    expect(await handleBridgedTurn({ message: { ...base, userId: ownerId, userName: 'Own' }, group: bound, context: '', take })).toBe('already_taken');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { spaceRepos } = await import('@/db/repositories/space');
    const board = await spaceRepos(await resolvedPrincipal(ownerId, spaceId)).tasks.listOwn();
    const taken = board.filter((t) => t.source === 'channel' && t.title === 'Fix the release notes');
    expect(taken).toHaveLength(1);
    expect(taken[0].workspaceId).toBe(spaceId);
    // Never on a member's personal board.
    const { scopedRepos } = await import('@/db/repositories/scoped');
    const personal = await scopedRepos(await resolvedPrincipal(editorId, null)).tasks.listOwn();
    expect(personal.some((t) => t.title === 'Fix the release notes')).toBe(false);
    asked.mockRestore();
  });
});

describe('space secrets (§9.5)', () => {
  test('a space secret is unusable via {{secret:}}, never exempts a call, and never shows on a personal path', async () => {
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { spaceRepos } = await import('@/db/repositories/space');
    const owner = await resolvedPrincipal(ownerId, spaceId);
    await spaceRepos(owner).secrets.write('team_token', 'space-value-123', 'api_key');
    expect(await spaceRepos(owner).secrets.read('team_token')).toBe('space-value-123');

    const { injectSecrets } = await import('@/security/secret-injector');
    const injected = await injectSecrets('curl -H "x: {{secret:team_token}}"', { userId: ownerId, toolId: 'shell' });
    expect(injected.content).not.toContain('space-value-123');
    expect(injected.errors[0]).toContain('team_token');
    const { isVaultAuthenticated } = await import('@/security/flow-guard');
    expect(await isVaultAuthenticated(ownerId, { toolId: 'shell', action: 'execute', args: { command: 'curl', env: { T: '{{secret:team_token}}' } } })).toBe(false);

    const { getVault } = await import('@/security/vault');
    expect(await getVault().getByName(ownerId, 'team_token', { workspaceId: spaceId })).toBeNull();
    expect((await getVault().list(ownerId, { workspaceId: spaceId })).some((e) => e.name === 'team_token')).toBe(false);

    // Only owners write; a an editor may use it, a stranger has no door.
    const editor = await resolvedPrincipal(editorId, spaceId);
    await expect(spaceRepos(editor).secrets.write('x', 'y', 'api_key')).rejects.toThrow();
    expect(await spaceRepos(editor).secrets.read('team_token')).toBe('space-value-123');
    expect(() => spaceRepos(owner).secrets && spaceRepos({ ...owner, workspaceKind: 'personal' })).toThrow();
  });

  test('connector routes: members list, owners connect a GitHub token and disconnect', async () => {
    let res = await call('outsider', 'GET', `/api/spaces/${spaceId}/connectors`);
    expect(res.status).toBe(404);
    res = await call('editor', 'POST', `/api/spaces/${spaceId}/connectors/github`, { token: 'ghp_team' });
    expect(res.status).toBe(403);
    res = await call('owner', 'POST', `/api/spaces/${spaceId}/connectors/github`, { token: 'ghp_team' });
    expect(res.status).toBe(200);
    const list = await (await call('editor', 'GET', `/api/spaces/${spaceId}/connectors`)).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'github')).toMatchObject({ connected: true, connectedBy: 'owner', kind: 'token' });
    expect(JSON.stringify(list)).not.toContain('ghp_team');
    const audits = await auditRows('github');
    expect(audits.at(-1)).toMatchObject({ action: 'space_updated', workspace_id: spaceId });
  });
});

describe('GitHub identity in a space (§9.5)', () => {
  test('gh in a space runs with an empty per-space GH_CONFIG_DIR and the space\'s token, never the host\'s', async () => {
    process.env.GH_TOKEN = 'host-token';
    const gh = await import('@/utils/gh');
    const personal = gh.ghEnv();
    expect(personal.GH_TOKEN).toBe('host-token');
    const { spaceToolEnv } = await import('@/security/space-tool-env');
    const dir = spaceToolEnv(spaceId).GH_CONFIG_DIR;
    expect(existsSync(dir) && readdirSync(dir)).toEqual([]);
    const inSpace = gh.ghEnv({ configDir: dir, token: 'ghp_team' });
    expect(inSpace).toMatchObject({ GH_CONFIG_DIR: dir, GH_TOKEN: 'ghp_team' });
    expect(gh.ghEnv({ configDir: dir }).GH_TOKEN).toBeUndefined();
    delete process.env.GH_TOKEN;

    // The shell in a space: GH_CONFIG_DIR wins over the call's own env.
    const { withSpaceEnv } = await import('@/tools/shell');
    const space = { workspaceId: spaceId, role: 'editor' as const, scope: null };
    expect(withSpaceEnv({ GH_CONFIG_DIR: '/root/.config/gh', X: '1' }, { space })).toEqual({ GH_CONFIG_DIR: dir, X: '1' });
    expect(withSpaceEnv({ X: '1' }, { space: null })).toEqual({ X: '1' });

    // CLI agents: HOME moves too, the vendor's config stays.
    const { cliSpaceEnv } = await import('@/core/cli-child-env');
    const cli = cliSpaceEnv({ HOME: '/home/octi', PATH: '/bin' }, spaceId);
    expect(cli).toMatchObject({ GH_CONFIG_DIR: dir, CLAUDE_CONFIG_DIR: '/home/octi/.claude', CODEX_HOME: '/home/octi/.codex' });
    expect(cli.HOME).toBe(join(dir, '..', '..'));
  });
});
