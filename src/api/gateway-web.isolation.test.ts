/**
 * Coworking S0d — the web on the gateway.
 *
 * Drives `/gateway` on a real listening server with `ws` clients, the real
 * hub, message handler and event bridge, the real permission manager and
 * root-agent service over embedded PGlite. Each user holds several
 * connections, as browser tabs do:
 *
 *   - a tab opened after a permission request or an approval was raised gets
 *     it in its `permission.pending` snapshot; another user's snapshot is
 *     theirs only; every tab of the user hears the resolution;
 *   - `replay` serves a user's own session only, and a deleted or archived
 *     session has nothing left to replay;
 *   - a failed turn reaches every tab of its user as `chat.error`;
 *   - a message during a running turn steers it and reaches every tab as
 *     `chat.message {injected:true}`; another user cannot steer it;
 *   - `chat.send` carries the workspace a new session is created in, and only
 *     one of the user's own;
 *   - narration (`voice.speak`) goes to the tab that turned voice on only;
 *   - frames over `gateway.maxFrameBytes` close the socket, and `auth_ok`
 *     tells the client the cap the socket enforces;
 *   - `replay` without `afterEventId` answers `gap: true` and no events;
 *   - a tab without voice cannot take another tab's session out of voice
 *     mode;
 *   - an in-app delivery counts only when a connection shows the chat page
 *     (`chat:inbox`).
 *
 * The model is the only stand-in: `handleMessage` is spied where a turn
 * would run one.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { TurnEvent } from '@/core/agent/service';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '51111111-1111-4111-8111-111111111111';
const bobId = '52222222-2222-4222-8222-222222222222';
const aliceWorkWs = randomUUID();
const bobWs = randomUUID();

let port = 0;
let stopServer: () => void = () => {};
const tokens: Record<string, string> = {};
let aliceSession = '';
const sockets: WebSocket[] = [];

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-gateway-web-'));

  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });

  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }, { id: bobId, username: 'bob' }]);
  aliceSession = (await seedSession({ userId: aliceId, title: 'alice private' })).id;
  await executeRaw(`INSERT INTO workspaces (id, user_id, slug, name, files_dir) VALUES ('${aliceWorkWs}', '${aliceId}', 'work', 'Work', '${aliceWorkWs}')`);
  await executeRaw(`INSERT INTO workspaces (id, user_id, slug, name, files_dir) VALUES ('${bobWs}', '${bobId}', 'bob-work', 'Bob work', '${bobWs}')`);

  const { getSessionManager } = await import('@/security/auth/session');
  for (const id of [aliceId, bobId]) tokens[id] = (await getSessionManager().create(id)).token;

  const { Elysia, listen } = await import('@/api/http');
  const { setupGatewayWebSocket } = await import('./gateway-ws');
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const { wireMessageHandler } = await import('@/core/gateway/message-handler');
  const { connectEventBridge } = await import('@/core/gateway/event-bridge');

  const app = new Elysia();
  setupGatewayWebSocket(app);
  wireMessageHandler(getGatewayHub());
  await connectEventBridge(getGatewayHub());

  const server = listen(app, { hostname: '127.0.0.1', port: 0 });
  stopServer = () => server.stop();
  await vi.waitFor(() => expect(server.port).toBeGreaterThan(0));
  port = server.port;
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.terminate();
  stopServer();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

// ── Helpers ──────────────────────────────────────────────────────

type Frame = Record<string, any>;

interface Tab {
  ws: WebSocket;
  frames: Frame[];
  closed: Promise<number>;
  send(frame: Frame): void;
  waitFor(pred: (f: Frame) => boolean): Promise<Frame>;
  events(type: string): Frame[];
}

/** A browser tab: one socket, signed in with a ticket, subscribed to everything. */
async function tab(userId: string, subscribe = true): Promise<Tab> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const t: Tab = {
    ws,
    frames,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor: async (pred) => {
      let found: Frame | undefined;
      await vi.waitFor(() => { found = frames.find(pred); expect(found).toBeDefined(); }, { timeout: 10_000 });
      return found!;
    },
    events: (type) => frames.filter((f) => f.type === 'event' && f.event.type === type).map((f) => f.event),
  };
  t.send({ type: 'auth', method: 'session_token', credentials: { token: tokens[userId] }, clientType: 'webchat' });
  await t.waitFor((f) => f.type === 'auth_ok');
  if (subscribe) {
    t.send({ type: 'subscribe', patterns: ['*'] });
    await t.waitFor((f) => f.type === 'permission.pending');
  }
  return t;
}

