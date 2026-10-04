/**
 * Deactivation and SCIM scope (docs/plans/coworking-spec.md §4.1, L7/L8).
 *
 * Drives the real application (`createServer`: auth derive, admin, auth,
 * SAML and SCIM routes, every websocket endpoint) on embedded PGlite:
 *   - a deactivated user's session, API token, passkey login, SAML login and
 *     every open socket fail, and their pending prompts and impersonations end;
 *   - a demoted admin's gateway socket is closed and reconnects without admin;
 *   - a SCIM token cannot deactivate another org's user, and only deactivates
 *     an account no other org holds;
 *   - a SCIM re-activation does not undo an admin's deactivation;
 *   - a hook of a deactivated user does not fire.
 *
 * Only the edges that would need a real IdP, an STT engine or the vault are
 * stubbed: samlify's signature parsing, the passkey ceremony, the STT engine
 * and the vault lookup of SCIM tokens.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const stubs = vi.hoisted(() => ({
  samlNameId: '',
  scimTokens: new Map<string, string>(),
}));

vi.mock('samlify', () => ({
  setSchemaValidator: () => {},
  Constants: { namespace: { binding: { post: 'post', redirect: 'redirect' }, format: { emailAddress: 'email' } } },
  ServiceProvider: () => ({ parseLoginResponse: async () => ({ extract: { nameID: stubs.samlNameId } }) }),
  IdentityProvider: () => ({}),
}));

vi.mock('@/security/auth/passkey', async () => ({
  ...(await vi.importActual<typeof import('@/security/auth/passkey')>('@/security/auth/passkey')),
  getPasskeyAuth: () => ({ verifyAuthentication: async () => ({ verified: true }) }),
}));

vi.mock('@/security/vault', async () => ({
  ...(await vi.importActual<typeof import('@/security/vault')>('@/security/vault')),
  getVault: () => ({ getByName: async (_owner: string, ref: string) => stubs.scimTokens.get(ref) ?? null }),
}));

vi.mock('@/voice/stt', () => ({
  FasterWhisperEngine: class {
    async *streamTranscribe(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain until the socket ends */ }
    }
    async dispose(): Promise<void> {}
  },
}));

const ADMIN = '10000000-0000-4000-8000-000000000001';
const ALICE = '10000000-0000-4000-8000-000000000002';
const BOB = '10000000-0000-4000-8000-000000000003';
const CAROL = '10000000-0000-4000-8000-000000000004';
const DAVE = '10000000-0000-4000-8000-000000000005';
const ERIN = '10000000-0000-4000-8000-000000000006';
const FRANK = '10000000-0000-4000-8000-000000000007';
const GINA = '10000000-0000-4000-8000-000000000008';
const ORG_A = '20000000-0000-4000-8000-00000000000a';
const ORG_B = '20000000-0000-4000-8000-00000000000b';
const TOKEN_A = `scim-a-${rand(8)}`;
const TOKEN_B = `scim-b-${rand(8)}`;

type App = { handle: (req: Request) => Promise<Response>; websocketRoutes(): readonly { path: string; handlers: Record<string, ((...args: any[]) => unknown) | undefined> }[] };
let app: App;
let adminToken: string;
let db: typeof import('@/db/postgres').getDb;

interface FakeSocket {
  data: { request: Request };
  readyState: number;
  remoteAddress: string;
  frames: Array<Record<string, unknown>>;
  send: (frame: string | Uint8Array) => void;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(url: string): FakeSocket {
  const frames: Array<Record<string, unknown>> = [];
  return {
    data: { request: new Request(url) },
    readyState: 1,
    remoteAddress: '10.1.2.3',
    frames,
    send: (frame) => { if (typeof frame === 'string') frames.push(JSON.parse(frame)); },
    close: vi.fn(),
  };
}

function handlers(path: string) {
  const route = app.websocketRoutes().find((r) => r.path === path);
  if (!route) throw new Error(`no websocket route ${path}`);
  return route.handlers;
}

async function openSocket(path: string, query: string): Promise<FakeSocket> {
  const ws = fakeSocket(`http://localhost${path}?${query}`);
  await handlers(path).open!(ws);
  return ws;
}

/** Open a /gateway connection and authenticate it with a session token. */
async function openGateway(token: string): Promise<FakeSocket> {
  const ws = fakeSocket('http://localhost/gateway');
  const h = handlers('/gateway');
  await h.open!(ws);
  await h.message!(ws, JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token }, clientType: 'webchat' }));
  return ws;
}

