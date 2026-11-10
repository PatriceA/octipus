/**
 * Pages and the host API end to end (docs/PLUGIN-PACKAGES.md#pages,
 * #host-api): the host fixture package, a real child process speaking MCP
 * over stdio, calling back into a real HTTP listener through its egress
 * proxy with the token its call carries.
 *
 * What must hold:
 * - enabling asks for the declared host scopes, and an upgrade that adds one
 *   asks again;
 * - a call's token carries declared ∩ approved ∩ effect ∩ user-held scopes,
 *   acts in the user's own data scope, dies with the call, and is useless for
 *   another package; the proxy reaches nothing but `/api/plugin-host/`;
 * - documents above the package's maxProtection are refused;
 * - every host API request is audited;
 * - the page bridge calls only the package's own declared tools, as the
 *   signed-in user, through the normal permission path (an external tool
 *   needs the user's confirmation), rate-limited; its files are served only
 *   while the package is enabled, under the sandboxing CSP.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import type { RunningServer } from '@/api/http';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-host-ws-'));

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', username: 'admin', isAdmin: true };
const MEMBER = { id: '22222222-2222-4222-8222-222222222222', username: 'member', isAdmin: false };
const fixture = vi.hoisted(() => ({ user: null as null | { id: string; username: string; isAdmin: boolean } }));
vi.mock('@/api/context', async () => {
  const { principalFromUser } = await import('@/security/principal');
  return {
    apiContext: new (await import('@/api/http')).App().derive(() => ({
      user: fixture.user,
      principal: fixture.user ? principalFromUser(fixture.user) : { kind: 'anonymous' },
    })),
  };
});

const FIXTURE_DIR = join(__dirname, 'fixtures', 'host-plugin');
const NAME = 'host-plugin';
const SERVER = `plugin-${NAME}`;
const ALL_SCOPES = ['notes:read', 'notes:write', 'tasks:write', 'documents:read', 'notify'];

let server: RunningServer;
let base: string;
let app: import('@/api/http').App;

/** The user's own agent, in their conversation: the one kind of agent call that gets a host token. */
function agentContext(userId = ADMIN.id, over: Partial<AgentContext> = {}): AgentContext {
  return {
    id: `agent-${rand(4)}`, userId, sessionId: `sess-${rand(4)}`, role: 'general', status: 'running', attended: false,
    workspaceId: null, space: null, trigger: 'user', metadata: {}, ...over,
  } as unknown as AgentContext;
}

/** The JSON a fixture tool answered. */
function out(result: unknown): Record<string, any> {
  return JSON.parse(((result as { content: Array<{ text: string }> }).content[0]).text);
}

async function callAs(tool: string, args: Record<string, unknown> = {}, userId = ADMIN.id, over: Partial<AgentContext> = {}): Promise<Record<string, any>> {
  const { getMCPBridge } = await import('@/mcp/bridge');
  return out(await getMCPBridge().callTool(SERVER, tool, args, agentContext(userId, over)));
}

/** A write tool, run as if the user approved it (a dispatch receipt). */
async function callApproved(tool: string, args: Record<string, unknown> = {}, userId = ADMIN.id): Promise<Record<string, any>> {
  const { getMCPBridge } = await import('@/mcp/bridge');
  const { withDispatchAuthorization } = await import('@/security/dispatch-authorization');
  const context = agentContext(userId);
  const authArgs = { server_id: SERVER, tool_name: tool, arguments: args };
  return out(await withDispatchAuthorization(context, 'mcp', `${SERVER}.${tool}`, authArgs, 'approval:test',
    () => getMCPBridge().callTool(SERVER, tool, args, context, authArgs)));
}

/** Egress proxies of test packages (a label each), pointed at the listener as a package's would be. */
const proxies = new Map<string, import('@/security/egress-proxy').EgressProxy>();

