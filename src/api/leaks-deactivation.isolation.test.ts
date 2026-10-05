/**
 * Deactivation and SCIM scope (docs/plans/coworking-spec.md §4.1, L7/L8).
 *
 * Drives the real application (`createServer`: auth derive, admin, auth,
 * SAML and SCIM routes, every websocket endpoint) on embedded PGlite:
 *   - a deactivated user's session, API token, passkey login, SAML login and
 *     every open socket fail, and their pending prompts and impersonations end;
 *   - a demoted admin's gateway socket is closed and reconnects without admin;
 *   - a SCIM token cannot deactivate another org's user, and only deactivates
 *     an account no other org holds; its POST does not adopt an account
 *     outside its org, and its PATCH renames only accounts the org alone holds;
 *   - an org's IdP signs in that org's members or new accounts, never another
 *     account (the admin's included);
 *   - a socket whose credential was checked before a deactivation and that
 *     registers after the sweep is closed all the same;
 *   - an admin's deactivation of an account SCIM already switched off is
 *     recorded, and a failed deactivation step does not drop the rest of the
 *     admin's edit;
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
const HANK = '10000000-0000-4000-8000-000000000009';
const IVY = '10000000-0000-4000-8000-00000000000a';
const JACK = '10000000-0000-4000-8000-00000000000b';
const KATE = '10000000-0000-4000-8000-00000000000c';
const LIAM = '10000000-0000-4000-8000-00000000000d';
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
    { id: HANK, username: 'hank' },
    { id: IVY, username: 'ivy' },
    { id: JACK, username: 'jack' },
    { id: KATE, username: 'kate' },
    { id: LIAM, username: 'liam' },
  ]);
  await executeRaw(`INSERT INTO organizations (id, slug, name) VALUES ('${ORG_A}', 'org-a', 'Org A'), ('${ORG_B}', 'org-b', 'Org B')`);
  await executeRaw(
    `INSERT INTO org_sso_config (org_id, saml_enabled, scim_enabled, scim_token_vault_ref)
     VALUES ('${ORG_A}', true, true, 'scim-a'), ('${ORG_B}', false, true, 'scim-b')`,
  );
  // carol: SAML user of A. dave: B only. erin: A only. frank: A and B. gina: B only.
  // hank: A and B. ivy: A only.
  await executeRaw(
    `INSERT INTO org_members (org_id, user_id) VALUES
       ('${ORG_A}', '${CAROL}'), ('${ORG_B}', '${DAVE}'), ('${ORG_A}', '${ERIN}'),
       ('${ORG_A}', '${FRANK}'), ('${ORG_B}', '${FRANK}'), ('${ORG_B}', '${GINA}'),
       ('${ORG_A}', '${HANK}'), ('${ORG_B}', '${HANK}'), ('${ORG_A}', '${IVY}')`,
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
      bridge: await openSocket('/ws/browser-bridge', `token=${apiToken}`),
      voice: await openSocket('/voice', `token=${session}&engine=fasterwhisper`),
    };
    for (const ws of Object.values(sockets)) expect(ws.close).not.toHaveBeenCalled();
    const gateway = await openGateway(session);
    expect(gateway.frames.at(-1)).toMatchObject({ type: 'auth_ok', userId: ALICE });
    expect(userSocketCount(ALICE)).toBe(2);

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

describe("an org's IdP speaks for that org only", () => {
  test('it cannot sign in an account outside the org, the admin included', async () => {
    const { orgMembers } = await import('@/db/schema/organizations');
    for (const username of ['root', 'dave']) {
      stubs.samlNameId = username;
      const res = await call('POST', '/api/saml/org-a/acs', { body: { SAMLResponse: 'x' } });
      expect(res.status).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    // Not adopted into the org either.
    for (const id of [ADMIN, DAVE]) {
      const rows = await db().select().from(orgMembers).where(eq(orgMembers.userId, id));
      expect(rows.map((r) => r.orgId)).not.toContain(ORG_A);
    }
  });

  test('it creates a new account as a member of the org', async () => {
    const { users } = await import('@/db/schema/users');
    const { orgMembers } = await import('@/db/schema/organizations');
    stubs.samlNameId = 'saml-newcomer';
    const res = await call('POST', '/api/saml/org-a/acs', { body: { SAMLResponse: 'x' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('session_token=');
    const [created] = await db().select().from(users).where(eq(users.username, 'saml-newcomer'));
    const rows = await db().select().from(orgMembers).where(eq(orgMembers.userId, created.id));
    expect(rows.map((r) => r.orgId)).toEqual([ORG_A]);
  });
});

describe('a socket that authenticates across a deactivation', () => {
  /** Run `change` after the credential check passed and before the socket registers. */
  async function duringValidation(change: () => Promise<void>): Promise<void> {
    const { getSessionManager } = await import('@/security/auth/session');
    const sm = getSessionManager();
    const original = sm.validate.bind(sm);
    vi.spyOn(sm, 'validate').mockImplementationOnce(async (token: string) => {
      const session = await original(token);
      await change();
      return session;
    });
  }

  test('a /voice socket registered after the sweep is closed', async () => {
    const { userSocketCount } = await import('./user-sockets');
    const session = await login(KATE);
    await duringValidation(async () => {
      expect((await call('PATCH', `/api/admin/users/${KATE}`, { bearer: adminToken, body: { isActive: false } })).status).toBe(200);
    });
    const ws = await openSocket('/voice', `token=${session}&engine=fasterwhisper`);
    expect(ws.close).toHaveBeenCalledWith(4004, 'Account changed');
    expect(userSocketCount(KATE)).toBe(0);
  });

  test('a gateway connection registered after the sweep is closed, without auth_ok', async () => {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const session = await login(LIAM);
    await duringValidation(async () => {
      expect((await call('PATCH', `/api/admin/users/${LIAM}`, { bearer: adminToken, body: { isAdmin: true } })).status).toBe(200);
    });
    const gateway = await openGateway(session);
    expect(gateway.close).toHaveBeenCalledWith(4004, 'Account changed');
    expect(gateway.frames.some((f) => f.type === 'auth_ok')).toBe(false);
    expect(getGatewayHub().connectionManager.getConnectionsByUser(LIAM)).toHaveLength(0);

    // A reconnect authenticates with the current row.
    const again = await openGateway(session);
    expect(again.frames.at(-1)).toMatchObject({ type: 'auth_ok', userId: LIAM });
    expect(again.frames.at(-1)!.capabilities).toContain('admin');
  });
});

