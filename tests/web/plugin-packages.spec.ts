import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

/**
 * Admin → Plugin packages, every /api call stubbed:
 *   - a package whose files changed shows the recorded and the actual hash;
 *     "Approve this content" sends exactly the actual hash shown, and a 409
 *     (changed again since) is shown as a message;
 *   - the network state reads plainly, `refused` included, and a revoked key
 *     shows on the signature;
 *   - Browse lists the registries' packages and installs one with its URL
 *     and sha256.
 *
 * Screenshots go to $PLUGIN_PACKAGE_SHOTS when set.
 */

const SHOTS = process.env.PLUGIN_PACKAGE_SHOTS;
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
    expect(posts).toEqual([{ url: 'https://plugins.example.com/datev-2.0.0.tar.gz', sha256: sha }]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-plugin-browse.png`, fullPage: true });
  });
});
