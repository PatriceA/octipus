/**
 * The bundled Reader plugin end to end (docs/PLUGIN-PACKAGES.md#bundled-plugins,
 * docs/plans/plugins-everything.md phase 3): installed from the repository's
 * plugins/ directory, approved and enabled like any package, its real server
 * spawned over stdio, calling back into a real host API listener through its
 * egress proxy. The web is a stub behind the host's guarded fetcher and the
 * model a stub behind the model client: no real network.
 *
 * What must hold:
 * - the bundled list offers it; installing it pins its content and leaves it
 *   disabled, and enabling needs its four host scopes approved;
 * - read_url and reader_action work through `web:read` and `model:complete`,
 *   audited; a URL the SSRF guard refuses is refused;
 * - save_note and create_tasks write in the calling user's own data, for that
 *   user only, tasks filed under Reading and linked to the article;
 * - the page lists, and its bridge reads as the signed-in user, while saving
 *   needs the user's confirmation.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { RunningServer } from '@/api/http';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL = 'fatal';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-bundled-ws-'));

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', username: 'admin', isAdmin: true };
const MEMBER = { id: '22222222-2222-4222-8222-222222222222', username: 'member', isAdmin: false };

const fixture = vi.hoisted(() => ({
  user: null as null | { id: string; username: string; isAdmin: boolean },
  fetched: [] as string[],
  completions: [] as Array<{ messages: Array<{ role: string; content: string }>; userId?: string }>,
}));

vi.mock('@/api/context', async () => {
  const { principalFromUser } = await import('@/security/principal');
  return {
    apiContext: new (await import('@/api/http')).App().derive(() => ({
      user: fixture.user,
      principal: fixture.user ? principalFromUser(fixture.user) : { kind: 'anonymous' },
    })),
  };
});

const ARTICLE_HTML = `<!doctype html><html><head><title>Plan for the week</title>
<meta property="og:site_name" content="Example News"><meta name="author" content="Ada Lovelace"></head>
<body><nav>menu</nav><article><h1>Plan for the week</h1>
<p>This week we should buy milk for the office kitchen and call Bob about the quarterly report before Friday.</p>
<p>Everything else can wait until the next planning meeting, which is on Monday morning at nine.</p>
<script>alert(1)</script></article></body></html>`;

// The web: the guarded fetcher answers the article for public hosts; anything
// else goes to the real guard (which refuses a private address without any I/O).
vi.mock('@/utils/sanitize', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/sanitize')>();
  return {
    ...real,
    fetchGuarded: async (url: string, init?: RequestInit) => {
      if (!/^https:\/\/news\.example\.com\//.test(url)) return real.fetchGuarded(url, init);
      fixture.fetched.push(url);
      return new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
});
// The model: the user's everyday lane, answering a bullet list.
vi.mock('@/models/resolve-model', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/models/resolve-model')>(),
  resolveModel: async () => ({ name: 'everyday-test', modelId: 'test/model' }),
}));
vi.mock('@/models/litellm-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/models/litellm-client')>(),
  getLiteLLMClient: () => ({
    complete: async (req: (typeof fixture.completions)[number]) => {
      fixture.completions.push(req);
      return { content: '- Buy milk for the kitchen\n- Call Bob about the report' };
    },
  }),
}));

const NAME = 'reader';
const SERVER = `plugin-${NAME}`;
const SCOPES = ['web:read', 'model:complete', 'notes:write', 'tasks:write'];
const ARTICLE_URL = 'https://news.example.com/plan';

let server: RunningServer;
let app: import('@/api/http').App;

/** The user's own agent, in their conversation: the kind of agent call that gets a host token. */
function agentContext(userId = ADMIN.id): AgentContext {
  return {
    id: `agent-${rand(4)}`, userId, sessionId: `sess-${rand(4)}`, role: 'general', status: 'running', attended: true,
    workspaceId: null, space: null, trigger: 'user', metadata: {},
  } as unknown as AgentContext;
}

/** A tool result: its JSON (or text) and whether it is an error. */
function parsed(result: unknown): { isError: boolean; value: any } {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0].text;
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* plain text */ }
  return { isError: r.isError === true, value };
}

async function callAs(tool: string, args: Record<string, unknown>, userId = ADMIN.id) {
  const { getMCPBridge } = await import('@/mcp/bridge');
  return parsed(await getMCPBridge().callTool(SERVER, tool, args, agentContext(userId)));
}