describe('admin deactivation edge cases', () => {
  test("an admin's deactivation of a SCIM-deactivated account sticks", async () => {
    const op = (value: boolean) => ({ bearer: TOKEN_A, body: { schemas: [], Operations: [{ op: 'replace', path: 'active', value }] } });
    expect((await call('PATCH', `/api/scim/v2/Users/${IVY}`, op(false))).status).toBe(200);
    expect(await isActive(IVY)).toBe(false);

    // Already off: the admin's decision is recorded all the same.
    expect((await call('PATCH', `/api/admin/users/${IVY}`, { bearer: adminToken, body: { isActive: false } })).status).toBe(200);
    const { userRepository } = await import('@/db/repositories/user-repository');
    expect((await userRepository.findById(IVY))!.deactivatedBy).toBe('admin');

    const refused = await call('PATCH', `/api/scim/v2/Users/${IVY}`, op(true));
    expect(refused.status).toBe(409);
    expect(await isActive(IVY)).toBe(false);
  });

  test('a failed deactivation step is reported and the rest of the edit applies', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const spy = vi.spyOn(getPermissionManager(), 'expireForUser').mockRejectedValueOnce(new Error('db hiccup'));
    const res = await call('PATCH', `/api/admin/users/${JACK}`, {
      bearer: adminToken,
      body: { isActive: false, email: 'jack@example.test' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toEqual(['Deactivation step failed: expire permission requests']);
    expect(body.email).toBe('jack@example.test');
    expect(body.isActive).toBe(false);
    expect(spy).toHaveBeenCalledWith(JACK);
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

  test('POST does not adopt an account outside the org, so it cannot then delete it', async () => {
    const userBody = (userName: string) => ({ bearer: TOKEN_A, body: { schemas: [], userName } });
    for (const [userName, id] of [['root', ADMIN], ['dave', DAVE]] as const) {
      const res = await call('POST', '/api/scim/v2/Users', userBody(userName));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.scimType).toBe('uniqueness');
      expect(body.id).toBeUndefined();
      expect((await call('DELETE', `/api/scim/v2/Users/${id}`, { bearer: TOKEN_A })).status).toBe(404);
      expect(await isActive(id)).toBe(true);
    }

    // A member re-POSTed by reconciliation is returned as-is.
    const again = await call('POST', '/api/scim/v2/Users', userBody('hank'));
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(HANK);
  });

  test('PATCH renames only an account the org alone holds', async () => {
    const { userRepository } = await import('@/db/repositories/user-repository');
    const rename = (id: string) => call('PATCH', `/api/scim/v2/Users/${id}`, {
      bearer: TOKEN_A,
      body: { schemas: [], Operations: [{ op: 'replace', path: 'emails', value: [{ value: `${id.slice(-4)}@org-a.test`, primary: true }] }] },
    });

    // hank is also in org B: refused, nothing written.
    const shared = await rename(HANK);
    expect(shared.status).toBe(403);
    expect((await userRepository.findById(HANK))!.email).toBeNull();

    // An account the org provisioned itself: allowed.
    const created = await call('POST', '/api/scim/v2/Users', { bearer: TOKEN_A, body: { schemas: [], userName: 'scim-own' } });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await rename(id)).status).toBe(200);
    expect((await userRepository.findById(id))!.email).toBe(`${id.slice(-4)}@org-a.test`);
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
