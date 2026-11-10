import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

/**
 * Admin → Plugin packages, every /api call stubbed:
 *   - a package whose files changed shows the recorded and the actual hash;
 *     "Approve this content" sends exactly the actual hash shown, and a 409
 *     (changed again since) is shown as a message;
 *   - the network state reads plainly, `refused` included, and a revoked key
 *     shows on the signature;
 *   - settings are edited by the manifest's fields; secrets are write-only and
 *     the value is gone from the page's heap once saved; uninstall asks first;
 *   - Browse lists the registries' packages and installs one with its URL
 *     and sha256.
 *
 * Screenshots go to $PLUGIN_PACKAGE_SHOTS when set.
 */

const SHOTS = process.env.PLUGIN_PACKAGE_SHOTS;
/** Distinctive, so a heap snapshot match cannot be anything else. */
const SECRET_VALUE = 'zq7Kv41-plugin-secret-Wx9';

/** Whether the page's JavaScript heap holds `needle` (a snapshot, which collects garbage first). */
async function heapContains(page: Page, needle: string): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  const chunks: string[] = [];
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e: { chunk: string }) => { chunks.push(e.chunk); });
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await cdp.detach();
  return chunks.join('').includes(needle);
}
const RECORDED = `sha256:${'a'.repeat(64)}`;
const ACTUAL = `sha256:${'b'.repeat(64)}`;
const MISMATCH = 'Modified since it was approved (hash mismatch); approve its content to run it';

const pkg = (over: Record<string, unknown>) => ({
  name: 'finapi', version: '1.0.0',
  manifest: {
    name: 'finapi', version: '1.0.0', apiVersion: '1.0.0', title: 'finAPI bank accounts', description: 'Balances',
    server: { command: 'node', args: ['server.js'] }, tools: { list_accounts: { effect: 'read' } }, network: ['api.finapi.io'],
  },
  enabled: true, settings: {}, secretsSet: [], problem: null, connected: true,
  network: { state: 'restricted', detail: 'Only api.finapi.io: the sandbox (bwrap) has no direct network.' },
  contentHash: RECORDED, actualHash: null, signedBy: 'Acme',
  signature: { status: 'valid', keyId: `ed25519:${'c'.repeat(64)}`, publisher: 'Acme', detail: 'Signed by Acme' },
  installedBy: 'e2e-user-id', installedAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z',
  ...over,
});