async function agentService() {
  const { getAgentService } = await import('@/core/agent');
  return getAgentService();
}

/** Push a turn event through the root agent's own emitter (as a turn would). */
async function emitTurn(event: Omit<TurnEvent, 'timestamp'>): Promise<void> {
  const service = await agentService() as unknown as { emit(event: TurnEvent): void };
  service.emit({ ...event, timestamp: new Date() });
}

// ── Pending prompts ──────────────────────────────────────────────

describe('pending prompts across tabs', () => {
  test('a tab opened after the prompts were raised shows them; other users see none; every tab hears the answer', async () => {
    const first = await tab(aliceId);
    const { getPermissionManager } = await import('@/security/permissions');
    const requestId = await getPermissionManager().requestApproval(aliceId, 'agent-alice', 'shell', 'execute', { command: 'ls' }, aliceSession, 'shell');
    const service = await agentService();
    const answer = service.requestApproval('Deploy', 'Ship it?', {
      id: 'agent-alice', sessionId: aliceSession, userId: aliceId, topic: 't', model: 'm', role: 'general',
      status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
    } as never);
    const approvalId = service.getPendingApprovals(aliceId).at(-1)!.id;

    // The live tab hears both as they are raised.
    await first.waitFor((f) => f.type === 'event' && f.event.type === 'permission.request' && f.event.payload.requestId === requestId);
    await first.waitFor((f) => f.type === 'event' && f.event.type === 'agent.approval_required' && f.event.payload.requestId === approvalId);

    // A tab opened afterwards gets them in its snapshot.
    const later = await tab(aliceId);
    const snapshot = later.frames.find((f) => f.type === 'permission.pending')!;
    expect(snapshot.requests).toEqual([expect.objectContaining({ requestId, toolId: 'shell', action: 'execute', toolName: 'shell', args: { command: 'ls' } })]);
    expect(snapshot.approvals).toEqual([expect.objectContaining({ requestId: approvalId, summary: 'Deploy', question: 'Ship it?' })]);

    const bob = await tab(bobId);
    expect(bob.frames.find((f) => f.type === 'permission.pending')).toEqual({ type: 'permission.pending', requests: [], approvals: [] });

    // Answered from one tab: every tab drops them.
    later.send({ type: 'permission.respond', requestId, approved: true });
    later.send({ type: 'approval.respond', requestId: approvalId, approved: false, response: 'no' });
    for (const t of [first, later]) {
      await t.waitFor((f) => f.type === 'event' && f.event.type === 'permission.resolved' && f.event.payload.requestId === requestId);
      await t.waitFor((f) => f.type === 'event' && f.event.type === 'approval.resolved' && f.event.payload.requestId === approvalId);
    }
    expect(await answer).toMatchObject({ approved: false });
    expect(bob.frames.filter((f) => f.type === 'event')).toEqual([]);

    // Answering again from the first tab reconciles it from the current list.
    first.frames.length = 0;
    first.send({ type: 'permission.respond', requestId, approved: true });
    await first.waitFor((f) => f.type === 'error' && f.code === 'PERMISSION_ERROR');
    expect(await first.waitFor((f) => f.type === 'permission.pending')).toEqual({ type: 'permission.pending', requests: [], approvals: [] });
  });
});

// ── Replay ───────────────────────────────────────────────────────

