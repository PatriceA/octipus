import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';
import { consentView, HASH, perms, tickAll } from './fixtures/plugin-consent';

/**
 * Plugin package pages (docs/PLUGIN-PACKAGES.md#pages), every /api call
 * stubbed; the page itself is the host fixture's real UI files, served with
 * the headers the server sends (a sandboxing CSP, path-restricted sources):
 *   - the page renders in its sandboxed frame, its script and stylesheet load
 *     from the package path, and the app's storage is out of its reach;
 *   - a bridge call reaches POST /api/plugins/<its name>/call/<tool> and the
 *     result comes back to the frame;
 *   - a call the server refuses (another package's tool) comes back refused,
 *     a message from anything but the page's frame is ignored, and an
 *     external tool runs only after the user allows it outside the frame;
 *   - the sidebar entry appears when the package is enabled and goes when it
 *     is disabled.
 */

const UI_DIR = join(import.meta.dirname, '..', '..', 'src', 'plugins', 'packages', 'fixtures', 'host-plugin', 'ui');
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

/** What src/plugins/packages/ui.ts sends with a file: the same CSP, for this origin. */
function csp(origin: string): string {
  const base = `${origin}/api/plugin-ui/host-plugin/`;
  return [
    "default-src 'none'", `script-src ${base}`, `style-src ${base}`, `img-src ${base} data:`, `font-src ${base}`, `media-src ${base}`,
    "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'",
    "frame-ancestors 'self'", 'sandbox allow-scripts',
  ].join('; ');
}

const PAGE = { plugin: 'host-plugin', pluginTitle: 'Host API (test fixture)', path: 'dashboard', title: 'Host dashboard', icon: 'layout-dashboard', src: '/api/plugin-ui/host-plugin/index.html' };

interface Stubs {
  calls: Array<{ url: string; body: { args?: unknown; confirm?: boolean } }>;
  /** The files the frame fetched. (Sec-Fetch-Dest is added below Playwright's interception, so it is checked in the route tests.) */
  dests: string[];
  enabled: boolean;
  /** What the fixture page does: the tool it calls, or a scenario (`data-tool` on its <body>). */
  tool: string;
  /** The entry URL the page listing gives (default: the fixture's). */
  src?: string;
  /** Each request URL of the entry, as the frame made it (query and fragment included where sent). */
  entries: string[];
}

async function stubPlugin(page: Page, stubs: Stubs): Promise<void> {
  await page.route(/\/api\/plugin-ui\/host-plugin\/[^?#]+/, (route: Route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.split('/').pop() ?? '';
    const ext = file.split('.').pop() ?? '';
    stubs.dests.push(file);
    if (!stubs.enabled || !TYPES[ext]) return route.fulfill({ status: 404, body: 'Not found' });
    let body = readFileSync(join(UI_DIR, file), 'utf8');
    if (file === 'index.html') {
      stubs.entries.push(route.request().url());
      // The scenario, on the first document only (a document navigated to does what a plain page does).
      if (!url.search) body = body.replace('<body>', `<body data-tool="${stubs.tool}">`);
    }
    return route.fulfill({
      status: 200,
      body,
      headers: { 'content-type': TYPES[ext], 'content-security-policy': csp(url.origin), 'x-content-type-options': 'nosniff' },
    });
  });
  await page.route(/\/api\/plugin-ui$/, (route) => json(route, 200, { pages: stubs.enabled ? [{ ...PAGE, src: stubs.src ?? PAGE.src }] : [] }));
  await page.route(/\/api\/plugins\/[^/]+\/call\/[^/]+$/, async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as Stubs['calls'][number]['body'];
    const path = new URL(req.url()).pathname;
    stubs.calls.push({ url: path, body });
    const tool = path.split('/').pop();
    if (tool === 'list_accounts') return json(route, 404, { error: 'host-plugin has no tool list_accounts', code: 'unknown_tool' });
    if (tool === 'send_letter' && body.confirm !== true) return json(route, 409, { error: 'send_letter needs your confirmation', code: 'approval_required', tool, effect: 'external' });
    return json(route, 200, { result: { content: [{ type: 'text', text: JSON.stringify({ tool, hello: 'from the host' }) }] } });
  });
}

const frameOf = (page: Page) => page.frameLocator('[data-testid="plugin-frame"]');

