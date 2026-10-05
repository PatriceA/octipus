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
 *   - the binding follows the space: a bridged room stays open while bound
 *     and only open rooms of the channel's current space are relayed; the
 *     binding ends when its owner stops owning the space; leftover mappings
 *     never reach another space's room; guests get a hint, no room; a purge
 *     drops the cached binding;
 *   - permission requests of a bridged room ask in the thread only for a
 *     turn asked from the platform, and are never denied for the channel.
 *
 * (Tool homes and the GitHub tool in a space: space-connectors.isolation.test.ts.)
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
vi.mock('@/channels/interface', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/channels/interface')>(),
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
const guestId = randomUUID();

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
    { id: guestId, username: 'guest' },
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

describe('budget and funding of a bound channel (§9.4 point 5, §9.1, §9.2)', () => {
  test('the space budget pauses the channel; unprompted posts are the sponsor\'s, and off without one', async () => {
    const { spaceWith } = await import('@/test-helpers/space-fixtures');
    const budgetSpace = await spaceWith(ownerId, [[editorId, 'editor']], 'Budgeted');
    const enrolled = await enrol(ownerId, 'C-BUDGET');
    expect((await call('owner', 'POST', `/api/me/group-channels/${enrolled.id}/bind`, { workspaceId: budgetSpace, acknowledged: true })).status).toBe(200);
    const { findGroupChannelById } = await import('@/channels/group-channels');
    const group = await findGroupChannelById(enrolled.id);
    if (!group?.workspaceId) throw new Error('not bound');
    const { bridgeListenFunding, groupBudgetPause } = await import('@/channels/group-bridge');
    const { setSpaceFunding } = await import('@/core/spaces/funding');

    // Funding: `own` pays nothing unprompted; no sponsor is off; a sponsor pays.
    await setSpaceFunding({ userId: ownerId }, budgetSpace, { mode: 'own' });
    expect(await bridgeListenFunding(group)).toBeNull();
    await setSpaceFunding({ userId: ownerId }, budgetSpace, { mode: 'unattended' });
    expect(await bridgeListenFunding(group)).toBeNull();
    await setSpaceFunding({ userId: ownerId }, budgetSpace, { sponsor: 'me' });
    expect(await bridgeListenFunding(group)).toEqual({ sponsorUserId: ownerId });

    // The unprompted post's model call is billed to the sponsor, in the space.
    const { defaultListenDeps } = await import('@/channels/group-listen');
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const { recordProviderUsage } = await import('@/models/providers/instrumented');
    const complete = vi.spyOn(getLiteLLMClient(), 'complete').mockImplementation(async (options) => {
      const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10, available: true };
      await recordProviderUsage({ ...options, model: 'probe-model', messages: [] }, 'test', { model: 'probe-model', usage });
      return { content: 'I could look into it.', model: 'probe-model', usage, finishReason: 'stop' } as never;
    });
    const { getModelRegistry } = await import('@/models/model-registry');
    const bound = vi.spyOn(getModelRegistry(), 'getModelForTopic').mockResolvedValue({ name: 'probe-row', modelId: 'probe-model' } as never);
    const deps = defaultListenDeps();
    try {
      expect(await deps.session(group)).toBeNull();
      expect(await deps.mayRun(group, null)).toBe(true);
      expect(await deps.complete({ system: 's', user: 'u', ownerUserId: group.ownerUserId, sessionId: null, group })).toBe('I could look into it.');
    } finally {
      complete.mockRestore();
      bound.mockRestore();
    }
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT user_id, funding, workspace_id FROM cost_log WHERE model_name = 'probe-row'`);
    expect(rows).toEqual([{ user_id: ownerId, funding: 'sponsor', workspace_id: budgetSpace }]);

    // The space's budget replaces the channel's: used up, the channel pauses.
    expect(await groupBudgetPause(group)).toBeNull();
    const { setSpaceBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: budgetSpace, authorId: ownerId, kind: 'space', period: 'month', limitUsd: 0.5 });
    await queryRaw(`INSERT INTO cost_log (user_id, model_name, input_tokens, output_tokens, total_cost, workspace_id, funding) VALUES ($1, 'm', 1, 1, 1, $2, 'sponsor')`, [editorId, budgetSpace]);
    _resetSpendBudgetsForTests();
    expect(await groupBudgetPause(group)).toEqual({ resetsAt: expect.any(String) });
    expect(await deps.mayRun(group, null)).toBe(false);
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


// ── The binding follows the space ───────────────────────────────────────────

/** A bound channel of `owner` in `workspaceId`, read back as the dispatcher would. */
async function boundChannel(owner: string, ownerName: string, channelId: string, workspaceId: string) {
  const group = await enrol(owner, channelId);
  const res = await call(ownerName, 'POST', `/api/me/group-channels/${group.id}/bind`, { workspaceId, acknowledged: true });
  expect(res.status).toBe(200);
  const { findGroupChannel } = await import('@/channels/group-channels');
  return (await findGroupChannel('slack', channelId))!;
}

function bridgedMessage(channelId: string, userId: string, threadId: string, content = 'hello') {
  return {
    id: randomUUID(), channelType: 'slack' as const, channelId, userId, userName: 'Someone',
    content, threadId, timestamp: new Date(), metadata: { messageId: threadId },
  };
}

async function mappingCount(groupChannelId: string): Promise<number> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw('SELECT count(*)::int AS n FROM group_channel_rooms WHERE group_channel_id = $1', [groupChannelId]);
  return Number((rows[0] as { n: number }).n);
}

/** A second space where `other` is an owner too. */
async function secondSpace(name: string): Promise<string> {
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  const id = await spaceWith(ownerId, [[otherOwnerId, 'editor'], [editorId, 'editor']], name);
  expect((await call('owner', 'PATCH', `/api/spaces/${id}/members/${otherOwnerId}`, { role: 'owner' })).status).toBe(200);
  return id;
}

describe('a bridged room stays readable by its channel only (§9.4)', () => {
  test('it cannot be made private while bound; a room that is not open is never relayed', async () => {
    const bound = await boundChannel(ownerId, 'owner', 'C-PRIVATE', spaceId);
    const { resolveBridgedRoom, bridgeTargetOf, relayRoomMessage } = await import('@/channels/group-bridge');
    const roomId = await resolveBridgedRoom(bound, '7.7', 'plan');
    const { updateRoom } = await import('@/core/rooms/service');
    await expect(updateRoom({ userId: ownerId }, spaceId, roomId, { visibility: 'private' })).rejects.toThrow(/bound to a group channel/);
    const { loadRoom } = await import('@/core/rooms/access');
    expect((await loadRoom(roomId))?.visibility).toBe('space');

    // A room that is private anyway (made so before this rule) is not relayed.
    const { queryRaw } = await import('@/db/postgres');
    await queryRaw(`UPDATE sessions SET room_visibility = 'private' WHERE id = $1`, [roomId]);
    expect(await bridgeTargetOf(roomId)).toBeNull();
    const { messageRepository } = await import('@/db/repositories/message-repository');
    sent.length = 0;
    await relayRoomMessage(await messageRepository.create({ sessionId: roomId, role: 'assistant', content: 'private answer' }));
    expect(sent).toEqual([]);
    await queryRaw(`UPDATE sessions SET room_visibility = 'space' WHERE id = $1`, [roomId]);

    // Unbound, it may go private.
    expect((await call('owner', 'DELETE', `/api/me/group-channels/${bound.id}/bind`)).status).toBe(200);
    await expect(updateRoom({ userId: ownerId }, spaceId, roomId, { visibility: 'private' })).resolves.toMatchObject({ visibility: 'private' });
  });

  test('relay is silent for a paused channel, progress rows and rooms no channel is bound to', async () => {
    const bound = await boundChannel(ownerId, 'owner', 'C-QUIET', spaceId);
    const { resolveBridgedRoom, relayRoomMessage } = await import('@/channels/group-bridge');
    const roomId = await resolveBridgedRoom(bound, '8.8');
    const { messageRepository } = await import('@/db/repositories/message-repository');
    sent.length = 0;
    await relayRoomMessage(await messageRepository.create({ sessionId: roomId, role: 'assistant', content: 'working…', metadata: { kind: 'progress' } }));
    const { createRoom } = await import('@/core/rooms/service');
    const loose = await createRoom({ userId: ownerId }, spaceId, { title: 'Not bridged', visibility: 'space' });
    await relayRoomMessage(await messageRepository.create({ sessionId: loose.id, role: 'assistant', content: 'nobody on the platform reads this' }));
    expect(sent).toEqual([]);

    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { eq } = await import('drizzle-orm');
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, ownerId));
    try {
      await relayRoomMessage(await messageRepository.create({ sessionId: roomId, role: 'assistant', content: 'paused' }));
      expect(sent).toEqual([]);
    } finally {
      await getDb().update(users).set({ isActive: true }).where(eq(users.id, ownerId));
    }
    await relayRoomMessage(await messageRepository.create({ sessionId: roomId, role: 'assistant', content: 'back' }));
    expect(sent).toEqual([expect.objectContaining({ kind: 'send', channelId: 'C-QUIET', threadId: '8.8', content: 'back' })]);
  });
});

describe('the binding ends with its owner\'s ownership of the space (§9.4)', () => {
  test('demoted or removed, the owner who bound it unbinds it (audited); a space owner who is not the channel\'s may unbind, a member may not', async () => {
    const second = await secondSpace('Demotion');
    const bound = await boundChannel(otherOwnerId, 'other', 'C-DEMOTE', second);
    // An editor of the space who does not own the channel: 404.
    expect((await call('editor', 'DELETE', `/api/me/group-channels/${bound.id}/bind`)).status).toBe(404);
    // Demoting someone else leaves it bound.
    expect((await call('owner', 'PATCH', `/api/spaces/${second}/members/${editorId}`, { role: 'viewer' })).status).toBe(200);
    const { findGroupChannel } = await import('@/channels/group-channels');
    expect((await findGroupChannel('slack', 'C-DEMOTE'))?.workspaceId).toBe(second);

    expect((await call('owner', 'PATCH', `/api/spaces/${second}/members/${otherOwnerId}`, { role: 'editor' })).status).toBe(200);
    expect((await findGroupChannel('slack', 'C-DEMOTE'))?.workspaceId).toBeNull();
    expect((await auditRows(bound.id)).at(-1)).toMatchObject({ workspace_id: second, details: expect.objectContaining({ bound: false, reason: 'owner_left' }) });

    // Owner again, bound again, then removed.
    expect((await call('owner', 'PATCH', `/api/spaces/${second}/members/${otherOwnerId}`, { role: 'owner' })).status).toBe(200);
    expect((await call('other', 'POST', `/api/me/group-channels/${bound.id}/bind`, { workspaceId: second, acknowledged: true })).status).toBe(200);
    expect((await call('owner', 'DELETE', `/api/spaces/${second}/members/${otherOwnerId}`)).status).toBe(200);
    expect((await findGroupChannel('slack', 'C-DEMOTE'))?.workspaceId).toBeNull();
    expect((await auditRows(bound.id)).at(-1)?.details).toMatchObject({ bound: false, reason: 'owner_left' });

    // A space owner who does not own the channel unbinds it.
    const mine = await boundChannel(ownerId, 'owner', 'C-COOWNED', spaceId);
    const third = await secondSpace('Co-owned');
    const theirs = await boundChannel(otherOwnerId, 'other', 'C-THEIRS', third);
    expect((await call('owner', 'DELETE', `/api/me/group-channels/${theirs.id}/bind`)).status).toBe(200);
    expect((await auditRows(theirs.id)).at(-1)).toMatchObject({ user_id: ownerId, details: expect.objectContaining({ reason: 'unbound' }) });
    expect((await call('owner', 'DELETE', `/api/me/group-channels/${mine.id}/bind`)).status).toBe(200);
  });
});

describe('a channel never reaches another space\'s room (§9.4)', () => {
  test('leftover mappings are cleared on bind, never resolve, never relay; a cached binding cannot create a room in the space it left', async () => {
    const elsewhere = await secondSpace('Elsewhere');
    const boundA = await boundChannel(ownerId, 'owner', 'C-STALE', spaceId);
    const { resolveBridgedRoom, bridgedRoomOf, bridgeTargetOf, handleBridgedTurn } = await import('@/channels/group-bridge');
    const roomA = await resolveBridgedRoom(boundA, 's1');
    expect((await call('owner', 'DELETE', `/api/me/group-channels/${boundA.id}/bind`)).status).toBe(200);
    const { queryRaw } = await import('@/db/postgres');
    const leftover = () => queryRaw('INSERT INTO group_channel_rooms (group_channel_id, thread_id, session_id) VALUES ($1, $2, $3)', [boundA.id, 's1', roomA]);
    // A late message of the old binding (before this fix, or on another instance).
    await leftover();

    expect((await call('owner', 'POST', `/api/me/group-channels/${boundA.id}/bind`, { workspaceId: elsewhere, acknowledged: true })).status).toBe(200);
    expect(await mappingCount(boundA.id)).toBe(0);
    await leftover();
    expect(await bridgedRoomOf(boundA.id, 's1')).toBeNull();
    expect(await bridgeTargetOf(roomA)).toBeNull();
    // The thread gets a room of the space it is bound to now.
    const { findGroupChannel } = await import('@/channels/group-channels');
    const boundB = (await findGroupChannel('slack', 'C-STALE'))!;
    const roomB = await resolveBridgedRoom(boundB, 's1');
    const { loadRoom } = await import('@/core/rooms/access');
    expect((await loadRoom(roomB))?.workspaceId).toBe(elsewhere);
    expect(await bridgedRoomOf(boundA.id, 's1')).toBe(roomB);

    // A message read under the old binding (a cached `GroupChannel`).
    const before = await queryRaw('SELECT count(*)::int AS n FROM sessions WHERE workspace_id = $1 AND kind = \'room\'', [spaceId]);
    await expect(resolveBridgedRoom(boundA, 's2')).rejects.toThrow(/no longer bound/);
    const { getAgentService } = await import('@/core/agent');
    const asked = vi.spyOn(getAgentService(), 'handleRoomMessage').mockResolvedValue({ kind: 'queued', position: 0 });
    sent.length = 0;
    expect(await handleBridgedTurn({ message: bridgedMessage('C-STALE', editorId, 's3'), group: boundA, context: '' })).toBe('refused');
    expect(sent).toEqual([expect.objectContaining({ kind: 'private', userId: editorId, content: expect.stringMatching(/no longer bound/) })]);
    expect(asked).not.toHaveBeenCalled();
    asked.mockRestore();
    const after = await queryRaw('SELECT count(*)::int AS n FROM sessions WHERE workspace_id = $1 AND kind = \'room\'', [spaceId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  test('a room another channel holds cannot be bound', async () => {
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: ownerId }, spaceId, { title: 'Shared thread', visibility: 'space' });
    const first = await enrol(ownerId, 'C-HOLD1');
    expect((await call('owner', 'POST', `/api/me/group-channels/${first.id}/bind`, { workspaceId: spaceId, acknowledged: true, roomId: room.id })).status).toBe(200);
    const second = await enrol(ownerId, 'C-HOLD2');
    const res = await call('owner', 'POST', `/api/me/group-channels/${second.id}/bind`, { workspaceId: spaceId, acknowledged: true, roomId: room.id });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already bound to a channel/);
  });
});

describe('guests in a bound channel (§9.4)', () => {
  test('a guest gets a private hint, no turn and no room', async () => {
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    const invite = await createInvite({ userId: ownerId }, spaceId, { role: 'guest' });
    await acceptInvite({ userId: guestId }, invite.token);
    const bound = await boundChannel(ownerId, 'owner', 'C-GUEST', spaceId);
    const { handleBridgedTurn, bridgedRoomOf } = await import('@/channels/group-bridge');
    sent.length = 0;
    expect(await handleBridgedTurn({ message: bridgedMessage('C-GUEST', guestId, 'g1'), group: bound, context: '' })).toBe('refused');
    expect(sent).toEqual([expect.objectContaining({ kind: 'private', userId: guestId, content: expect.stringMatching(/your role can't ask me/) })]);
    expect(await bridgedRoomOf(bound.id, 'g1')).toBeNull();
  });
});

describe('purging a space forgets its channels at once (§9.4)', () => {
  test('the cached binding is dropped with the commit', async () => {
    const doomed = await secondSpace('Doomed');
    await boundChannel(ownerId, 'owner', 'C-PURGE', doomed);
    const { findGroupChannel } = await import('@/channels/group-channels');
    expect((await findGroupChannel('slack', 'C-PURGE'))?.workspaceId).toBe(doomed);
    const { archiveSpace } = await import('@/core/spaces/service');
    await archiveSpace({ userId: ownerId }, doomed);
    const { refreshConfigKey } = await import('@/config');
    refreshConfigKey('spaces.purgeAfterArchiveDays', 0);
    try {
      const { purgeSpace } = await import('@/core/spaces/purge');
      const result = await purgeSpace({ userId: ownerId }, doomed);
      expect(result.deleted['group_channels (detached)']).toBe(1);
    } finally {
      refreshConfigKey('spaces.purgeAfterArchiveDays', 7);
    }
    expect((await findGroupChannel('slack', 'C-PURGE'))?.workspaceId).toBeNull();
  });
});

describe('permission requests of a bridged room (§9.4)', () => {
  test('a turn asked from the platform asks in its thread (details privately); one asked on the web, or in a paused channel, stays pending for the web app', async () => {
    const bound = await boundChannel(ownerId, 'owner', 'C-ASK', spaceId);
    const { resolveBridgedRoom } = await import('@/channels/group-bridge');
    const roomId = await resolveBridgedRoom(bound, '4.4');
    const { postRoomMessage } = await import('@/core/rooms/service');
    const { enqueueRoomTurn, roomQueueSnapshot } = await import('@/core/rooms/queue');
    const { forwardPermissionRequestToChannel } = await import('@/channels');
    const { getPermissionManager } = await import('@/security/permissions');
    const denied = vi.spyOn(getPermissionManager(), 'deny').mockResolvedValue(true as never);

    /** Run `fn` while the room's running turn is `editor`'s post (bridged or from the web). */
    async function duringTurn(bridged: boolean, fn: () => Promise<void>): Promise<void> {
      const { message } = await postRoomMessage({ userId: editorId }, roomId, {
        content: 'edit the plan', addressed: true, ...(bridged ? { bridged: { channelType: 'slack', messageId: '4.4' } } : {}),
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      enqueueRoomTurn(roomId, spaceId, { requesterId: editorId, requesterName: 'Ed', messageId: message.id, enqueuedAt: new Date() }, () => held);
      await vi.waitFor(() => expect(roomQueueSnapshot(roomId).running?.messageId).toBe(message.id));
      try {
        await fn();
      } finally {
        release();
        await vi.waitFor(() => expect(roomQueueSnapshot(roomId).running).toBeNull());
      }
    }
    const request = (requestId: string) => ({
      requestId, userId: editorId, agentId: 'a1', toolId: 'shell', action: 'execute', toolName: 'shell', sessionId: roomId,
      args: { command: 'cat secret-salaries.csv' },
    });

    try {
      sent.length = 0;
      await duringTurn(true, () => forwardPermissionRequestToChannel(request(randomUUID())));
      expect(sent).toEqual([
        expect.objectContaining({ kind: 'private', userId: editorId, threadId: '4.4', content: expect.stringContaining('secret-salaries') }),
        expect.objectContaining({ kind: 'send', channelId: 'C-ASK', threadId: '4.4', content: expect.not.stringContaining('secret-salaries') }),
      ]);

      sent.length = 0;
      await duringTurn(false, () => forwardPermissionRequestToChannel(request(randomUUID())));
      expect(sent).toEqual([]);

      const { getDb } = await import('@/db/postgres');
      const { users } = await import('@/db/schema/users');
      const { eq } = await import('drizzle-orm');
      await getDb().update(users).set({ isActive: false }).where(eq(users.id, ownerId));
      try {
        await duringTurn(true, () => forwardPermissionRequestToChannel(request(randomUUID())));
      } finally {
        await getDb().update(users).set({ isActive: true }).where(eq(users.id, ownerId));
      }
      expect(sent).toEqual([]);
      expect(denied).not.toHaveBeenCalled();
    } finally {
      denied.mockRestore();
    }
  });
});