/** A write tool, run as if the user approved it (a dispatch receipt). */
async function callApproved(tool: string, args: Record<string, unknown>, userId = ADMIN.id) {
  const { getMCPBridge } = await import('@/mcp/bridge');
  const { withDispatchAuthorization } = await import('@/security/dispatch-authorization');
  const context = agentContext(userId);
  const authArgs = { server_id: SERVER, tool_name: tool, arguments: args };
  return parsed(await withDispatchAuthorization(context, 'mcp', `${SERVER}.${tool}`, authArgs, 'approval:test',
    () => getMCPBridge().callTool(SERVER, tool, args, context, authArgs)));
}

async function route(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: value };
}

async function rows(sql: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-bundled-'));
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
  app = new App({ prefix: '/api' }).use(pluginPackageRoutes).use(pluginUiRoutes).use(pluginCallRoutes).use(pluginHostRoutes);
  server = listen(app, { hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => setTimeout(r, 50));
  const { setHostApiPort } = await import('./host-api');
  setHostApiPort(server.port);
});

afterAll(async () => {
  const { getMCPBridge } = await import('@/mcp/bridge');
  await getMCPBridge().disconnect(SERVER);
  server?.stop(true);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('installing the bundled reader', () => {
  test('it is offered, installs pinned and disabled, and enables only with its scopes approved', async () => {
    fixture.user = ADMIN;
    const listed = await route('GET', '/api/plugin-packages/bundled');
    expect(listed.status).toBe(200);
    expect(listed.body).toContainEqual(expect.objectContaining({ name: NAME, title: 'Reader', host: SCOPES, network: [], installed: null }));

    const installed = await route('POST', '/api/plugin-packages', { bundled: NAME });
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ name: NAME, enabled: false, contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect((await route('POST', '/api/plugin-packages', { bundled: 'no-such-plugin' })).status).toBe(404);

    // Not without its scopes, not with part of them.
    expect(await route('PATCH', `/api/plugin-packages/${NAME}`, { enabled: true })).toMatchObject({ status: 409, body: { error: expect.stringContaining('web:read') } });
    expect((await route('PATCH', `/api/plugin-packages/${NAME}`, { enabled: true, approveHostScopes: ['web:read'] })).status).toBe(409);
    const enabled = await route('PATCH', `/api/plugin-packages/${NAME}`, { enabled: true, approveHostScopes: SCOPES });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ enabled: true, approvedHostScopes: SCOPES, connected: true });

    expect((await route('GET', '/api/plugin-packages/bundled')).body).toContainEqual(expect.objectContaining({ name: NAME, installed: '1.0.0' }));
    const audit = await rows(`SELECT details FROM audit_log WHERE resource_type = 'plugin_package' AND resource_id = $1`, [NAME]);
    const details = audit.map((r) => (typeof r.details === 'string' ? JSON.parse(r.details) : r.details));
    expect(details).toContainEqual(expect.objectContaining({ op: 'installed', source: 'bundled:reader' }));
    expect(details.map((d) => d.op)).toContain('host_scopes_approved');
  });
});

