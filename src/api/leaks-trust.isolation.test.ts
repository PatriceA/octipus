/**
 * Coworking S0a — L5, L6, L10: trust levels, client addresses, voice, and
 * who answers a request.
 *
 * Drives the real socket path on a real listening server: `/gateway` over `ws`
 * clients from 127.0.0.1 (the reverse-proxy case), and the REST routes over
 * `fetch`, so the socket address really comes from the Node socket. (The
 * legacy `/ws` and `/ws/permissions` these tests also drove were retired in
 * S0d; their voice and answer paths are the gateway's `voice.set`,
 * `permission.respond` and `approval.respond`.)
 *
 *   - An admin on loopback behind a proxy, with no `trustedProxies`, gets
 *     `user` trust and cannot open another user's session; a forged
 *     `X-Forwarded-For` changes nothing. With `trustedProxies` set, the
 *     forwarded address is honoured.
 *   - Bob cannot toggle voice mode on Alice's session.
 *   - Bob and an admin cannot answer Alice's permission requests or
 *     root-agent approvals via REST or the gateway; the admin resolve
 *     routes work and write an audit row.
 *   - `/history` and `/proposals` are owner-only, admins included.
 *   - The TUI's gateway client signs in with the stored CLI login.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';
// The CLI login lives under $HOME/.octipus; set before cli-session is imported.
const HOME = mkdtempSync(join(tmpdir(), 'octipus-leaks-trust-home-'));
process.env.HOME = HOME;

const aliceId = '11111111-1111-4111-8111-111111111111';
const bobId = '22222222-2222-4222-8222-222222222222';
const adminId = '33333333-3333-4333-8333-333333333333';

let port = 0;
let stopServer: () => void = () => {};
const tokens: Record<string, string> = {};
let aliceSession = '';
const sockets: WebSocket[] = [];

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-leaks-trust-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  // Sessions, rate-limit windows and caches use the Postgres-backed store.
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });

  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
    { id: adminId, username: 'root', isAdmin: true },
  ]);
  aliceSession = (await seedSession({ userId: aliceId, title: 'alice private' })).id;

  const { getSessionManager } = await import('@/security/auth/session');
  for (const id of [aliceId, bobId, adminId]) tokens[id] = (await getSessionManager().create(id)).token;

  const { Elysia, listen } = await import('@/api/http');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');
  const { authRoutes } = await import('./routes/auth');
  const { chatRoutes } = await import('./routes/chat');
  const { permissionRequestRoutes } = await import('./routes/permission-requests');
  const { adminApprovalRoutes } = await import('./routes/admin-approvals');
  const { setupGatewayWebSocket } = await import('./gateway-ws');
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const { wireMessageHandler } = await import('@/core/gateway/message-handler');

  // The server's bearer-token derive, reduced to session tokens.
  const app = new Elysia()
    .derive(async ({ request }) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
      const session = token ? await getSessionManager().validate(token) : null;
      if (!session) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
      const user = { id: session.userId, username: session.username, isAdmin: session.isAdmin };
      return { user, session, principal: principalFromUser(user, token) };
    })
    .group('/api', (a) => a.use(authRoutes).use(chatRoutes).use(permissionRequestRoutes).use(adminApprovalRoutes));
  setupGatewayWebSocket(app);
  wireMessageHandler(getGatewayHub());

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

interface Client {
  ws: WebSocket;
  frames: Frame[];
  send(frame: Frame): void;
  waitFor(pred: (f: Frame) => boolean): Promise<Frame>;
}

async function open(path: string, headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor: async (pred) => {
      let found: Frame | undefined;
      await vi.waitFor(() => { found = frames.find(pred); expect(found).toBeDefined(); }, { timeout: 10_000 });
      return found!;
    },
  };
}

/** A signed-in gateway connection, as a client behind a proxy on this host. */
async function gateway(userId: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = await open('/gateway', headers);
  client.send({ type: 'auth', method: 'session_token', credentials: { token: tokens[userId] }, clientType: 'tui' });
  await client.waitFor((f) => f.type === 'auth_ok');
  return client;
}