test.describe('plugin pages', () => {
  test('the page renders sandboxed, and a bridge call reaches its own package and comes back', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'whoami' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    const frame = frameOf(page);
    await expect(frame.locator('h1')).toHaveText('Host dashboard');
    await expect(frame.locator('#status')).toHaveText('ok');
    // The stylesheet loaded from the package path (CSP style-src).
    await expect(frame.locator('#status')).toHaveCSS('color', 'rgb(0, 128, 0)');
    // An opaque origin: no access to the app's storage.
    await expect(frame.locator('body')).toHaveAttribute('data-storage', 'blocked');
    expect(await page.locator('[data-testid="plugin-frame"]').getAttribute('sandbox')).toBe('allow-scripts');
    expect(stubs.calls).toEqual([{ url: '/api/plugins/host-plugin/call/whoami', body: { args: {} } }]);
    expect(stubs.dests.sort()).toEqual(['app.js', 'index.html', 'style.css']);
    const reply = JSON.parse(await frame.locator('#out').textContent() ?? '{}');
    expect(reply).toMatchObject({ octipus: 'result', id: 1, ok: true });
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ tool: 'whoami', hello: 'from the host' });
  });

  test('another package\'s tool is refused, and only the page\'s own frame is heard', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'list_accounts' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    await expect(frameOf(page).locator('#status')).toHaveText('refused: unknown_tool');
    // The request named its own package only.
    expect(stubs.calls.map((c) => c.url)).toEqual(['/api/plugins/host-plugin/call/list_accounts']);
    // Messages posted by the app window itself (not the frame) — a call, or a 'ready' with a port — call nothing.
    await page.evaluate(() => {
      window.postMessage({ octipus: 'call', id: 9, tool: 'whoami', args: {} }, window.location.origin);
      const channel = new MessageChannel();
      window.postMessage({ octipus: 'ready', nonce: 'guess' }, window.location.origin, [channel.port2]);
      channel.port1.postMessage({ octipus: 'call', id: 10, tool: 'whoami', args: {} });
    });
    await page.waitForTimeout(300);
    expect(stubs.calls).toHaveLength(1);
  });

  test('the frame gets its nonce and the app origin in the fragment, and calls go over the one port it handed over', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'ready-twice' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    await expect(frameOf(page).locator('#status')).toHaveText('ok');
    // A second 'ready' (another port) is ignored: its call is never answered nor sent.
    await expect(frameOf(page).locator('body')).toHaveAttribute('data-second-port', 'ignored');
    expect(stubs.calls).toHaveLength(1);
    const src = await page.locator('[data-testid="plugin-frame"]').getAttribute('src') ?? '';
    const fragment = new URLSearchParams(src.split('#')[1]);
    expect(fragment.get('octipus')).toMatch(/^[0-9a-f]{48}$/);
    expect(fragment.get('parent')).toBe(new URL(page.url()).origin);
    // The fragment never went over the network.
    expect(stubs.entries.every((u) => !u.includes('#') && !u.includes('octipus='))).toBe(true);
  });

  test('a page that navigates while still parsing never gets a port; the next document receives nothing', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'navigate-early' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    await expect.poll(() => stubs.entries.some((u) => u.includes('?early=1'))).toBe(true);
    // The document navigated to has no fragment: no nonce, no port, no calls.
    await expect(frameOf(page).locator('body')).toHaveAttribute('data-bridge', 'none');
    await page.waitForTimeout(300);
    expect(stubs.calls).toEqual([]);
  });

  test('the frame URL comes only from the listing, checked and encoded', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'whoami', src: '/api/plugin-ui/host-plugin/../../auth/me' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    await expect(page.getByTestId('plugin-page')).toBeVisible();
    await expect(page.locator('[data-testid="plugin-frame"]')).toHaveAttribute('src', 'about:blank');
    // An entry of another package is refused the same way.
    stubs.src = '/api/plugin-ui/other-plugin/index.html';
    await page.reload();
    await expect(page.locator('[data-testid="plugin-frame"]')).toHaveAttribute('src', 'about:blank');
    expect(stubs.entries).toEqual([]);
  });

  test('an external tool runs only after the user allows it in the app', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'send_letter' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    const dialog = page.getByTestId('plugin-confirm');
    await expect(dialog).toContainText('The plugin host-plugin (Host API (test fixture)) wants to run send_letter');
    await expect(dialog).toContainText('outside the organisation');
    await expect(frameOf(page).locator('#status')).toHaveText('script ran');
    // Allow arms only after a moment, so a click meant for the page cannot land on it.
    const allow = dialog.getByRole('button', { name: 'Allow once' });
    await expect(allow).toBeDisabled();
    await expect(allow).toBeEnabled();
    await allow.click();
    await expect(frameOf(page).locator('#status')).toHaveText('ok');
    expect(stubs.calls.map((c) => c.body)).toEqual([{ args: {} }, { args: {}, confirm: true }]);
  });

  test('a page that navigates its frame away loses the bridge and is closed', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'navigate' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    await expect(page.getByTestId('plugin-navigated')).toContainText("navigated away from host-plugin's own page");
    await expect(page.locator('[data-testid="plugin-frame"]')).toHaveAttribute('src', 'about:blank');
    // Only the page's own call went out; whatever is in the frame now calls nothing.
    await page.waitForTimeout(300);
    expect(stubs.calls.map((c) => c.url)).toEqual(['/api/plugins/host-plugin/call/whoami']);
  });

  test('refusing the confirmation answers the page and runs nothing', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: true, tool: 'send_letter' };
    await stubPlugin(page, stubs);
    await page.goto('/plugins/host-plugin/dashboard');
    await page.getByTestId('plugin-confirm').getByRole('button', { name: 'Refuse' }).click();
    await expect(frameOf(page).locator('#status')).toHaveText('refused: denied_by_user');
    expect(stubs.calls.map((c) => c.body)).toEqual([{ args: {} }]);
  });

  test('the sidebar entry appears with enabling and goes with disabling', async ({ authenticatedPage: page }) => {
    const stubs: Stubs = { calls: [], dests: [], entries: [], enabled: false, tool: 'whoami' };
    await stubPlugin(page, stubs);
    const patches: unknown[] = [];
    const view = () => [{
      name: 'host-plugin', version: '1.0.0',
      manifest: {
        name: 'host-plugin', version: '1.0.0', apiVersion: '1.0.0', title: 'Host API (test fixture)', description: 'Fixture',
        server: { command: 'node', args: ['server.mjs'] }, tools: { whoami: { effect: 'read' } },
        host: ['notes:read', 'notes:write'], ui: { pages: [{ path: 'dashboard', title: 'Host dashboard', entry: 'index.html' }] },
      },
      enabled: stubs.enabled, settings: {}, secretsSet: [], problem: null, connected: stubs.enabled,
      network: { state: 'restricted', detail: 'Only the Octipus host API.' },
      contentHash: `sha256:${'a'.repeat(64)}`, actualHash: null, signedBy: null,
      signature: { status: 'unsigned', keyId: null, publisher: null, detail: 'Not signed' },
      approvedHostScopes: stubs.enabled ? ['notes:read', 'notes:write'] : null,
      installedBy: null, installedAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z',
    }];
    await page.route(/\/api\/plugin-packages(\/.*)?$/, async (route) => {
      const req = route.request();
      if (req.method() === 'GET' && req.url().endsWith('/bundled')) return json(route, 200, []);
      if (req.method() === 'GET' && req.url().endsWith('/host-plugin/consent')) {
        return json(route, 200, consentView(perms('host-plugin', {
          host: ['notes:read', 'notes:write'], tools: [{ name: 'whoami', effect: 'read' }],
          pages: [{ path: 'dashboard', title: 'Host dashboard', entry: 'index.html' }], ui: { dir: 'ui', sha256: 'ab'.repeat(32) },
        })));
      }
      if (req.method() === 'GET') return json(route, 200, view());
      if (req.method() === 'POST' && req.url().endsWith('/host-plugin/consent')) {
        patches.push(req.postDataJSON());
        stubs.enabled = true;
        return json(route, 200, { name: 'host-plugin', version: '1.0.0', contentHash: HASH, enabled: true, enableProblem: null, warnings: [] });
      }
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON() as { enabled: boolean };
        patches.push(body);
        stubs.enabled = body.enabled;
        return json(route, 200, view()[0]);
      }
      return json(route, 404, {});
    });

    await page.goto('/admin/plugins');
    const row = page.locator('[data-testid="plugin-package"][data-name="host-plugin"]');
    await expect(row.getByTestId('plugin-pages')).toContainText('Host dashboard (/plugins/host-plugin/dashboard)');
    await expect(row.locator('[data-scope="notes:write"]')).toHaveAttribute('data-approved', 'false');
    await expect(page.locator('summary', { hasText: /^Plugins$/ })).toHaveCount(0);

    await row.getByRole('button', { name: 'Enable host-plugin' }).click();
    const consent = page.getByTestId('plugin-consent');
    await expect(consent.locator('[data-id="page:dashboard"]')).toContainText('Adds the page "Host dashboard"');
    await tickAll(consent);
    await consent.getByRole('button', { name: 'Agree and enable' }).click();
    await expect(page.locator('summary', { hasText: /^Plugins$/ })).toHaveCount(1);
    expect(patches).toEqual([{ contentHash: HASH, accepted: expect.arrayContaining(['host:notes:read', 'host:notes:write', 'page:dashboard']), enable: true }]);
    await expect(row.locator('[data-scope="notes:write"]')).toHaveAttribute('data-approved', 'true');
    await page.locator('summary', { hasText: /^Plugins$/ }).click();
    await page.getByRole('link', { name: 'Host dashboard' }).click();
    await expect(page).toHaveURL(/\/plugins\/host-plugin\/dashboard$/);
    await expect(frameOf(page).locator('#status')).toHaveText('ok');

    await page.goto('/admin/plugins');
    await row.getByRole('button', { name: 'Disable host-plugin' }).click();
    await expect(page.locator('summary', { hasText: /^Plugins$/ })).toHaveCount(0);
    expect(patches.at(-1)).toEqual({ enabled: false });
  });
});