describe('the reader tools', () => {
  test('read_url: the host fetches and cleans the page; the plugin never reaches the web itself', async () => {
    const out = await callAs('read_url', { url: ARTICLE_URL });
    expect(out.isError).toBe(false);
    expect(out.value).toMatchObject({ url: ARTICLE_URL, title: 'Plan for the week', siteName: 'Example News' });
    expect(out.value.text).toContain('buy milk for the office kitchen');
    expect(out.value.text).not.toContain('alert(1)');
    expect(fixture.fetched).toEqual([ARTICLE_URL]);
    const withHtml = await callAs('read_url', { url: ARTICLE_URL, includeHtml: true });
    expect(withHtml.value.contentHtml).toContain('<p>');
    expect(withHtml.value.contentHtml).not.toContain('<script');
  });

  test('a URL the SSRF guard refuses is refused without saying why, and audited by host and hash', async () => {
    const out = await callAs('read_url', { url: 'http://10.0.0.1/admin?secret=1' });
    expect(out).toEqual({ isError: true, value: 'This address may not be fetched' });
    const audit = await rows(`SELECT action, details FROM audit_log WHERE resource_type = 'plugin_host' ORDER BY created_at`);
    const reads = audit.map((r) => ({ action: r.action, ...(typeof r.details === 'string' ? JSON.parse(r.details) : r.details) })).filter((d) => d.op === 'web.read');
    const { createHash } = await import('node:crypto');
    expect(reads.at(-1)).toMatchObject({
      status: 422, scope: 'web:read', tool: 'read_url', code: 'blocked',
      host: '10.0.0.1', urlSha256: createHash('sha256').update('http://10.0.0.1/admin?secret=1').digest('hex'),
    });
    expect(JSON.stringify(reads.at(-1))).not.toContain('secret=1');
    expect(reads.filter((d) => d.status === 200).length).toBeGreaterThanOrEqual(2);
  });

  test('reader_action: one completion on the user\'s everyday model, the article framed as data', async () => {
    fixture.completions.length = 0;
    const out = await callAs('reader_action', { action: 'action_items', url: ARTICLE_URL });
    expect(out).toMatchObject({ isError: false, value: { action: 'action_items', items: ['Buy milk for the kitchen', 'Call Bob about the report'] } });
    expect(fixture.completions).toHaveLength(1);
    expect(fixture.completions[0].userId).toBe(ADMIN.id);
    expect(fixture.completions[0].messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('untrusted web content') });
    expect(fixture.completions[0].messages[1].content).toContain('<article_content>');
  });

  test('a user whose rules deny the web fetch gets no web:read', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    await getPermissionManager().setPermission(MEMBER.id, 'websearch', 'fetch', 'DENY');
    try {
      expect(await callAs('read_url', { url: ARTICLE_URL }, MEMBER.id)).toMatchObject({ isError: true, value: expect.stringContaining('web:read') });
    } finally {
      await getPermissionManager().setPermission(MEMBER.id, 'websearch', 'fetch', 'ALLOW');
    }
  });

  test('save_note and create_tasks write for the calling user only', async () => {
    const note = await callApproved('save_note', { title: 'Plan for the week', body: 'Buy milk.', url: ARTICLE_URL });
    expect(note).toMatchObject({ isError: false, value: { saved: true, title: 'Plan for the week' } });
    const again = await callApproved('save_note', { title: 'Plan for the week', body: 'Again.' });
    expect(again.value.title).toBe('Plan for the week (2)');

    const tasks = await callApproved('create_tasks', { items: ['Buy milk for the kitchen', 'Call Bob about the report', 'buy milk  for the kitchen'], url: ARTICLE_URL, title: 'Plan for the week' });
    expect(tasks).toMatchObject({ isError: false, value: { created: 2 } });

    const notes = await rows(`SELECT user_id, title, body FROM notes WHERE title LIKE 'Plan for the week%' ORDER BY title`);
    expect(notes.map((n) => [n.user_id, n.title])).toEqual([[ADMIN.id, 'Plan for the week'], [ADMIN.id, 'Plan for the week (2)']]);
    expect(notes[0].body).toContain(`Source: ${ARTICLE_URL}`);
    const made = await rows(`SELECT user_id, title, category, source, source_ref, notes FROM tasks WHERE title IN ('Buy milk for the kitchen', 'Call Bob about the report') ORDER BY title`);
    expect(made).toHaveLength(2);
    for (const t of made) {
      expect(t).toMatchObject({ user_id: ADMIN.id, category: 'Reading', source: 'agent', notes: `From: Plan for the week — ${ARTICLE_URL}` });
      const ref = typeof t.source_ref === 'string' ? JSON.parse(t.source_ref) : t.source_ref;
      expect(ref).toEqual({ plugin: NAME, tool: 'create_tasks', url: ARTICLE_URL, label: 'Plan for the week' });
    }
    // The member has none of it.
    expect(await rows(`SELECT id FROM notes WHERE user_id = $1`, [MEMBER.id])).toEqual([]);
    expect(await rows(`SELECT id FROM tasks WHERE user_id = $1`, [MEMBER.id])).toEqual([]);
  });

  test('a read tool cannot write: its token carries no write scope', async () => {
    // reader_action is a read tool: its call is handed web:read and model:complete only.
    const { issueHostCallMeta } = await import('./host-api');
    const { serverFor } = await import('./service');
    const { getDb } = await import('@/db/postgres');
    const { pluginPackages } = await import('@/db/schema/plugin-packages');
    const { eq } = await import('drizzle-orm');
    const [row] = await getDb().select().from(pluginPackages).where(eq(pluginPackages.name, NAME));
    const srv = await serverFor(row);
    expect(srv.plugin?.maxProtection).toBe(1);
    const read = await issueHostCallMeta(srv, 'reader_action', agentContext());
    expect((read?.meta['octipus/host'] as { scopes: string[] }).scopes).toEqual(['web:read', 'model:complete']);
    read?.release();
    const write = await issueHostCallMeta(srv, 'create_tasks', agentContext());
    expect((write?.meta['octipus/host'] as { scopes: string[] }).scopes).toEqual(SCOPES);
    write?.release();
  });
});