/** A request to the host API through `plugin`'s egress proxy, as a package sends it. */
async function hostApi(path: string, token: string, plugin = NAME): Promise<{ status: number; body: any }> {
  const { startEgressProxy } = await import('@/security/egress-proxy');
  let proxy = proxies.get(plugin);
  if (!proxy) {
    proxy = await startEgressProxy({ label: plugin, allowed: [], hostApi: { host: '127.0.0.1', port: server.port } });
    proxies.set(plugin, proxy);
  }
  const { request } = await import('node:http');
  const port = proxy.port;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `http://octipus-host.internal/api/plugin-host${path}`, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let body: unknown = null; try { body = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function route(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function hostAudit(): Promise<Array<{ action: string; userId: string; details: Record<string, any> }>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT action, user_id, details FROM audit_log WHERE resource_type = 'plugin_host' ORDER BY created_at`);
  return rows.map((r: { action: string; user_id: string; details: unknown }) => ({
    action: r.action, userId: r.user_id, details: (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, any>,
  }));
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-host-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${ADMIN.id}', 'admin', true), ('${MEMBER.id}', 'member', false) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();

  const { App, listen } = await import('@/api/http');
  const { pluginHostRoutes } = await import('@/api/routes/plugin-host');
  const { pluginCallRoutes, pluginUiRoutes } = await import('@/api/routes/plugin-ui');
  const { pluginPackageRoutes } = await import('@/api/routes/plugin-packages');
  app = new App({ prefix: '/api' }).use(pluginUiRoutes).use(pluginCallRoutes).use(pluginHostRoutes).use(pluginPackageRoutes);
  server = listen(app, { hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => setTimeout(r, 50));
  base = `http://127.0.0.1:${server.port}`;
  const { setHostApiPort } = await import('./host-api');
  setHostApiPort(server.port);
});

afterAll(async () => {
  const { getMCPBridge } = await import('@/mcp/bridge');
  await getMCPBridge().disconnect(SERVER);
  for (const proxy of proxies.values()) await proxy.close();
  server?.stop(true);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('host API scopes', () => {
  test('enabling asks for the declared scopes; only declared scopes can be approved', async () => {
    const svc = await import('./service');
    await svc.installFromDirectory(FIXTURE_DIR, ADMIN.id);
    expect((await svc.packageView(NAME)).approvedHostScopes).toBeNull();
    await expect(svc.setEnabled(NAME, true, ADMIN.id)).rejects.toMatchObject({ code: 'incomplete', message: expect.stringContaining('notes:write') });
    await expect(svc.configure(NAME, { approveHostScopes: ['tasks:read'] }, ADMIN.id)).rejects.toMatchObject({ code: 'invalid' });
    await expect(svc.configure(NAME, { approveHostScopes: 'all' }, ADMIN.id)).rejects.toMatchObject({ code: 'invalid' });
    // Part of them is not enough to enable.
    await expect(svc.configure(NAME, { approveHostScopes: ['notes:read'], enabled: true }, ADMIN.id)).rejects.toMatchObject({ code: 'incomplete' });
    // Through the admin route, as the web page sends it.
    fixture.user = ADMIN;
    expect((await route('PATCH', `/api/plugin-packages/${NAME}`, { enabled: true })).status).toBe(409);
    const enabled = await route('PATCH', `/api/plugin-packages/${NAME}`, { enabled: true, approveHostScopes: ALL_SCOPES });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ enabled: true, approvedHostScopes: ALL_SCOPES });
    expect((await route('PATCH', `/api/plugin-packages/${NAME}`, { approveHostScopes: 'all' })).status).toBe(422);
    fixture.user = MEMBER;
    expect((await route('PATCH', `/api/plugin-packages/${NAME}`, { approveHostScopes: [] })).status).toBe(403);
    fixture.user = null;
    const view = await svc.packageView(NAME);
    expect(view.approvedHostScopes).toEqual(ALL_SCOPES);
    expect(view.connected).toBe(true);
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT details FROM audit_log WHERE resource_type = 'plugin_package' AND resource_id = '${NAME}'`);
    expect(rows.map((r: { details: any }) => (typeof r.details === 'string' ? JSON.parse(r.details) : r.details).op)).toContain('host_scopes_approved');
  });

  test('a read tool gets the read scopes only, and reaches the host API through its proxy', async () => {
    const who = await callAs('whoami');
    expect(who.env).toBe('http://octipus-host.internal');
    expect(who.meta.scopes).toEqual(['notes:read', 'documents:read']);
    expect(who.res).toMatchObject({ status: 200, body: { plugin: NAME, tool: 'whoami', scopes: ['notes:read', 'documents:read'], workspace: 'personal' } });
    // A write through a read tool's token is refused, and audited.
    expect(await callAs('write_from_read')).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    const denied = (await hostAudit()).filter((a) => a.details.op === 'notes.create');
    expect(denied.at(-1)).toMatchObject({ action: 'permission_denied', userId: ADMIN.id, details: { status: 403, code: 'scope_missing', tool: 'write_from_read' } });
  });

  test('a write tool writes in the calling user\'s own data, as that user', async () => {
    expect(await callApproved('make_note', { title: 'From the plugin' })).toMatchObject({ status: 200 });
    expect(await callApproved('make_note', { title: 'From the plugin' })).toMatchObject({ status: 409, body: { code: 'exists' } });
    const listed = await callAs('list_notes');
    expect(listed.body.notes.map((n: { title: string }) => n.title)).toContain('From the plugin');
    // Another user calling the same tool sees their own notes, not the admin's.
    expect((await callAs('list_notes', {}, MEMBER.id)).body.notes).toEqual([]);
    expect(await callApproved('make_task', { title: 'Plugin task' })).toMatchObject({ status: 200, body: { title: 'Plugin task' } });
    expect(await callApproved('notify_me')).toMatchObject({ status: 200 });
    const { queryRaw } = await import('@/db/postgres');
    const notes = await queryRaw(`SELECT user_id FROM notes WHERE title = 'From the plugin'`);
    expect(notes.rows.map((r: { user_id: string }) => r.user_id)).toEqual([ADMIN.id]);
    const notified = await queryRaw(`SELECT user_id, type FROM notifications WHERE type = 'plugin'`);
    expect(notified.rows).toEqual([{ user_id: ADMIN.id, type: 'plugin' }]);
    const ok = (await hostAudit()).filter((a) => a.action === 'tool_executed').map((a) => a.details.op);
    expect(ok).toEqual(expect.arrayContaining(['notes.create', 'notes.list', 'tasks.create', 'notify', 'whoami']));
  });

  test('a scope the user\'s own rules deny is not handed over', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().setPermission(ADMIN.id, 'notes', 'write', 'DENY');
    try {
      expect(await callApproved('make_note', { title: 'Denied' })).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    } finally {
      await getPermissionManager().setPermission(ADMIN.id, 'notes', 'write', 'ALLOW');
    }
  });

  test('the token dies with the call and is bound to its package', async () => {
    const leaked = await callAs('leak_token');
    expect(leaked.token).toMatch(/^ocph_/);
    expect(await hostApi('/whoami', leaked.token)).toMatchObject({ status: 401, body: { code: 'invalid_token' } });
    // A live one for another package, or without the proxy's stamp, gets nothing either.
    const { mintHostToken } = await import('./host-api');
    const { token } = mintHostToken({ plugin: NAME, userId: ADMIN.id, workspaceId: null, sessionId: null, scopes: ['notes:read'], maxProtection: 2, tool: 'x' }, 30_000);
    expect((await hostApi('/whoami', token)).status).toBe(200);
    expect((await hostApi('/whoami', token, 'echo-plugin')).status).toBe(401);
    const unstamped = await fetch(`${base}/api/plugin-host/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(unstamped.status).toBe(401);
    // A stamp the client wrote itself, without the proxy's secret, is no stamp.
    const forged = await fetch(`${base}/api/plugin-host/whoami`, { headers: { authorization: `Bearer ${token}`, 'x-octipus-plugin-egress': NAME, 'x-octipus-plugin-egress-key': 'guess' } });
    expect([forged.status, ((await forged.json()) as { code: string }).code]).toEqual([401, 'not_via_proxy']);
    // A scope it does not carry.
    expect(await hostApi('/tasks', token)).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    // The token is no session or API token.
    const { looksLikeApiToken } = await import('@/security/api-tokens');
    expect(looksLikeApiToken(token)).toBe(false);
  });

  test('a token names a workspace only the user may reach', async () => {
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const memberWs = await getOrgWorkspaceManager().ensureDefaultWorkspace(MEMBER.id);
    await callApproved('make_note', { title: 'Member secret' }, MEMBER.id).catch(() => null);
    const { mintHostToken } = await import('./host-api');
    const { token } = mintHostToken({ plugin: NAME, userId: ADMIN.id, workspaceId: memberWs.id, sessionId: null, scopes: ['notes:read'], maxProtection: 2, tool: 'x' }, 30_000);
    const listed = await hostApi('/notes', token);
    expect(listed.status).toBe(200);
    expect(listed.body.notes.map((n: { title: string }) => n.title)).not.toContain('Member secret');
    // A deactivated user's token acts for nobody.
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE users SET is_active = false WHERE id = '${MEMBER.id}'`);
    const gone = mintHostToken({ plugin: NAME, userId: MEMBER.id, workspaceId: null, sessionId: null, scopes: ['notes:read'], maxProtection: 2, tool: 'x' }, 30_000);
    expect(await hostApi('/notes', gone.token)).toMatchObject({ status: 403, body: { code: 'principal_gone' } });
    await executeRaw(`UPDATE users SET is_active = true WHERE id = '${MEMBER.id}'`);
  });

  test('documents above the package\'s maxProtection are refused', async () => {
    const { queryRaw } = await import('@/db/postgres');
    const insert = async (level: number | null) => (await queryRaw(
      `INSERT INTO documents (user_id, filename, original_name, mime_type, size, status, storage_path, protection_level, ocr_text)
       VALUES ($1, 'f.txt', 'f.txt', 'text/plain', 1, 'completed', '/x', $2, 'secret text') RETURNING id`, [ADMIN.id, level])).rows[0].id as string;
    const low = await insert(1);
    const high = await insert(3);
    const unclear = await insert(null);
    expect(await callAs('read_doc', { id: low })).toMatchObject({ status: 200, body: { text: 'secret text', protectionLevel: 1 } });
    expect(await callAs('read_doc', { id: high })).toMatchObject({ status: 403, body: { code: 'protection_level' } });
    expect(await callAs('read_doc', { id: unclear })).toMatchObject({ status: 403, body: { code: 'protection_level' } });
    // Someone else's document is not there for this user.
    expect((await callAs('read_doc', { id: low }, MEMBER.id)).status).toBe(404);
  });

  test('calls nobody started by hand get no token: events, context, schedules, other turns', async () => {
    for (const contribution of ['event', 'context', 'schedule']) {
      const res = await callAs('whoami', {}, ADMIN.id, { metadata: { source: 'plugin-contribution', plugin: NAME, contribution } } as Partial<AgentContext>);
      expect(res.noHost, contribution).toBe(true);
    }
    expect((await callAs('whoami', {}, ADMIN.id, { trigger: 'schedule' })).noHost).toBe(true);
    expect((await callAs('whoami', {}, ADMIN.id, { sessionId: '' })).noHost).toBe(true);
    const command = await callAs('whoami', {}, ADMIN.id, { metadata: { source: 'plugin-contribution', plugin: NAME, contribution: 'command' } } as Partial<AgentContext>);
    expect(command.res.status).toBe(200);
  });

  test('tasks above the package\'s maxProtection (by their provenance) are left out, and the session learns what it read', async () => {
    const { queryRaw } = await import('@/db/postgres');
    const add = (title: string, ref: Record<string, unknown> | null) => queryRaw(
      `INSERT INTO tasks (user_id, title, source, source_ref) VALUES ($1, $2, 'agent', $3)`, [ADMIN.id, title, ref === null ? null : JSON.stringify(ref)]);
    await add('Plain task', null);
    await add('Internal task', { sessionId: 'x', protectionLevel: 2, flowLabel: { private: 'mail:read' } });
    await add('Confidential task', { sessionId: 'y', protectionLevel: 3 });
    const { mintHostToken } = await import('./host-api');
    const sessionId = `sess-${rand(4)}`;
    const { token } = mintHostToken({ plugin: NAME, userId: ADMIN.id, workspaceId: null, sessionId, scopes: ['tasks:read'], maxProtection: 2, tool: 'x' }, 30_000);
    const listed = await hostApi('/tasks', token);
    expect(listed.status).toBe(200);
    const titles = listed.body.tasks.map((t: { title: string }) => t.title);
    expect(titles).toEqual(expect.arrayContaining(['Plain task', 'Internal task']));
    expect(titles).not.toContain('Confidential task');
    expect(listed.body.withheld).toBe(1);
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    expect(sessionProtectionLevel(sessionId)).toBe(2);
    const { getFlowLabel } = await import('@/security/flow-guard');
    expect(getFlowLabel(sessionId).private).toBe(true);
  });

  test('refusals without a token are limited per address and audited in aggregate', async () => {
    const { _resetRateLimits } = await import('@/core/artifacts/rate-limit');
    const { _resetHostRefusals } = await import('@/api/routes/plugin-host');
    _resetRateLimits();
    _resetHostRefusals();
    const before = (await hostAudit()).filter((a) => a.details.op === 'refused').length;
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      statuses.push((await fetch(`${base}/api/plugin-host/whoami`, { headers: { 'x-octipus-plugin-egress': NAME, 'x-octipus-plugin-egress-key': `k${i}` } })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses).toContain(429);
    // One row for the window, not thirty.
    const rows = (await hostAudit()).filter((a) => a.details.op === 'refused');
    expect(rows.length - before).toBe(1);
    expect(rows.at(-1)).toMatchObject({ action: 'permission_denied', details: { code: 'not_via_proxy', count: 1 } });
    _resetRateLimits();
  });

  test('the proxy reaches nothing of the host but the host API', async () => {
    for (const url of ['http://octipus-host.internal/api/auth/me', `http://octipus-host.internal:${server.port}/api/plugin-host/whoami`, `http://127.0.0.1:${server.port}/api/plugin-host/whoami`]) {
      expect((await callAs('probe', { url })).status, url).toBe(403);
    }
  });
});