describe('replay', () => {
  test('serves the owner\'s session only, after the given event, and nothing once the session is gone', async () => {
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { id: sessionId } = await seedSession({ userId: aliceId });
    const alice = await tab(aliceId);
    await emitTurn({ type: 'status_update', sessionId, userId: aliceId, data: { message: 'one' } });
    await emitTurn({ type: 'status_update', sessionId, userId: aliceId, data: { message: 'two' } });
    const seen = () => alice.events('rootAgent.status').filter((e) => e.sessionId === sessionId);
    await vi.waitFor(() => expect(seen()).toHaveLength(2));
    const [first, second] = seen();

    alice.send({ type: 'replay', sessionId, afterEventId: first.id });
    const replay = await alice.waitFor((f) => f.type === 'replay');
    expect(replay).toMatchObject({ sessionId, gap: false });
    expect(replay.events.map((e: Frame) => e.payload.message)).toEqual(['two']);

    // Not Bob's to read; a session that does not exist is no different.
    const bob = await tab(bobId);
    bob.send({ type: 'replay', sessionId });
    expect(await bob.waitFor((f) => f.type === 'error')).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(bob.frames.find((f) => f.type === 'replay')).toBeUndefined();
    bob.frames.length = 0;
    bob.send({ type: 'replay', sessionId: randomUUID() });
    expect(await bob.waitFor((f) => f.type === 'error')).toMatchObject({ code: 'SESSION_NOT_FOUND' });

    // Archived: the buffer goes, and a client that asks after its last id is told it has a gap.
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    await sessionRepository.complete(sessionId);
    alice.frames.length = 0;
    alice.send({ type: 'replay', sessionId, afterEventId: second.id });
    expect(await alice.waitFor((f) => f.type === 'replay')).toMatchObject({ events: [], gap: true });

    // Deleted: same, and the ownership check now refuses it outright.
    await emitTurn({ type: 'status_update', sessionId, userId: aliceId, data: { message: 'three' } });
    const { getGatewayHub } = await import('@/core/gateway/hub');
    expect(getGatewayHub().eventBus.replaySince(sessionId).events).toHaveLength(1);
    await sessionRepository.delete(sessionId);
    expect(getGatewayHub().eventBus.replaySince(sessionId).events).toEqual([]);
  });
});

// ── Turns ────────────────────────────────────────────────────────

describe('turns across tabs', () => {
  test('a failed turn reaches every tab of its user as chat.error, the sender also as CHAT_ERROR', async () => {
    const service = await agentService();
    const handle = vi.spyOn(service, 'handleMessage').mockRejectedValue(new Error('model unavailable'));
    try {
      const sender = await tab(aliceId);
      const other = await tab(aliceId);
      const bob = await tab(bobId);
      sender.send({ type: 'chat.send', sessionId: aliceSession, content: 'hello' });
      for (const t of [sender, other]) {
        const event = (await t.waitFor((f) => f.type === 'event' && f.event.type === 'chat.error')).event;
        expect(event).toMatchObject({ userId: aliceId, sessionId: aliceSession, payload: { error: 'model unavailable' } });
      }
      expect(await sender.waitFor((f) => f.type === 'error')).toMatchObject({ code: 'CHAT_ERROR' });
      expect(other.frames.find((f) => f.type === 'error')).toBeUndefined();
      expect(bob.events('chat.error')).toEqual([]);
    } finally {
      handle.mockRestore();
    }
  });

  test('a message during a running turn steers it; every tab sees it injected; another user cannot', async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const steered: string[] = [];
    const worker = {
      getStatus: () => 'running',
      getContext: () => ({ root: true, sessionId: aliceSession, userId: aliceId }),
      steer: (m: { content: string }) => steered.push(m.content),
    };
    const bySession = vi.spyOn(getAgentManager(), 'getBySession').mockImplementation((sid: string) => (sid === aliceSession ? [worker] : []) as never);
    const service = await agentService();
    const handle = vi.spyOn(service, 'handleMessage');
    try {
      const sender = await tab(aliceId);
      const other = await tab(aliceId);
      sender.send({ type: 'chat.send', sessionId: aliceSession, content: 'go left instead' });
      for (const t of [sender, other]) {
        const event = (await t.waitFor((f) => f.type === 'event' && f.event.type === 'chat.message')).event;
        expect(event.payload).toEqual({ role: 'user', content: 'go left instead', injected: true });
      }
      expect(steered).toEqual(['go left instead']);
      expect(handle).not.toHaveBeenCalled();

      const bob = await tab(bobId);
      bob.send({ type: 'chat.steer', sessionId: aliceSession, content: 'go right' });
      expect(await bob.waitFor((f) => f.type === 'error')).toMatchObject({ code: 'SESSION_NOT_FOUND' });
      expect(steered).toEqual(['go left instead']);
    } finally {
      bySession.mockRestore();
      handle.mockRestore();
    }
  });

  test('chat.send creates a new session in the workspace it names, and only in one of the user\'s own', async () => {
    const service = await agentService();
    const handle = vi.spyOn(service, 'handleMessage').mockResolvedValue({ response: 'ok', classification: { type: 'casual', confidence: 1 } });
    try {
      const alice = await tab(aliceId);
      const sessionId = randomUUID();
      alice.send({ type: 'chat.send', sessionId, content: 'start here', workspaceId: aliceWorkWs });
      await alice.waitFor((f) => f.type === 'event' && f.event.type === 'chat.response' && f.event.sessionId === sessionId);
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      expect((await sessionRepository.findById(sessionId))?.workspaceId).toBe(aliceWorkWs);

      const foreign = randomUUID();
      alice.send({ type: 'chat.send', sessionId: foreign, content: 'into bob\'s', workspaceId: bobWs });
      expect(await alice.waitFor((f) => f.type === 'error' && f.code === 'CHAT_ERROR')).toMatchObject({ message: 'Workspace not found' });
      expect(await sessionRepository.findById(foreign)).toBeNull();
    } finally {
      handle.mockRestore();
    }
  });
});