function call(method: string, path: string, opts: { bearer?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }));
}

async function login(userId: string): Promise<string> {
  const { getSessionManager } = await import('@/security/auth/session');
  return (await getSessionManager().create(userId)).token;
}

async function isActive(userId: string): Promise<boolean> {
  const { userRepository } = await import('@/db/repositories/user-repository');
  return (await userRepository.findById(userId))!.isActive;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-deactivation-'));

  const { initializeDb, executeRaw, getDb } = await import('@/db/postgres');
  await initializeDb();
  db = getDb;
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ADMIN, username: 'root', isAdmin: true },
    { id: ALICE, username: 'alice' },
    { id: BOB, username: 'bob', isAdmin: true },
    { id: CAROL, username: 'carol' },
    { id: DAVE, username: 'dave' },
    { id: ERIN, username: 'erin' },
    { id: FRANK, username: 'frank' },
    { id: GINA, username: 'gina' },
  ]);
  await executeRaw(`INSERT INTO organizations (id, slug, name) VALUES ('${ORG_A}', 'org-a', 'Org A'), ('${ORG_B}', 'org-b', 'Org B')`);
  await executeRaw(
    `INSERT INTO org_sso_config (org_id, saml_enabled, scim_enabled, scim_token_vault_ref)
     VALUES ('${ORG_A}', true, true, 'scim-a'), ('${ORG_B}', false, true, 'scim-b')`,
  );
  // carol: SAML user of A. dave: B only. erin: A only. frank: A and B. gina: B only.
  await executeRaw(
    `INSERT INTO org_members (org_id, user_id) VALUES
       ('${ORG_A}', '${CAROL}'), ('${ORG_B}', '${DAVE}'), ('${ORG_A}', '${ERIN}'),
       ('${ORG_A}', '${FRANK}'), ('${ORG_B}', '${FRANK}'), ('${ORG_B}', '${GINA}')`,
  );
  stubs.scimTokens.set('scim-a', TOKEN_A);
  stubs.scimTokens.set('scim-b', TOKEN_B);

  const { createServer } = await import('./server');
  app = createServer() as unknown as App;
  adminToken = await login(ADMIN);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('a deactivated user loses every door at once', () => {
  test('session, API token, passkey, SAML, sockets, prompts and impersonation', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const { getImpersonationManager } = await import('@/security/impersonation');
    const { executeRaw } = await import('@/db/postgres');
    const { userSocketCount } = await import('./user-sockets');
    const { getGatewayHub } = await import('@/core/gateway/hub');

    const session = await login(ALICE);
    const { plaintext: apiToken } = await getApiTokenManager().issue(ALICE, { name: 'cli' });
    expect((await call('GET', '/api/auth/me', { bearer: session })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { bearer: apiToken })).status).toBe(200);

    const sockets = {
      ws: await openSocket('/ws', `token=${session}`),
      permissions: await openSocket('/ws/permissions', `token=${session}`),
      bridge: await openSocket('/ws/browser-bridge', `token=${apiToken}`),
      voice: await openSocket('/voice', `token=${session}&engine=fasterwhisper`),
    };
    for (const ws of Object.values(sockets)) expect(ws.close).not.toHaveBeenCalled();
    const gateway = await openGateway(session);
    expect(gateway.frames.at(-1)).toMatchObject({ type: 'auth_ok', userId: ALICE });
    expect(userSocketCount(ALICE)).toBe(4);

    // A pending permission prompt, and an admin acting as alice.
    await executeRaw(
      `INSERT INTO permission_requests (id, user_id, agent_id, skill_id, action, context)
       VALUES ('30000000-0000-4000-8000-000000000001', '${ALICE}', 'agent-x', 'shell', 'execute', '{}'::jsonb)`,
    );
    // On its own admin session: while it lasts, that session acts as alice.
    const impersonating = await login(ADMIN);
    const impersonation = await getImpersonationManager().start({ id: ADMIN, username: 'root', isAdmin: true }, ALICE, impersonating);
    expect(impersonation.ok).toBe(true);
    expect((await (await call('GET', '/api/auth/me', { bearer: impersonating })).json()).id).toBe(ALICE);

    const res = await call('PATCH', `/api/admin/users/${ALICE}`, { bearer: adminToken, body: { isActive: false } });
    expect(res.status).toBe(200);
    expect(await isActive(ALICE)).toBe(false);

    // Every open socket is closed, the gateway one included.
    for (const ws of Object.values(sockets)) expect(ws.close).toHaveBeenCalledWith(4001, 'Account deactivated');
    expect(gateway.close).toHaveBeenCalled();
    expect(userSocketCount(ALICE)).toBe(0);
    expect(getGatewayHub().connectionManager.getConnectionsByUser(ALICE)).toHaveLength(0);

    // Session and token are dead.
    expect((await call('GET', '/api/auth/me', { bearer: session })).status).toBe(401);
    expect((await call('GET', '/api/auth/me', { bearer: apiToken })).status).toBe(401);

    // Prompts expired, impersonation over: the admin is themselves again.
    const { permissionRequests } = await import('@/db/schema/permissions');
    const [request] = await db().select().from(permissionRequests).where(eq(permissionRequests.userId, ALICE));
    expect(request.status).toBe('expired');
    expect((await (await call('GET', '/api/auth/me', { bearer: impersonating })).json()).id).toBe(ADMIN);
    expect(await getImpersonationManager().findActive(impersonating)).toBeNull();

    // No new door either: passkey, sockets, gateway.
    const passkey = await call('POST', '/api/auth/passkey/auth/verify', { body: { userId: ALICE, response: {} } });
    expect(passkey.status).toBe(401);
    expect(await passkey.json()).toEqual({ error: 'Account is disabled' });
    const again = await openSocket('/ws', `token=${session}`);
    expect(again.close).toHaveBeenCalledWith(4001, 'Invalid or expired token');
    const bridgeAgain = await openSocket('/ws/browser-bridge', `token=${apiToken}`);
    expect(bridgeAgain.close).toHaveBeenCalledWith(4001, 'Invalid authentication token');
    const voiceAgain = await openSocket('/voice', `token=${session}&engine=fasterwhisper`);
    expect(voiceAgain.close).toHaveBeenCalledWith(4001, 'Invalid or expired token');
    const gatewayAgain = await openGateway(session);
    expect(gatewayAgain.frames.at(-1)).toMatchObject({ type: 'auth_error' });
  });

  test('a SAML login of a deactivated account is refused', async () => {
    stubs.samlNameId = 'carol';
    const ok = await call('POST', '/api/saml/org-a/acs', { body: { SAMLResponse: 'x' } });
    expect(ok.status).toBe(302);

    expect((await call('PATCH', `/api/admin/users/${CAROL}`, { bearer: adminToken, body: { isActive: false } })).status).toBe(200);
    const refused = await call('POST', '/api/saml/org-a/acs', { body: { SAMLResponse: 'x' } });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('set-cookie')).toBeNull();
  });
});