describe('the reader page', () => {
  test('it is in the sidebar, reads through the bridge as the signed-in user, and saves only once confirmed', async () => {
    fixture.user = MEMBER;
    const pages = await route('GET', '/api/plugin-ui');
    expect(pages.body.pages).toContainEqual({ plugin: NAME, pluginTitle: 'Reader', path: 'read', title: 'Reader', icon: 'newspaper', src: '/api/plugin-ui/reader/index.html' });
    // Served as the frame's script (what a browser says it fetches), and nothing outside ui/.
    expect((await route('GET', '/api/plugin-ui/reader/app.js', undefined, { 'sec-fetch-dest': 'script' })).status).toBe(200);
    expect((await route('GET', '/api/plugin-ui/reader/server.mjs', undefined, { 'sec-fetch-dest': 'script' })).status).toBe(404);

    const read = await route('POST', `/api/plugins/${NAME}/call/read_url`, { args: { url: ARTICLE_URL, includeHtml: true } });
    expect(read.status).toBe(200);
    expect(parsed(read.body.result).value.title).toBe('Plan for the week');

    const args = { items: ['Read the article again'], url: ARTICLE_URL, title: 'Plan for the week' };
    expect(await route('POST', `/api/plugins/${NAME}/call/create_tasks`, { args })).toMatchObject({ status: 409, body: { code: 'approval_required', effect: 'write' } });
    expect(await rows(`SELECT id FROM tasks WHERE user_id = $1`, [MEMBER.id])).toEqual([]);
    const confirmed = await route('POST', `/api/plugins/${NAME}/call/create_tasks`, { args, confirm: true });
    expect(confirmed.status).toBe(200);
    expect(parsed(confirmed.body.result).value).toMatchObject({ created: 1 });
    expect((await rows(`SELECT user_id, title FROM tasks WHERE user_id = $1`, [MEMBER.id]))).toEqual([{ user_id: MEMBER.id, title: 'Read the article again' }]);
    // The admin's list did not grow.
    expect(await rows(`SELECT id FROM tasks WHERE user_id = $1 AND title = 'Read the article again'`, [ADMIN.id])).toEqual([]);
  });
});

describe('the bundled name', () => {
  test('another package holding a bundled name shows as taken and is not upgraded into the bundle', async () => {
    const { isBundledName, listBundled, installBundled } = await import('./bundled');
    expect(isBundledName('reader')).toBe(true);
    expect(isBundledName('host-plugin')).toBe(false);
    expect(isBundledName(join('..', NAME))).toBe(false);
    const svc = await import('./service');
    await svc.uninstall(NAME, ADMIN.id);
    // A package of someone else's, named "reader", installed from a directory.
    const { cpSync, readFileSync, writeFileSync } = await import('node:fs');
    const squat = mkdtempSync(join(tmpdir(), 'squat-reader-'));
    cpSync(join(__dirname, 'fixtures', 'echo-plugin'), squat, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(squat, 'octipus-plugin.json'), 'utf8'));
    writeFileSync(join(squat, 'octipus-plugin.json'), JSON.stringify({ ...manifest, name: 'reader' }));
    await svc.installFromDirectory(squat, ADMIN.id);
    expect((await listBundled()).find((b) => b.name === NAME)).toMatchObject({ installed: null, taken: true });
    await expect(installBundled(NAME, ADMIN.id, { upgrade: true })).rejects.toMatchObject({ code: 'conflict' });
    // Once it is gone, the bundle installs and is listed as installed.
    await svc.uninstall(NAME, ADMIN.id);
    await installBundled(NAME, ADMIN.id);
    const listed = (await listBundled()).find((b) => b.name === NAME);
    expect(listed).toMatchObject({ installed: '1.0.0' });
    expect(listed?.taken).toBeUndefined();
  });
});

describe('only the plugins Octipus ships are bundled', () => {
  test('another directory under <install>/plugins is not listed, installable as bundled, or a shipped name', async () => {
    const { cpSync, readFileSync, writeFileSync } = await import('node:fs');
    const { installBundled, isBundledName, listBundled, setBundledRoot, SHIPPED_PLUGINS } = await import('./bundled');
    expect(SHIPPED_PLUGINS).toEqual(['reader']);
    const root = mkdtempSync(join(tmpdir(), 'octipus-install-plugins-'));
    cpSync(join(__dirname, '..', '..', '..', 'plugins', 'reader'), join(root, 'reader'), { recursive: true });
    // A plugin someone made and dropped into the install's plugins/: a valid package.
    cpSync(join(__dirname, 'fixtures', 'echo-plugin'), join(root, 'my-local'), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(root, 'my-local', 'octipus-plugin.json'), 'utf8'));
    writeFileSync(join(root, 'my-local', 'octipus-plugin.json'), JSON.stringify({ ...manifest, name: 'my-local' }));
    setBundledRoot(root);
    try {
      expect((await listBundled()).map((b) => b.name)).toEqual(['reader']);
      expect(isBundledName('my-local')).toBe(false);
      expect(isBundledName('reader')).toBe(true);
      await expect(installBundled('my-local', ADMIN.id)).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      setBundledRoot(null);
    }
  });
});