async function connectionOf(client: Client) {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const authOk = client.frames.find((f) => f.type === 'auth_ok')!;
  return getGatewayHub().connectionManager.getActiveConnections().find((c) => c.connectionId === authOk.connectionId)!;
}

async function rest(path: string, userId: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(userId ? { authorization: `Bearer ${tokens[userId]}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function setTrustedProxies(entries: string[]) {
  const { getConfig } = await import('@/config');
  getConfig().security.trustedProxies = entries;
}

async function permissionStatus(id: string): Promise<string> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT status FROM permission_requests WHERE id='${id}'`);
  return (rows[0] as { status: string }).status;
}

async function alicePermissionRequest(): Promise<string> {
  const { getPermissionManager } = await import('@/security/permissions');
  return getPermissionManager().requestApproval(aliceId, 'agent-alice', 'shell', 'execute', { command: 'ls' }, aliceSession, 'shell');
}

async function aliceApproval(): Promise<{ id: string; answer: Promise<unknown> }> {
  const { getAgentService } = await import('@/core/agent');
  const service = getAgentService();
  const before = new Set(service.getPendingApprovals(aliceId).map((a) => a.id));
  const answer = service.requestApproval('Deploy', 'Ship it?', {
    id: 'agent-alice', sessionId: aliceSession, userId: aliceId, topic: 't', model: 'm', role: 'general',
    status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
  } as never);
  const id = service.getPendingApprovals(aliceId).find((a) => !before.has(a.id))!.id;
  return { id, answer };
}

async function aliceApprovalPending(id: string): Promise<boolean> {
  const { getAgentService } = await import('@/core/agent');
  return getAgentService().getPendingApprovals(aliceId).some((a) => a.id === id);
}

// ── Trust and client addresses ───────────────────────────────────

describe('trust levels and client addresses (L5)', () => {
  test('an admin on loopback behind a proxy gets user trust and cannot open another user\'s session', async () => {
    await setTrustedProxies([]);
    const admin = await gateway(adminId, { 'x-forwarded-for': '198.51.100.20' });
    const ctx = await connectionOf(admin);
    expect(ctx.trustLevel).toBe('user');
    expect(ctx.ip).toBe('127.0.0.1');
    expect(admin.frames.find((f) => f.type === 'auth_ok')!.capabilities).toContain('admin');

    // Adopting the session for a command, and chatting into it, are refused.
    admin.send({ type: 'command', name: 'history', sessionId: aliceSession });
    expect((await admin.waitFor((f) => f.type === 'command.result' && f.name === 'history')).error).toBe('Session not found');
    admin.send({ type: 'chat.send', sessionId: aliceSession, content: 'hello' });
    expect((await admin.waitFor((f) => f.type === 'error' && f.code === 'SESSION_NOT_FOUND')).message).toBe('Session not found');
    admin.send({ type: 'chat.steer', sessionId: aliceSession, content: 'go left' });
    await vi.waitFor(() => expect(admin.frames.filter((f) => f.code === 'SESSION_NOT_FOUND')).toHaveLength(2));
  });

  test('a forged X-Forwarded-For changes nothing: not the gateway address, not the REST rate limit', async () => {
    await setTrustedProxies([]);
    const forged = await gateway(bobId, { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '10.0.0.1' });
    expect((await connectionOf(forged)).ip).toBe('127.0.0.1');
    const remote = await gateway(bobId, { 'x-forwarded-for': '203.0.113.99' });
    expect((await connectionOf(remote)).ip).toBe('127.0.0.1');

    // Ten passkey attempts per address per five minutes. A new forged
    // address per attempt does not open a new bucket: the 11th is refused.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await rest('/auth/passkey/auth/verify', null, { userId: aliceId, response: {} }, { 'x-forwarded-for': `192.0.2.${i}` });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  test('with trustedProxies set, the forwarded address is honoured', async () => {
    await setTrustedProxies(['127.0.0.1']);
    try {
      const proxied = await gateway(bobId, { 'x-forwarded-for': '198.51.100.20' });
      expect((await connectionOf(proxied)).ip).toBe('198.51.100.20');
      // The client-written part of the chain is skipped: the rightmost hop
      // not in trustedProxies is the client.
      const chained = await gateway(bobId, { 'x-forwarded-for': '6.6.6.6, 198.51.100.21' });
      expect((await connectionOf(chained)).ip).toBe('198.51.100.21');

      // The loopback bucket filled above does not limit forwarded clients.
      const res = await rest('/auth/passkey/auth/verify', null, { userId: aliceId, response: {} }, { 'x-forwarded-for': '198.51.100.50' });
      expect(res.status).not.toBe(429);
    } finally {
      await setTrustedProxies([]);
    }
  });
});

// ── Voice ────────────────────────────────────────────────────────

describe('voice mode (L6)', () => {
  test('Bob cannot toggle voice on Alice\'s session; Alice can', async () => {
    const { getAgentService } = await import('@/core/agent');
    const setVoiceMode = vi.spyOn(getAgentService(), 'setVoiceMode');
    try {
      const bob = await gateway(bobId);
      bob.send({ type: 'voice.set', on: true, sessionId: aliceSession });
      expect(await bob.waitFor((f) => f.type === 'error')).toMatchObject({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
      expect(setVoiceMode).not.toHaveBeenCalled();

      const alice = await gateway(aliceId);
      alice.send({ type: 'voice.set', on: true, sessionId: aliceSession });
      await vi.waitFor(() => expect(setVoiceMode).toHaveBeenCalledWith(aliceSession, aliceId, true));
      alice.send({ type: 'voice.set', on: false, sessionId: aliceSession });
      await vi.waitFor(() => expect(setVoiceMode).toHaveBeenCalledWith(aliceSession, aliceId, false));

      // A connection that leaves voice mode on takes it off when it closes.
      setVoiceMode.mockClear();
      const tab = await gateway(aliceId);
      tab.send({ type: 'voice.set', on: true, sessionId: aliceSession });
      await vi.waitFor(() => expect(setVoiceMode).toHaveBeenCalledWith(aliceSession, aliceId, true));
      tab.ws.close();
      await vi.waitFor(() => expect(setVoiceMode).toHaveBeenLastCalledWith(aliceSession, aliceId, false));
    } finally {
      setVoiceMode.mockRestore();
    }
  });
});

// ── Who answers a request ────────────────────────────────────────

describe('permission requests are answered by their requester (L10)', () => {
  test('Bob and an admin cannot answer Alice\'s request via REST or the gateway', async () => {
    const id = await alicePermissionRequest();

    for (const user of [bobId, adminId]) {
      const res = await rest(`/permission-requests/${id}/respond`, user, { approved: true });
      expect(res.body).toEqual({ error: 'Permission request not found or already resolved' });
    }

    const adminGw = await gateway(adminId);
    adminGw.send({ type: 'permission.respond', requestId: id, approved: true });
    await adminGw.waitFor((f) => f.type === 'error' && f.code === 'PERMISSION_ERROR');
    const bobGw = await gateway(bobId);
    bobGw.send({ type: 'permission.respond', requestId: id, approved: false });
    await bobGw.waitFor((f) => f.type === 'error' && f.code === 'PERMISSION_ERROR');

    expect(await permissionStatus(id)).toBe('pending');

    // The requester still can.
    const own = await rest(`/permission-requests/${id}/respond`, aliceId, { approved: false });
    expect(own.body).toEqual({ resolved: true });
    expect(await permissionStatus(id)).toBe('denied');
  });

  test('the admin resolve route answers it, with a reason, and audits it', async () => {
    const id = await alicePermissionRequest();

    expect((await rest(`/admin/permission-requests/${id}/resolve`, bobId, { approved: true, reason: 'x' })).status).toBe(403);
    expect((await rest(`/admin/permission-requests/${id}/resolve`, adminId, { approved: true })).status).toBe(422);

    const listed = await rest('/admin/permission-requests', adminId);
    expect(listed.body.requests.map((r: { requestId: string }) => r.requestId)).toContain(id);

    const res = await rest(`/admin/permission-requests/${id}/resolve`, adminId, { approved: true, reason: 'unblocking a stuck deploy' });
    expect(res.body).toEqual({ resolved: true, status: 'approved', requesterUserId: aliceId });
    expect(await permissionStatus(id)).toBe('approved');

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT user_id, action, details FROM audit_log WHERE resource_id='${id}' AND user_id='${adminId}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'permission_granted',
      details: expect.objectContaining({ adminResolution: true, requesterUserId: aliceId, reason: 'unblocking a stuck deploy' }),
    });

    // Already answered: a second admin answer is a 404, not a silent success.
    expect((await rest(`/admin/permission-requests/${id}/resolve`, adminId, { approved: false, reason: 'again' })).status).toBe(404);
  });
});

describe('root-agent approvals are answered by their requester (L10)', () => {
  test('Bob and an admin cannot answer Alice\'s approval via REST or the gateway', async () => {
    const { id, answer } = await aliceApproval();

    for (const user of [bobId, adminId]) {
      const res = await rest('/chat/approve', user, { requestId: id, approved: true });
      expect(res.body).toEqual({ error: 'Approval request not found or already resolved' });
    }
    // The generic pending list is the caller's own, admins included.
    expect((await rest('/chat/approvals/pending', adminId)).body.approvals).toEqual([]);

    const adminGw = await gateway(adminId);
    adminGw.send({ type: 'approval.respond', requestId: id, approved: true, response: 'yes' });
    // The same answer REST gives: someone else's id reads as unknown.
    expect(await adminGw.waitFor((f) => f.type === 'error' && f.code === 'APPROVAL_NOT_FOUND'))
      .toMatchObject({ message: 'Approval request not found or already resolved' });

    expect(await aliceApprovalPending(id)).toBe(true);

    const own = await rest('/chat/approve', aliceId, { requestId: id, approved: false });
    expect(own.body).toEqual({ resolved: true });
    expect(await answer).toMatchObject({ approved: false });
  });

  test('the admin resolve route answers it, with a reason, and audits it', async () => {
    const { id, answer } = await aliceApproval();

    expect((await rest(`/admin/approvals/${id}/resolve`, bobId, { approved: true, reason: 'x' })).status).toBe(403);
    const listed = await rest('/admin/approvals', adminId);
    expect(listed.body.approvals.map((a: { requestId: string }) => a.requestId)).toContain(id);

    const res = await rest(`/admin/approvals/${id}/resolve`, adminId, { approved: true, reason: 'owner is away', response: 'go' });
    expect(res.body).toEqual({ resolved: true, requesterUserId: aliceId });
    expect(await answer).toMatchObject({ approved: true, response: 'go' });

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT action, details FROM audit_log WHERE resource_id='${id}' AND user_id='${adminId}'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'permission_granted',
      details: expect.objectContaining({ adminResolution: true, requesterUserId: aliceId, reason: 'owner is away' }),
    });
  });
});

