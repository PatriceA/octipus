/**
 * Remote members and the `~` username rule (docs/plans/coworking-spec.md §11,
 * S7; docs/SPACES.md → Across installs), through the real `createServer()`
 * and the sign-in managers:
 *
 *   - the CHECK: a local username never starts with `~`, a remote row is
 *     `~`-named, e-mail-less, password-less, never admin, with its instance;
 *   - migration `0135_guests_remote` renames an existing local `~` name;
 *   - registration (see registration.isolation.test.ts), admin creation, SCIM
 *     (create and rename) and SAML JIT refuse a `~` username;
 *   - a remote row cannot sign in: sessions (create and validate), API
 *     tokens (issue and validate), impersonation, passkeys, password login;
 *   - admin user lists, the admin edit route and SCIM leave remote rows out.
 *
 * Backed by ephemeral PGlite; the IdP (samlify) and the SCIM token's vault
 * lookup are stubbed, as in leaks-deactivation.isolation.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const stubs = vi.hoisted(() => ({ samlNameId: '', scimTokens: new Map<string, string>() }));

vi.mock('samlify', () => ({
  setSchemaValidator: () => {},
  Constants: { namespace: { binding: { post: 'post', redirect: 'redirect' }, format: { emailAddress: 'email' } } },
  ServiceProvider: () => ({ parseLoginResponse: async () => ({ extract: { nameID: stubs.samlNameId } }) }),
  IdentityProvider: () => ({}),
}));

vi.mock('@/security/vault', async () => ({
  ...(await vi.importActual<typeof import('@/security/vault')>('@/security/vault')),
  getVault: () => ({ getByName: async (_owner: string, ref: string) => stubs.scimTokens.get(ref) ?? null }),
}));

const ADMIN = randomUUID();
const LOCAL = randomUUID();
const REMOTE = randomUUID();
const ORG = randomUUID();
const SCIM_TOKEN = `scim-${rand(8)}`;
const REMOTE_NAME = '~ann@f1ng3rpr1nt';

type App = { handle(request: Request): Promise<Response> };
let app: App;
let adminToken: string;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows as T[];
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string; bearer?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const auth = opts.bearer ?? opts.token;
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
}

async function insertRemote(id: string, username: string, ref: string): Promise<void> {
  await q(`INSERT INTO users (id, username, kind, remote_instance_id, remote_user_ref) VALUES ($1, $2, 'remote', 'f1ng3rpr1nt', $3)`, [id, username, ref]);
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-user-kinds-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: ADMIN, username: 'uk-admin', isAdmin: true }, { id: LOCAL, username: 'uk-local' }]);
  await insertRemote(REMOTE, REMOTE_NAME, 'ann-1');
  await q(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'uk-org', 'UK Org')`, [ORG]);
  await q(`INSERT INTO org_sso_config (org_id, saml_enabled, scim_enabled, scim_token_vault_ref) VALUES ($1, true, true, 'uk-scim')`, [ORG]);
  // Even as an org member, a remote row is not SCIM's.
  await q(`INSERT INTO org_members (org_id, user_id) VALUES ($1, $2), ($1, $3)`, [ORG, LOCAL, REMOTE]);
  stubs.scimTokens.set('uk-scim', SCIM_TOKEN);
  const { getSessionManager } = await import('@/security/auth/session');
  adminToken = (await getSessionManager().create(ADMIN)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('the representation', () => {
  test('the CHECK holds local and remote rows to their shape', async () => {
    await expect(q(`INSERT INTO users (username) VALUES ('~sneaky')`)).rejects.toThrow(/users_kind_chk/);
    await expect(q(`INSERT INTO users (username, kind) VALUES ('~x@i', 'remote')`)).rejects.toThrow(/users_kind_chk/);
    await expect(q(`INSERT INTO users (username, kind, remote_instance_id, remote_user_ref, email) VALUES ('~y@i', 'remote', 'i', 'r', 'y@example.com')`)).rejects.toThrow(/users_kind_chk/);
    await expect(q(`INSERT INTO users (username, kind, remote_instance_id, remote_user_ref, is_admin) VALUES ('~z@i', 'remote', 'i', 'r2', true)`)).rejects.toThrow(/users_kind_chk/);
    await expect(q(`INSERT INTO users (username, kind, remote_instance_id, remote_user_ref) VALUES ('noprefix', 'remote', 'i', 'r3')`)).rejects.toThrow(/users_kind_chk/);
    // `@` stays allowed for local names (SAML NameIDs, SCIM userNames).
    await q(`INSERT INTO users (username) VALUES ('someone@example.com')`);
    // One row per remote identity.
    await expect(insertRemote(randomUUID(), '~ann2@f1ng3rpr1nt', 'ann-1')).rejects.toThrow();
  });

  test('the migration renames an existing local ~ username before its CHECK, and re-runs cleanly', async () => {
    await q(`ALTER TABLE users DROP CONSTRAINT users_kind_chk`);
    const id = randomUUID();
    await q(`INSERT INTO users (id, username) VALUES ($1, '~legacy')`, [id]);
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0135_guests_remote.sql'), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.replace(/--.*$/gm, '').trim()) await q(statement);
    }
    const [row] = await q<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [id]);
    expect(row.username).toBe(`renamed-${id.replace(/-/g, '').slice(0, 8)}-legacy`);
    expect((await q<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [REMOTE]))[0].username).toBe(REMOTE_NAME);
    await expect(q(`INSERT INTO users (username) VALUES ('~again')`)).rejects.toThrow(/users_kind_chk/);
  });
});

describe('a remote row never signs in', () => {
  test('sessions: create refuses it', async () => {
    const { getSessionManager, InactiveUserError, RemoteUserError } = await import('@/security/auth/session');
    const err = await getSessionManager().create(REMOTE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteUserError);
    expect(err).toBeInstanceOf(InactiveUserError);
  });

  test('a session or API token minted before the row became remote stops working', async () => {
    const id = randomUUID();
    await q(`INSERT INTO users (id, username) VALUES ($1, 'turncoat')`, [id]);
    const { getSessionManager } = await import('@/security/auth/session');
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const { token } = await getSessionManager().create(id);
    const issued = await getApiTokenManager().issue(id, { name: 't' });
    expect(await getSessionManager().validate(token)).not.toBeNull();
    expect(await getApiTokenManager().validate(issued.plaintext)).not.toBeNull();
    await q(`UPDATE users SET kind = 'remote', username = '~turncoat@i', remote_instance_id = 'i', remote_user_ref = 'tc', password_hash = NULL, email = NULL WHERE id = $1`, [id]);
    expect(await getSessionManager().validate(token)).toBeNull();
    expect(await getApiTokenManager().validate(issued.plaintext)).toBeNull();
    // Nor is a new token issued.
    await expect(getApiTokenManager().issue(id, { name: 'again' })).rejects.toThrow(/other installs/);
  });

  test('password login, passkeys and impersonation refuse it', async () => {
    const login = await call('POST', '/api/auth/login', { body: { username: REMOTE_NAME, password: 'Passw0rd!' } });
    expect(login.status).toBeGreaterThanOrEqual(400);
    expect(login.headers.get('set-cookie')).toBeNull();

    const { getPasskeyAuth } = await import('@/security/auth/passkey');
    await expect(getPasskeyAuth().generateAuthenticationOptions(REMOTE)).rejects.toThrow(/other installs/);
    await getPasskeyAuth().generateAuthenticationOptions();
    await expect(getPasskeyAuth().verifyAuthentication(REMOTE, { id: 'x' } as never)).rejects.toThrow(/other installs/);
    await expect(getPasskeyAuth().generateRegistrationOptions(REMOTE, REMOTE_NAME)).rejects.toThrow(/other installs/);

    const res = await call('POST', `/api/admin/impersonate/${REMOTE}`, { token: adminToken });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/other installs/);
  });
});

describe('admin and SCIM leave remote rows out, and refuse ~ names', () => {
  test('admin: the user and quota lists, the edit route, creation', async () => {
    const { users } = await (await call('GET', '/api/admin/users', { token: adminToken })).json() as { users: Array<{ id: string }> };
    expect(users.map((u) => u.id)).toContain(LOCAL);
    expect(users.map((u) => u.id)).not.toContain(REMOTE);
    const quotas = await (await call('GET', '/api/admin/quotas', { token: adminToken })).json() as { users?: Array<{ userId: string }>; quotas?: Array<{ userId: string }> };
    expect((quotas.users ?? quotas.quotas ?? []).map((u) => u.userId)).not.toContain(REMOTE);
    expect((await call('PATCH', `/api/admin/users/${REMOTE}`, { token: adminToken, body: { isAdmin: true } })).status).toBe(404);
    const created = await call('POST', '/api/admin/users', { token: adminToken, body: { username: '~fake@elsewhere' } });
    expect(created.status).toBe(400);
    expect((await call('POST', '/api/admin/users', { token: adminToken, body: { username: 'real-person' } })).status).toBe(200);
  });

  test('SCIM: list, get, create and rename', async () => {
    const list = await (await call('GET', '/api/scim/v2/Users', { bearer: SCIM_TOKEN })).json() as { Resources: Array<{ id: string }> };
    expect(list.Resources.map((r) => r.id)).toEqual([LOCAL]);
    expect((await call('GET', `/api/scim/v2/Users/${REMOTE}`, { bearer: SCIM_TOKEN })).status).toBe(404);
    expect((await call('PATCH', `/api/scim/v2/Users/${REMOTE}`, { bearer: SCIM_TOKEN, body: { schemas: [], Operations: [{ op: 'replace', path: 'active', value: false }] } })).status).toBe(404);
    expect((await call('DELETE', `/api/scim/v2/Users/${REMOTE}`, { bearer: SCIM_TOKEN })).status).toBe(404);
    const create = await call('POST', '/api/scim/v2/Users', { bearer: SCIM_TOKEN, body: { schemas: [], userName: '~bob@idp' } });
    expect(create.status).toBe(400);
    expect((await create.json()).scimType).toBe('invalidValue');
    const own = await (await call('POST', '/api/scim/v2/Users', { bearer: SCIM_TOKEN, body: { schemas: [], userName: 'scim-own@idp' } })).json() as { id: string };
    const rename = await call('PATCH', `/api/scim/v2/Users/${own.id}`, { bearer: SCIM_TOKEN, body: { schemas: [], Operations: [{ op: 'replace', path: 'userName', value: '~bob@idp' }] } });
    expect(rename.status).toBe(400);
    expect((await q(`SELECT username FROM users WHERE id = $1`, [own.id]))[0]).toEqual({ username: 'scim-own@idp' });
  });

  test('SAML JIT refuses a ~ NameID, and creates nothing', async () => {
    stubs.samlNameId = REMOTE_NAME;
    const res = await call('POST', '/api/saml/uk-org/acs', { body: { SAMLResponse: 'x' } });
    expect(res.status).toBe(400);
    stubs.samlNameId = '~newcomer@idp';
    expect((await call('POST', '/api/saml/uk-org/acs', { body: { SAMLResponse: 'x' } })).status).toBe(400);
    expect(await q(`SELECT id FROM users WHERE username = '~newcomer@idp'`)).toHaveLength(0);
  });
});
