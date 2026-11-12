/**
 * Dashboards (docs/PLUGIN-PACKAGES.md#dashboards), end to end: the dashboard
 * fixture package installed, enabled and run as a real child process speaking
 * MCP; the app's routes over HTTP, as the web app calls them.
 *
 * What must hold:
 * - the sidebar lists an enabled package's dashboards, and a disabled one's not;
 * - the layout names the widgets, never their tools or input;
 * - a widget's data is its read tool's answer for the manifest's fixed input,
 *   called as the signed-in user (with a host token, as a page's call), and
 *   nothing the browser sends reaches the tool;
 * - what does not fit the widget's type, a link to a host the package does
 *   not declare, a failing tool are refused, and markup stays text;
 * - only signed-in users from this site; another package's, an unknown or a
 *   write tool's widget is not found; requests are rate-limited.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-dash-ws-'));

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

const FIXTURE_DIR = join(__dirname, 'fixtures', 'dash-plugin');
const NAME = 'dash-plugin';
const SERVER = `plugin-${NAME}`;
let app: import('@/api/http').App;

async function route(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const widget = (id: string, body: unknown = {}) => route('POST', `/api/plugins/${NAME}/dashboards/overview/widgets/${id}`, body);

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-dash-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${ADMIN.id}', 'admin', true), ('${MEMBER.id}', 'member', false) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { App } = await import('@/api/http');
  const { pluginCallRoutes, pluginUiRoutes } = await import('@/api/routes/plugin-ui');
  app = new App({ prefix: '/api' }).use(pluginUiRoutes).use(pluginCallRoutes);
  const svc = await import('./service');
  await svc.installFromDirectory(FIXTURE_DIR, ADMIN.id);
  await svc.configure(NAME, { approveHostScopes: ['store:read'], enabled: true }, ADMIN.id);
});

afterAll(async () => {
  const { getMCPBridge } = await import('@/mcp/bridge');
  await getMCPBridge().disconnect(SERVER);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('dashboards', () => {
  test('the sidebar lists them; the layout names the widgets, never their tools or input', async () => {
    fixture.user = null;
    expect((await route('GET', '/api/plugin-ui')).status).toBe(401);
    expect((await route('GET', `/api/plugins/${NAME}/dashboards/overview`)).status).toBe(401);
    fixture.user = MEMBER;
    const ui = await route('GET', '/api/plugin-ui');
    expect(ui.body.dashboards).toEqual([{ plugin: NAME, pluginTitle: 'Dashboards (test fixture)', id: 'overview', title: 'Billing overview', icon: 'layout-dashboard' }]);
    const view = await route('GET', `/api/plugins/${NAME}/dashboards/overview`);
    expect(view.status).toBe(200);
    expect(view.body.widgets[1]).toEqual({ id: 'invoices', type: 'table', title: 'Invoices', width: 2, refreshSeconds: 300 });
    expect(JSON.stringify(view.body)).not.toContain('"tool"');
    expect(JSON.stringify(view.body)).not.toContain('kind');
    expect((await route('GET', `/api/plugins/${NAME}/dashboards/nope`)).status).toBe(404);
  });

  test('a widget shows its read tool\'s answer for the manifest\'s input, checked against its type', async () => {
    fixture.user = MEMBER;
    const stat = await widget('open');
    expect(stat.status).toBe(200);
    expect(stat.body.data).toEqual({ type: 'stat', value: 42, label: 'open', unit: 'EUR', tone: 'warn', delta: -3, updatedAt: '2026-11-12T08:00:00Z' });
    const table = await widget('invoices');
    expect(table.body.data.rows[0]).toEqual({ values: { no: 'R-1', amount: 120.5 }, link: { url: 'https://billing.example.com/r/1' } });
    // Structured content works as well as JSON text.
    expect((await widget('trend')).body.data).toMatchObject({ type: 'chart', kind: 'bar', x: 'month' });
    // Markup is text: the app draws it as text.
    expect((await widget('markup')).body.data.text).toBe('<script>alert(1)</script> & <b>bold</b>');
    // Nothing the browser sends reaches the tool: the manifest's input does.
    expect((await widget('open', { args: { kind: 'markup' }, input: { kind: 'markup' } })).body.data.type).toBe('stat');
  });

  test('what does not fit is refused, and so is a link to a host the package does not declare', async () => {
    fixture.user = MEMBER;
    for (const [id, pattern] of [
      ['leak', /link goes to a host the plugin does not declare/],
      ['broken', /not JSON/],
      ['mismatch', /returned list data for a stat widget/],
      ['failing', /tool failed: upstream API down/],
    ] as const) {
      const res = await widget(id);
      expect(res.status, id).toBe(422);
      expect(res.body.code, id).toBe('widget_invalid');
      expect(res.body.error, id).toMatch(pattern);
    }
  });

  test('a widget\'s call is the signed-in user\'s, with a host token as a page\'s call', async () => {
    fixture.user = MEMBER;
    expect((await widget('token')).body.data.text).toBe('token for store:read');
  });

  test('only from this site, only declared widgets', async () => {
    fixture.user = null;
    expect((await widget('open')).status).toBe(401);
    fixture.user = MEMBER;
    expect((await route('POST', `/api/plugins/${NAME}/dashboards/overview/widgets/open`, {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await widget('nope')).status).toBe(404);
    expect((await route('POST', '/api/plugins/other/dashboards/overview/widgets/open', {})).status).toBe(404);
  });

  test('rate-limited per user and package', async () => {
    fixture.user = ADMIN;
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await widget('nope')).status);
    expect(statuses).toContain(429);
  });

  test('a disabled package offers no dashboard', async () => {
    const svc = await import('./service');
    await svc.setEnabled(NAME, false, ADMIN.id);
    fixture.user = MEMBER;
    expect((await route('GET', '/api/plugin-ui')).body.dashboards).toEqual([]);
    expect((await route('GET', `/api/plugins/${NAME}/dashboards/overview`)).status).toBe(404);
    expect((await route('POST', `/api/plugins/${NAME}/dashboards/overview/widgets/open`, {})).status).toBe(404);
  });
});