// ── Owner-only commands ──────────────────────────────────────────

describe('owner-only gateway commands', () => {
  test('/history of Alice\'s session is refused to Bob and the admin, served to Alice', async () => {
    const { seedMessage } = await import('@/test-helpers/multiuser-fixtures');
    await seedMessage({ sessionId: aliceSession, role: 'user', content: 'alice secret question' });

    for (const user of [bobId, adminId]) {
      const client = await gateway(user);
      client.send({ type: 'command', name: 'history', sessionId: aliceSession });
      const result = await client.waitFor((f) => f.type === 'command.result' && f.name === 'history');
      expect(result.error).toBe('Session not found');
      expect(JSON.stringify(result)).not.toContain('alice secret');
    }

    const alice = await gateway(aliceId);
    alice.send({ type: 'command', name: 'history', sessionId: aliceSession });
    const own = await alice.waitFor((f) => f.type === 'command.result' && f.name === 'history');
    expect(own.result).toContain('alice secret question');
  });

  test('/proposals is scoped to the caller, admins included', async () => {
    const service = await import('@/services/skill-proposal-service');
    const list = vi.spyOn(service, 'listPendingProposals').mockResolvedValue([]);
    try {
      const admin = await gateway(adminId);
      admin.send({ type: 'command', name: 'proposals' });
      await admin.waitFor((f) => f.type === 'command.result' && f.name === 'proposals');
      expect(list).toHaveBeenCalledWith(adminId);
      expect(list).not.toHaveBeenCalledWith(undefined);
    } finally {
      list.mockRestore();
    }
  });
});