// ── Voice ────────────────────────────────────────────────────────

describe('voice narration', () => {
  test('goes to the tab that turned voice on for the session, not the user\'s other tabs', async () => {
    const voiceTab = await tab(aliceId);
    const otherTab = await tab(aliceId);
    voiceTab.send({ type: 'voice.set', sessionId: aliceSession, on: true });
    await vi.waitFor(async () => {
      const { getGatewayHub } = await import('@/core/gateway/hub');
      const authOk = voiceTab.frames.find((f) => f.type === 'auth_ok')!;
      expect(getGatewayHub().connectionManager.getActiveConnections().find((c) => c.connectionId === authOk.connectionId)?.voiceSessionId).toBe(aliceSession);
    });
    await emitTurn({ type: 'worker_spawned', sessionId: aliceSession, userId: aliceId, data: { role: 'research' } });
    const spoken = (await voiceTab.waitFor((f) => f.type === 'event' && f.event.type === 'voice.speak')).event;
    expect(spoken.payload.text).toContain('research');
    expect(otherTab.events('voice.speak')).toEqual([]);
    // The turn event itself still reaches both.
    await otherTab.waitFor((f) => f.type === 'event' && f.event.type === 'agent.spawned');
    voiceTab.send({ type: 'voice.set', sessionId: aliceSession, on: false });
  });
});

// ── Frame cap ────────────────────────────────────────────────────

describe('gateway.maxFrameBytes', () => {
  test('auth_ok tells the client the cap, and a frame over it closes the socket', async () => {
    const { getConfig } = await import('@/config');
    const cap = getConfig().gateway.maxFrameBytes;
    const t = await tab(aliceId, false);
    expect(t.frames.find((f) => f.type === 'auth_ok')).toMatchObject({ maxFrameBytes: cap });
    t.send({ type: 'chat.send', sessionId: aliceSession, content: 'x'.repeat(cap + 1) });
    expect(await t.closed).toBe(1009);
  });

  test('auth_ok reports the cap the socket enforces, not a later config value', async () => {
    const { getConfig, refreshConfigKey } = await import('@/config');
    const enforced = getConfig().gateway.maxFrameBytes;
    refreshConfigKey('gateway.maxFrameBytes', enforced * 2);
    try {
      const t = await tab(aliceId, false);
      expect(t.frames.find((f) => f.type === 'auth_ok')).toMatchObject({ maxFrameBytes: enforced });
    } finally {
      refreshConfigKey('gateway.maxFrameBytes', enforced);
    }
  });
});

// ── Replay without a watermark ───────────────────────────────────