test.describe('plugin packages', () => {
  test('approving changed content sends the hash shown, and a later change is refused with a message', async ({ authenticatedPage: page }) => {
    let packages = [
      pkg({ problem: MISMATCH, connected: false, actualHash: ACTUAL, signedBy: null, signature: { status: 'invalid', keyId: null, publisher: null, detail: 'The signature by Acme does not match the package content' } }),
      pkg({
        name: 'datev', manifest: { ...pkg({}).manifest, name: 'datev', title: 'DATEV', network: [] },
        enabled: false, connected: false,
        network: { state: 'refused', detail: 'Not started: security.shellSandbox is required and no sandbox can wrap the server here.' },
        signedBy: null, signature: { status: 'revoked', keyId: `ed25519:${'d'.repeat(64)}`, publisher: 'Old Acme', detail: 'Signed, but the key of Old Acme is revoked' },
      }),
    ];
    const patches: unknown[] = [];
    let refuseNext = false;
    await stubAllDefaults(page);
    await page.route(/\/api\/plugin-packages(\/.*)?$/, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'GET') return json(route, 200, packages);
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON() as { approveContent?: string };
        patches.push(body);
        if (refuseNext) {
          return json(route, 409, { error: `The files of finapi hash to sha256:${'e'.repeat(64)}, not to the reviewed ${body.approveContent}: they changed since they were reviewed; review them again` });
        }
        packages = packages.map((p) => (p.name === 'finapi' ? { ...p, contentHash: body.approveContent, actualHash: null, problem: null, connected: true } : p));
        return json(route, 200, packages[0]);
      }
      return json(route, 404, { error: 'unexpected' });
    });

    await page.goto('/admin/plugins');
    await expect(page.getByRole('link', { name: 'Plugin packages' })).toBeVisible();
    const finapi = page.locator('[data-testid="plugin-package"][data-name="finapi"]');
    const review = finapi.getByRole('group', { name: 'Content review for finapi' });
    await expect(review.getByTestId('recorded-hash')).toHaveText(RECORDED);
    await expect(review.getByTestId('actual-hash')).toHaveText(ACTUAL);
    await expect(finapi.getByTestId('plugin-problem')).toContainText('hash mismatch');
    await expect(finapi.getByTestId('plugin-network')).toHaveText('network restricted');

    const datev = page.locator('[data-testid="plugin-package"][data-name="datev"]');
    await expect(datev.getByTestId('plugin-network')).toHaveText('refused: sandbox required');
    await expect(datev.getByTestId('plugin-network-detail')).toContainText('security.shellSandbox is required');
    await expect(datev.getByTestId('plugin-signature')).toHaveText('key revoked · Old Acme');
    await expect(datev.getByRole('group')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-plugin-packages.png`, fullPage: true });

    // The files changed again after the page read them: the server refuses, and the page says so.
    refuseNext = true;
    page.once('dialog', (d) => d.accept());
    await review.getByRole('button', { name: 'Approve this content' }).click();
    await expect(review.getByRole('alert')).toContainText('they changed since they were reviewed');
    expect(patches).toEqual([{ approveContent: ACTUAL }]);

    // Approved as shown: the review goes away.
    refuseNext = false;
    page.once('dialog', (d) => d.accept());
    await review.getByRole('button', { name: 'Approve this content' }).click();
    await expect(finapi.getByRole('group', { name: 'Content review for finapi' })).toHaveCount(0);
    await expect(finapi.getByTestId('plugin-problem')).toHaveCount(0);
    expect(patches).toEqual([{ approveContent: ACTUAL }, { approveContent: ACTUAL }]);
  });

  test('settings are edited by the manifest fields, secrets are write-only, and uninstall asks first', async ({ authenticatedPage: page }) => {
    const manifest = {
      ...pkg({}).manifest,
      settings: [
        { key: 'region', label: 'Region', type: 'select', options: ['eu', 'us'], required: true },
        { key: 'limit', label: 'Page size', type: 'number' },
        { key: 'sandbox', label: 'Use the sandbox API', type: 'boolean' },
      ],
      secrets: [
        { key: 'FINAPI_CLIENT_ID', label: 'Client id', required: true },
        { key: 'FINAPI_CLIENT_SECRET', label: 'Client secret', required: true, help: 'From the finAPI console' },
      ],
    };
    let packages = [pkg({ manifest, settings: { region: 'eu', limit: 50 }, secretsSet: ['FINAPI_CLIENT_ID'] })];
    const writes: Array<{ method: string; url: string; body: unknown }> = [];
    let refuseSettings = true;
    let refuseDelete = true;
    await stubAllDefaults(page);
    await page.route(/\/api\/plugin-packages(\/.*)?$/, async (route: Route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'GET') return json(route, 200, packages);
      const body = req.postData() ? req.postDataJSON() : undefined;
      writes.push({ method: req.method(), url: path, body });
      if (req.method() === 'PATCH') {
        if (refuseSettings) {
          refuseSettings = false;
          return json(route, 400, { error: 'The settings do not fit the package', problems: ['Page size: must be a number'] });
        }
        const settings = { ...(body as { settings: Record<string, unknown> }).settings };
        for (const [k, v] of Object.entries(settings)) if (v === null) delete settings[k];
        packages = [{ ...packages[0], settings: settings as Record<string, string> }];
        return json(route, 200, packages[0]);
      }
      if (req.method() === 'PUT') {
        const key = decodeURIComponent(path.split('/').pop() as string);
        const { value } = body as { value: string | null };
        const set = new Set(packages[0].secretsSet as string[]);
        if (value === null) set.delete(key);
        else set.add(key);
        packages = [{ ...packages[0], secretsSet: [...set] }];
        return json(route, 200, { saved: true });
      }
      if (req.method() === 'DELETE') {
        if (refuseDelete) {
          refuseDelete = false;
          return json(route, 500, { error: 'The plugin package could not be changed' });
        }
        packages = [];
        return json(route, 200, { uninstalled: true });
      }
      return json(route, 404, { error: 'unexpected' });
    });

    await page.goto('/admin/plugins');
    const finapi = page.locator('[data-testid="plugin-package"][data-name="finapi"]');
    await finapi.getByRole('button', { name: 'Configure finapi' }).click();
    const config = finapi.getByRole('group', { name: 'Configure finapi' });

    // Settings, typed by the manifest: a select, a number and a checkbox, filled with what is stored.
    const settings = config.getByRole('form', { name: 'Settings of finapi' });
    await expect(settings.getByLabel('Region *')).toHaveValue('eu');
    await expect(settings.getByLabel('Page size')).toHaveValue('50');
    await expect(settings.getByLabel('Use the sandbox API')).not.toBeChecked();
    await settings.getByLabel('Region *').selectOption('us');
    await settings.getByLabel('Page size').fill('');
    await settings.getByLabel('Use the sandbox API').check();
    // The first save is refused: every problem the API gives is shown.
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(settings.getByRole('alert')).toHaveText('! Page size: must be a number');
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(settings.getByRole('status')).toHaveText('Settings saved.');
    expect(writes.filter((w) => w.method === 'PATCH').map((w) => w.body)).toEqual([
      { settings: { region: 'us', limit: null, sandbox: true } },
      { settings: { region: 'us', limit: null, sandbox: true } },
    ]);

    // Secrets: set or not, never a value; the field is write-only and empties once saved.
    const id = config.locator('[data-testid="plugin-secret"][data-key="FINAPI_CLIENT_ID"]');
    const secret = config.locator('[data-testid="plugin-secret"][data-key="FINAPI_CLIENT_SECRET"]');
    await expect(id.getByTestId('plugin-secret-state')).toHaveText('set');
    await expect(secret.getByTestId('plugin-secret-state')).toHaveText('not set');
    await expect(secret.getByLabel(/Client secret/)).toHaveAttribute('type', 'password');
    await expect(id.getByLabel(/Client id/)).toHaveValue('');
    await expect(secret.getByRole('button', { name: 'Clear' })).toHaveCount(0);
    // Typed key by key, so the page's JavaScript heap only ever sees the whole
    // value where the page itself put it together.
    await secret.getByLabel(/Client secret/).pressSequentially(SECRET_VALUE);
    await secret.getByRole('button', { name: 'Set' }).click();
    await expect(secret.getByRole('status')).toHaveText('Client secret saved.');
    await expect(secret.getByTestId('plugin-secret-state')).toHaveText('set');
    await expect(secret.getByLabel(/Client secret/)).toHaveValue('');
    // Once saved, nothing in the page holds the value: not React state, not
    // react-query's mutation cache (the variable is only 'set', and the
    // mutation is reset with gcTime 0). A heap snapshot (taken after a GC) must not contain it.
    expect(await heapContains(page, SECRET_VALUE)).toBe(false);
    await expect(page.getByText(SECRET_VALUE)).toHaveCount(0);
    // Clearing asks first.
    page.once('dialog', (d) => d.accept());
    await id.getByRole('button', { name: 'Clear' }).click();
    await expect(id.getByTestId('plugin-secret-state')).toHaveText('not set');
    expect(writes.filter((w) => w.method === 'PUT')).toEqual([
      { method: 'PUT', url: '/api/plugin-packages/finapi/secrets/FINAPI_CLIENT_SECRET', body: { value: SECRET_VALUE } },
      { method: 'PUT', url: '/api/plugin-packages/finapi/secrets/FINAPI_CLIENT_ID', body: { value: null } },
    ]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-plugin-configure.png`, fullPage: true });

    // Uninstall: dismissing the confirmation sends nothing; a refusal is shown; then it goes.
    page.once('dialog', (d) => d.dismiss());
    await finapi.getByRole('button', { name: 'Uninstall finapi' }).click();
    expect(writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    page.once('dialog', (d) => { expect(d.message()).toContain('Uninstall finapi?'); void d.accept(); });
    await finapi.getByRole('button', { name: 'Uninstall finapi' }).click();
    await expect(finapi.getByRole('alert').last()).toHaveText('! The plugin package could not be changed');
    page.once('dialog', (d) => d.accept());
    await finapi.getByRole('button', { name: 'Uninstall finapi' }).click();
    await expect(page.getByText('no plugin packages installed')).toBeVisible();
    expect(writes.filter((w) => w.method === 'DELETE')).toEqual([
      { method: 'DELETE', url: '/api/plugin-packages/finapi', body: undefined },
      { method: 'DELETE', url: '/api/plugin-packages/finapi', body: undefined },
    ]);
  });

  test('browse lists the registries and installs a package with its URL and sha256', async ({ authenticatedPage: page }) => {
    const posts: unknown[] = [];
    const sha = `sha256:${'f'.repeat(64)}`;
    await stubAllDefaults(page);
    await page.route('**/api/plugin-packages/registry', (route) => json(route, 200, {
      packages: [
        { registry: 'Acme', name: 'datev', version: '2.0.0', description: 'DATEV bookings', url: 'https://plugins.example.com/datev-2.0.0.tar.gz', sha256: sha, installedVersion: null },
        { registry: 'Acme', name: 'finapi', version: '1.0.0', description: 'Bank accounts', url: 'https://plugins.example.com/finapi-1.0.0.tar.gz', sha256: sha, installedVersion: '1.0.0' },
      ],
      errors: [{ registry: 'Down', error: 'https://down.example.com/index.json answered HTTP 503' }],
    }));
    await page.route(/\/api\/plugin-packages$/, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        posts.push(req.postDataJSON());
        return json(route, 200, { name: 'datev', version: '2.0.0', enabled: false, signedBy: 'Acme', warnings: [] });
      }
      return json(route, 200, []);
    });

    await page.goto('/admin/plugins/browse');
    await expect(page.getByText('Down: https://down.example.com/index.json answered HTTP 503')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upgrade finapi 1.0.0' })).toBeDisabled();
    await page.getByRole('button', { name: 'Install datev 2.0.0' }).click();
    await expect(page.getByText('Installed datev 2.0.0, signed by Acme')).toBeVisible();
    expect(posts).toEqual([{ url: 'https://plugins.example.com/datev-2.0.0.tar.gz', sha256: sha, name: 'datev', version: '2.0.0' }]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-plugin-browse.png`, fullPage: true });
  });
});