describe('admin changes reach open gateway connections', () => {
  test('a demoted admin is disconnected and reconnects without admin rights', async () => {
    const session = await login(BOB);
    const before = await openGateway(session);
    expect(before.frames.at(-1)).toMatchObject({ type: 'auth_ok' });
    expect(before.frames.at(-1)!.capabilities).toContain('admin');

    expect((await call('PATCH', `/api/admin/users/${BOB}`, { bearer: adminToken, body: { isAdmin: false } })).status).toBe(200);
    expect(before.close).toHaveBeenCalledWith(4004, 'Account changed');

    const after = await openGateway(session);
    expect(after.frames.at(-1)).toMatchObject({ type: 'auth_ok', userId: BOB });
    expect(after.frames.at(-1)!.capabilities).not.toContain('admin');
    const me = await (await call('GET', '/api/auth/me', { bearer: session })).json();
    expect(me.isAdmin).toBe(false);
    expect((await call('GET', '/api/admin/users', { bearer: session })).status).toBe(403);
  });
});

describe('SCIM speaks for its own org only', () => {
  test("a token cannot deactivate or patch another org's user", async () => {
    const del = await call('DELETE', `/api/scim/v2/Users/${DAVE}`, { bearer: TOKEN_A });
    expect(del.status).toBe(404);
    const patch = await call('PATCH', `/api/scim/v2/Users/${DAVE}`, {
      bearer: TOKEN_A,
      body: { schemas: [], Operations: [{ op: 'replace', path: 'active', value: false }] },
    });
    expect(patch.status).toBe(404);
    expect(await isActive(DAVE)).toBe(true);
  });

  test('a user another org still holds only leaves this org', async () => {
    const { orgMembers } = await import('@/db/schema/organizations');
    expect((await call('DELETE', `/api/scim/v2/Users/${FRANK}`, { bearer: TOKEN_A })).status).toBe(204);
    expect(await isActive(FRANK)).toBe(true);
    const orgs = await db().select().from(orgMembers).where(eq(orgMembers.userId, FRANK));
    expect(orgs.map((r) => r.orgId)).toEqual([ORG_B]);

    // Their own org's DELETE, with nothing else left, deactivates.
    expect((await call('DELETE', `/api/scim/v2/Users/${GINA}`, { bearer: TOKEN_B })).status).toBe(204);
    expect(await isActive(GINA)).toBe(false);
  });

  test("SCIM re-activation never undoes an admin's deactivation", async () => {
    const op = (value: boolean) => ({ bearer: TOKEN_A, body: { schemas: [], Operations: [{ op: 'replace', path: 'active', value }] } });

    // The org's own deactivation, it may undo.
    expect((await call('PATCH', `/api/scim/v2/Users/${ERIN}`, op(false))).status).toBe(200);
    expect(await isActive(ERIN)).toBe(false);
    expect((await call('PATCH', `/api/scim/v2/Users/${ERIN}`, op(true))).status).toBe(200);
    expect(await isActive(ERIN)).toBe(true);

    // An admin's, it may not.
    expect((await call('PATCH', `/api/admin/users/${ERIN}`, { bearer: adminToken, body: { isActive: false } })).status).toBe(200);
    const refused = await call('PATCH', `/api/scim/v2/Users/${ERIN}`, op(true));
    expect(refused.status).toBe(409);
    expect(await isActive(ERIN)).toBe(false);
  });
});

describe('fire-time checks', () => {
  test('a hook of a deactivated user does not fire', async () => {
    const { getHookManager } = await import('@/hooks/manager');
    const { hooks } = await import('@/db/schema/hooks');
    const insertHook = async (userId: string): Promise<string> => {
      const [row] = await db().insert(hooks).values({
        userId,
        name: 'nightly',
        trigger: 'schedule',
        triggerConfig: { cronExpression: '0 3 * * *' },
        action: 'notify',
        actionConfig: { notifyMessage: 'hi' },
      }).returning();
      return row.id;
    };
    const fire = (hookId: string) => getHookManager().triggerHook(
      hookId,
      { type: 'schedule', data: { hookId }, timestamp: new Date() },
      { schedule: { cronExpression: '0 3 * * *', scheduledTime: new Date(), hookName: 'nightly' } },
    );

    const live = await insertHook(DAVE);
    expect(await fire(live)).toHaveLength(1);

    const dead = await insertHook(ALICE); // deactivated above
    expect(await fire(dead)).toEqual([]);
    const [row] = await db().select().from(hooks).where(eq(hooks.id, dead));
    expect(row.executionCount).toBe(0);
  });
});