describe('pages', () => {
  test('the sidebar lists the page, and its files are served under the sandboxing CSP', async () => {
    fixture.user = MEMBER;
    const pages = await route('GET', '/api/plugin-ui');
    expect(pages.body.pages).toEqual([{ plugin: NAME, pluginTitle: 'Host API (test fixture)', path: 'dashboard', title: 'Host dashboard', icon: 'layout-dashboard', src: '/api/plugin-ui/host-plugin/index.html' }]);
    fixture.user = null;
    expect((await route('GET', '/api/plugin-ui')).status).toBe(401);
    const frame = { 'sec-fetch-dest': 'iframe' };
    const file = await route('GET', '/api/plugin-ui/host-plugin/index.html', undefined, frame);
    expect(file.status).toBe(200);
    // Never opened on its own, nor without the header, nor a script as a frame.
    expect((await route('GET', '/api/plugin-ui/host-plugin/index.html', undefined, { 'sec-fetch-dest': 'document' })).status).toBe(404);
    expect((await route('GET', '/api/plugin-ui/host-plugin/index.html')).status).toBe(404);
    expect((await route('GET', '/api/plugin-ui/host-plugin/app.js', undefined, frame)).status).toBe(404);
    expect(file.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(file.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(file.headers.get('content-security-policy')).toContain("script-src http://localhost/api/plugin-ui/host-plugin/");
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await route('GET', '/api/plugin-ui/host-plugin/app.js', undefined, { 'sec-fetch-dest': 'script' })).status).toBe(200);
    for (const p of ['/api/plugin-ui/host-plugin/../server.mjs', '/api/plugin-ui/host-plugin/%2e%2e/server.mjs', '/api/plugin-ui/host-plugin/server.mjs', '/api/plugin-ui/echo-plugin/index.html']) {
      expect((await route('GET', p, undefined, { 'sec-fetch-dest': 'script' })).status, p).toBe(404);
      expect((await route('GET', p, undefined, frame)).status, p).toBe(404);
    }
  });

  test('the bridge calls only the package\'s own declared tools, as the signed-in user', async () => {
    fixture.user = null;
    expect((await route('POST', '/api/plugins/host-plugin/call/whoami', { args: {} })).status).toBe(401);
    fixture.user = MEMBER;
    const who = await route('POST', '/api/plugins/host-plugin/call/whoami', { args: {} });
    expect(who.status).toBe(200);
    expect(out(who.body.result).res.status).toBe(200);
    // Another package's tool, an undeclared one, a package without pages or not installed.
    expect(await route('POST', '/api/plugins/host-plugin/call/echo', { args: {} })).toMatchObject({ status: 404, body: { code: 'unknown_tool' } });
    expect(await route('POST', '/api/plugins/host-plugin/call/undeclared_tool', { args: {} })).toMatchObject({ status: 404 });
    expect(await route('POST', '/api/plugins/echo-plugin/call/echo', { args: {} })).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  test('an external tool needs the user\'s confirmation, which counts for that call only', async () => {
    fixture.user = MEMBER;
    expect(await route('POST', '/api/plugins/host-plugin/call/send_letter', { args: { to: 'x' } }))
      .toMatchObject({ status: 409, body: { code: 'approval_required', effect: 'external' } });
    const confirmed = await route('POST', '/api/plugins/host-plugin/call/send_letter', { args: { to: 'x' }, confirm: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.result.content[0].text).toBe('called send_letter');
    expect((await route('POST', '/api/plugins/host-plugin/call/send_letter', { args: { to: 'x' } })).status).toBe(409);
    // A DENY rule is not overridden by a confirmation.
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().setPermission(MEMBER.id, 'mcp', `${SERVER}.send_letter`, 'DENY');
    expect((await route('POST', '/api/plugins/host-plugin/call/send_letter', { args: {}, confirm: true })).status).toBe(403);
  });

  test('the bridge is rate-limited per user and package', async () => {
    fixture.user = ADMIN;
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await route('POST', '/api/plugins/host-plugin/call/no_such_tool', { args: {} })).status);
    expect(statuses).toContain(429);
  });

  test('disabled: no page, no files, no calls; an upgrade asks for the scopes again', async () => {
    const svc = await import('./service');
    await svc.setEnabled(NAME, false, ADMIN.id);
    fixture.user = MEMBER;
    expect((await route('GET', '/api/plugin-ui')).body.pages).toEqual([]);
    expect((await route('GET', '/api/plugin-ui/host-plugin/index.html', undefined, { 'sec-fetch-dest': 'iframe' })).status).toBe(404);
    expect((await route('POST', '/api/plugins/host-plugin/call/whoami', { args: {} })).status).toBe(404);

    const next = mkdtempSync(join(tmpdir(), 'host-plugin-next-'));
    cpSync(FIXTURE_DIR, next, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(next, 'octipus-plugin.json'), 'utf8'));
    writeFileSync(join(next, 'octipus-plugin.json'), JSON.stringify({ ...manifest, version: '1.1.0', host: [...manifest.host, 'tasks:read'] }));
    await svc.installFromDirectory(next, ADMIN.id, { upgrade: true });
    // Any upgrade clears the approval: its tools' effects may have changed (read → write widens a call's token).
    expect((await svc.packageView(NAME)).approvedHostScopes).toBeNull();
    await expect(svc.setEnabled(NAME, true, ADMIN.id)).rejects.toMatchObject({ code: 'incomplete', message: expect.stringContaining('tasks:read') });
    await svc.configure(NAME, { approveHostScopes: [...ALL_SCOPES, 'tasks:read'], enabled: true }, ADMIN.id);
    expect((await route('GET', '/api/plugin-ui')).body.pages).toHaveLength(1);
  });
});