describe('replay without afterEventId', () => {
  test('answers gap:true with no events, so the client reloads from REST instead of applying old events again', async () => {
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { id: sessionId } = await seedSession({ userId: aliceId });
    const alice = await tab(aliceId);
    await emitTurn({ type: 'status_update', sessionId, userId: aliceId, data: { message: 'old' } });
    await vi.waitFor(() => expect(alice.events('rootAgent.status').filter((e) => e.sessionId === sessionId)).toHaveLength(1));
    alice.frames.length = 0;
    alice.send({ type: 'replay', sessionId });
    expect(await alice.waitFor((f) => f.type === 'replay')).toEqual({ type: 'replay', sessionId, events: [], gap: true });
  });
});

// ── Voice mode across tabs ───────────────────────────────────────

describe('voice mode across tabs', () => {
  test('a tab without voice cannot end another tab\'s; the last tab holding it does, on off or on close', async () => {
    const service = await agentService();
    const setVoice = vi.spyOn(service, 'setVoiceMode');
    /** A round trip on `t`: every frame it sent before has been handled. */
    const settled = async (t: Tab) => {
      t.frames.length = 0;
      t.send({ type: 'ping' });
      await t.waitFor((f) => f.type === 'pong');
    };
    try {
      const voiceTab = await tab(aliceId);
      const plainTab = await tab(aliceId);
      voiceTab.send({ type: 'voice.set', sessionId: aliceSession, on: true });
      await vi.waitFor(() => expect(setVoice).toHaveBeenCalledWith(aliceSession, aliceId, true));
      setVoice.mockClear();

      // The plain tab shows the same session without voice: nothing changes.
      plainTab.send({ type: 'voice.set', sessionId: aliceSession, on: false });
      await settled(plainTab);
      expect(setVoice).not.toHaveBeenCalled();

      // A second tab turns voice on there too; the first closing leaves it on.
      plainTab.send({ type: 'voice.set', sessionId: aliceSession, on: true });
      await vi.waitFor(() => expect(setVoice).toHaveBeenCalledWith(aliceSession, aliceId, true));
      setVoice.mockClear();
      voiceTab.ws.close();
      await voiceTab.closed;
      await settled(plainTab);
      await new Promise((resolve) => setTimeout(resolve, 50)); // the close handler imports lazily
      expect(setVoice).not.toHaveBeenCalled();

      // The last tab holding it turns it off: the root agent leaves voice mode.
      plainTab.send({ type: 'voice.set', sessionId: aliceSession, on: false });
      await vi.waitFor(() => expect(setVoice).toHaveBeenCalledWith(aliceSession, aliceId, false));
    } finally {
      setVoice.mockRestore();
    }
  });
});

// ── In-app delivery ──────────────────────────────────────────────

describe('chat:inbox', () => {
  test('an in-app delivery counts only when a connection shows the chat page', async () => {
    const { webChatChannel } = await import('@/channels/webchat');
    const terminal = await tab(aliceId);
    await expect(webChatChannel.sendToUser(aliceId, { content: 'unseen' })).rejects.toThrow('No open chat page');
    expect(terminal.events('chat.message')).toEqual([]);

    const chatPage = await tab(aliceId);
    chatPage.send({ type: 'subscribe', resources: ['chat:inbox'] });
    expect(await chatPage.waitFor((f) => f.type === 'subscribed')).toEqual({ type: 'subscribed', resources: ['chat:inbox'] });
    await webChatChannel.sendToUser(aliceId, { content: 'seen' });
    await chatPage.waitFor((f) => f.type === 'event' && f.event.type === 'chat.message' && f.event.payload.content === 'seen');

    chatPage.send({ type: 'unsubscribe', resources: ['chat:inbox'] });
    chatPage.send({ type: 'ping' });
    await chatPage.waitFor((f) => f.type === 'pong');
    await expect(webChatChannel.sendToUser(aliceId, { content: 'gone' })).rejects.toThrow('No open chat page');

    // No other id of the kind exists.
    chatPage.send({ type: 'subscribe', resources: ['chat:other'] });
    expect(await chatPage.waitFor((f) => f.type === 'error' && f.code === 'FORBIDDEN')).toMatchObject({ message: 'Not allowed to subscribe to chat:other' });
  });
});