describe('API token scopes on the gateway (WS6)', () => {
  test('a read-only token connects but cannot drive the agent; its scopes travel with the connection', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const { plaintext } = await getApiTokenManager().issue(aliceId, { name: `ro-${Math.random().toString(36).slice(2, 8)}`, scopes: ['api:read'] });
    const client = await open('/gateway');
    client.send({ type: 'auth', method: 'api_key', credentials: { key: plaintext }, clientType: 'tui' });
    await client.waitFor((f) => f.type === 'auth_ok');
    expect((await connectionOf(client)).scopes).toEqual(['api:read']);
    client.send({ type: 'chat.send', sessionId: aliceSession, content: 'hello' });
    expect(await client.waitFor((f) => f.type === 'error' && f.code === 'FORBIDDEN')).toMatchObject({ message: 'API token missing required scope "api:chat"' });

    // A browser session carries no scopes: every frame passes the scope check.
    expect((await connectionOf(await gateway(aliceId))).scopes).toBeUndefined();
  });
});

// ── The TUI client ───────────────────────────────────────────────

describe('the TUI gateway client', () => {
  test('signs in with the stored CLI login, as that user', async () => {
    mkdirSync(join(HOME, '.octipus'), { recursive: true });
    writeFileSync(join(HOME, '.octipus', 'session.json'), JSON.stringify({
      token: tokens[aliceId], userId: aliceId, username: 'alice', isAdmin: false,
    }));
    const { GatewayClient } = await import('@/core/gateway/client');
    const identities: unknown[] = [];
    const statuses: string[] = [];
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}/gateway`,
      onIdentityChange: (identity) => identities.push(identity),
      onStatusChange: (status) => statuses.push(status),
    });
    try {
      await client.connect();
      await vi.waitFor(() => expect(statuses).toContain('connected'), { timeout: 10_000 });
      expect(identities).toEqual([{ username: 'alice', userId: aliceId }]);

      const { getGatewayHub } = await import('@/core/gateway/hub');
      const tui = getGatewayHub().connectionManager.getActiveConnections()
        .filter((c) => c.clientType === 'tui' && c.userId === aliceId);
      expect(tui.length).toBeGreaterThan(0);
      expect(tui.every((c) => c.trustLevel === 'user')).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  test('without a stored login it asks for one and does not connect', async () => {
    const { clearCliSession } = await import('@/core/gateway/cli-session');
    clearCliSession();
    const { GatewayClient } = await import('@/core/gateway/client');
    const loginRequired: string[] = [];
    const statuses: string[] = [];
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}/gateway`,
      onLoginRequired: (reason) => loginRequired.push(reason),
      onStatusChange: (status) => statuses.push(status),
    });
    await client.connect();
    expect(loginRequired).toEqual(['Not signed in']);
    expect(statuses).toEqual(['disconnected']);
  });

  test('a local auth frame is refused: there is no machine account', async () => {
    const client = await open('/gateway');
    client.send({ type: 'auth', method: 'local', credentials: { token: 'anything' }, clientType: 'tui' });
    expect(await client.waitFor((f) => f.type === 'error')).toMatchObject({ code: 'INVALID_MESSAGE' });
  });
});
