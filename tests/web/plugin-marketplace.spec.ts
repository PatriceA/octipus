import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import { HASH, perms, items, preview, PREVIEW_ID, tickAll } from './fixtures/plugin-consent';
import { diffPermissions } from '../../src/shared/plugin-permissions';
import { permissionsAskSummary } from '../../src/shared/plugin-permissions';

/**
 * Admin → Plugins → Marketplace, Updates and the consent, every /api call stubbed:
 *   - search (instant, case and accents folded, `?q=`), categories, sorting,
 *     the cards and their badges, which registry each comes from;
 *   - the detail renders the README with its HTML, `javascript:` links and
 *     remote images neutralised, listed screenshots through the proxy only;
 *   - the consent: Install stays disabled until every item is ticked, and
 *     sends the preview, the content hash and every id;
 *   - an upgrade from Updates carries the unchanged items and marks the
 *     changed ones; a revocation is cleared only with a reason;
 *   - usage and cancelling a run, for an admin and in a user's settings;
 *   - the unconfigured state, and readable contrast in both themes.
 *
 * Screenshots go to $PLUGIN_PACKAGE_SHOTS when set.
 */

const SHOTS = process.env.PLUGIN_PACKAGE_SHOTS;
const ORIGIN = 'https://plugins.octipus.cc';
const proxy = (url: string) => `/api/plugin-packages/marketplace/asset?url=${encodeURIComponent(url)}`;
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const README = [
  '# Weekly review',
  '',
  'Looks back on your week.',
  '',
  '<script>window.__pwned = 1</script>',
  '<img src="https://evil.example.com/track.png" onerror="window.__pwned = 2">',
  '',
  '[click me](javascript:window.__pwned=3)',
  '',
  '[the docs](https://docs.example.com/weekly) and [plain http](http://insecure.example.com/x)',
  '',
  '![remote pixel](https://evil.example.com/pixel.png)',
  '',
  `![board](${ORIGIN}/weekly/shot.png)`,
].join('\n');

const weeklyPerms = perms('weekly', {
  host: ['tasks:read'],
  tools: [{ name: 'review', effect: 'read' }, { name: 'sync', effect: 'write' }],
  contributions: { commands: [], schedules: [{ id: 'nightly', cron: '15 2 * * *', tool: 'sync' }], events: [], prompt: null, context: null },
});

function card(over: Record<string, unknown> = {}) {
  return {
    registry: 'marketplace', name: 'weekly', title: 'Weekly review', summary: 'Looks back on the week', description: '', category: 'productivity',
    tags: ['review', 'tasks'], author: { name: 'Zoë Müller', url: 'https://zoe.example.com' }, homepage: 'https://weekly.example.com', license: 'MIT',
    publisher: 'Octipus', icon: proxy(`${ORIGIN}/weekly/icon.png`), screenshots: [proxy(`${ORIGIN}/weekly/shot.png`)], readme: README, changelog: '## 1.1.0\n\n- Faster',
    latest: '1.1.0',
    versions: [
      { version: '1.1.0', publishedAt: '2026-11-05T00:00:00Z', sha256: 'a', contentHash: HASH, apiVersion: '1.0.0', minOctipus: null, compatibility: { ok: true, reason: null }, revoked: null },
      { version: '1.0.0', publishedAt: '2026-10-01T00:00:00Z', sha256: 'b', contentHash: HASH, apiVersion: '1.0.0', minOctipus: null, compatibility: { ok: true, reason: null }, revoked: 'a bug' },
    ],
    permissions: weeklyPerms, askSummary: permissionsAskSummary(weeklyPerms), declarations: items(weeklyPerms), warnings: [],
    compatibility: { ok: true, reason: null }, installedVersion: null, installedOrigin: null, updateAvailable: null, revoked: null, deprecated: null, downloads: 120,
    ...over,
  };
}

const LISTING = {
  state: 'ready', message: null, generatedAt: '2026-11-10T00:00:00Z', categories: ['finance', 'productivity'], errors: [{ registry: 'Down', error: 'answered HTTP 503' }],
  plugins: [
    card(),
    card({ name: 'cafe', title: 'Café hours', summary: 'Opening times', category: 'productivity', tags: ['food'], author: { name: 'Ana', url: null }, downloads: 900, icon: null, screenshots: [], readme: null,
      versions: [{ ...card().versions[0], publishedAt: '2026-11-09T00:00:00Z' }], installedVersion: '0.9.0', updateAvailable: '1.1.0', installedOrigin: { source: 'marketplace' } }),
    card({ name: 'ledger', title: 'Ledger', summary: 'Book‮keeping', category: 'finance', tags: [], downloads: 5, icon: null, latest: null, compatibility: { ok: false, reason: 'Needs Octipus 9.0.0 or newer (this is 0.6.0)' } }),
    card({ registry: 'Acme', name: 'acme-crm', title: 'Acme CRM', summary: 'Contacts from Acme', publisher: 'Octipus', category: null, tags: [], downloads: null, icon: null }),
  ],
};

interface Calls { method: string; path: string; body: unknown }

async function stubPlugins(page: Page, opts: { listing?: unknown; handle?: (req: Calls) => [number, unknown] | undefined } = {}): Promise<Calls[]> {
  const calls: Calls[] = [];
  await stubAllDefaults(page);
  await page.route(/\/api\/plugin-packages(\/.*)?(\?.*)?$/, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const call = { method: req.method(), path: url.pathname.replace('/api/plugin-packages', '') || '/', body: req.postData() ? req.postDataJSON() : undefined };
    calls.push(call);
    if (call.path === '/marketplace/asset') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    const custom = opts.handle?.(call);
    if (custom) return json(route, custom[0], custom[1]);
    if (call.path === '/marketplace') return json(route, 200, opts.listing ?? LISTING);
    if (call.path === '/bundled' || call.path === '/updates' || call.path === '/revocations') return json(route, 200, []);
    if (call.method === 'GET' && call.path === '/') return json(route, 200, []);
    return json(route, 404, { error: 'unexpected' });
  });
  return calls;
}

const cards = (page: Page) => page.getByTestId('marketplace-card');

test.describe('plugin marketplace', () => {
  test('search folds case and accents, categories and sorting narrow and order the cards, and each says where it is from', async ({ authenticatedPage: page }) => {
    await stubPlugins(page);
    await page.goto('/admin/plugins/marketplace?q=CAFE');
    await expect(page.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('aria-current', 'page');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toHaveAttribute('data-name', 'cafe');
    const search = page.getByRole('searchbox', { name: 'Search plugins' });
    await search.fill('zoe');
    await expect(cards(page)).toHaveCount(3);
    await search.fill('');
    await expect(cards(page)).toHaveCount(4);

    const weekly = page.locator('[data-testid="marketplace-card"][data-name="weekly"]');
    await expect(weekly).toContainText('Weekly review');
    await expect(weekly).toContainText('Zoë Müller · productivity · 1.1.0');
    await expect(weekly.getByTestId('marketplace-downloads')).toHaveText(/120 downloads/);
    await expect(weekly.getByTestId('marketplace-asks')).toContainText('What it asks for: Reads your tasks; No network access');
    await expect(weekly.getByTestId('marketplace-registry')).toHaveText('Octipus marketplace');
    // A third-party registry calling itself "Octipus" is still labelled by its registry.
    await expect(page.locator('[data-testid="marketplace-card"][data-name="acme-crm"]').getByTestId('marketplace-registry')).toHaveText('Registry: Acme');
    await expect(page.locator('[data-testid="marketplace-card"][data-name="cafe"]').getByTestId('marketplace-badges')).toContainText('update 1.1.0');
    const ledger = page.locator('[data-testid="marketplace-card"][data-name="ledger"]');
    await expect(ledger.getByTestId('marketplace-badges')).toContainText('incompatible');
    // A bidirectional override in a summary is not shown.
    await expect(ledger).toContainText('Bookkeeping');
    await expect(page.getByText('Registry: Down: answered HTTP 503')).toBeVisible();

    await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'finance' }).click();
    await expect(cards(page)).toHaveCount(1);
    await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'All' }).click();
    await page.getByLabel('Sort by').selectOption('downloads');
    await expect(cards(page).first()).toHaveAttribute('data-name', 'cafe');
    await page.getByLabel('Sort by').selectOption('name');
    await expect(cards(page).first()).toHaveAttribute('data-name', 'acme-crm');
    await page.getByLabel('Sort by').selectOption('newest');
    await expect(cards(page).first()).toHaveAttribute('data-name', 'cafe');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/marketplace.png`, fullPage: true });
  });

  test('the detail renders the README safely: no HTML, no javascript: links, no remote images; listed screenshots through the proxy', async ({ authenticatedPage: page }) => {
    const calls = await stubPlugins(page);
    await page.goto('/admin/plugins/marketplace');
    await page.getByRole('button', { name: 'Weekly review: details' }).click();
    const detail = page.getByRole('dialog', { name: 'Weekly review' });
    await expect(detail.getByTestId('detail-registry')).toHaveText('Octipus marketplace');
    const readme = detail.getByTestId('detail-readme');
    await expect(readme.getByRole('heading', { name: 'Weekly review' })).toBeVisible();
    await expect(readme.locator('script')).toHaveCount(0);
    // The README's one listed image renders, from the proxy URL the host returned; the remote ones never load.
    await expect(readme.locator('img')).toHaveCount(1);
    await expect(readme.locator('img')).toHaveAttribute('src', /^blob:/);
    await expect(readme).toContainText('[image: remote pixel]');
    // javascript: and http: links are text; the https one opens in a new tab without opener or referrer.
    await expect(readme.getByRole('link', { name: 'click me' })).toHaveCount(0);
    await expect(readme.getByRole('link', { name: 'plain http' })).toHaveCount(0);
    const docs = readme.getByRole('link', { name: 'the docs' });
    await expect(docs).toHaveAttribute('href', 'https://docs.example.com/weekly');
    await expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(docs).toHaveAttribute('target', '_blank');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // No request ever named a URL the listing did not return as an asset.
    const assets = calls.filter((c) => c.path === '/marketplace/asset');
    expect(assets.length).toBeGreaterThan(0);
    await expect(detail.getByRole('link', { name: /weekly\.example\.com/ })).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(detail.getByTestId('detail-changelog')).toContainText('Faster');
    await expect(detail.getByTestId('detail-versions')).toContainText('revoked: a bug');
    await expect(detail.getByTestId('detail-screenshots').locator('img')).toHaveCount(1);
    await expect(detail).toContainText('MIT');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/marketplace-detail.png`, fullPage: false });
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
  });

  test('installing asks for every item: Install stays disabled until each is ticked, then sends the preview, hash and ids', async ({ authenticatedPage: page }) => {
    const p = preview(weeklyPerms, { title: 'Weekly review', guidance: [{ code: 'signature', message: 'Signed by a key this host does not know' }] });
    const calls = await stubPlugins(page, {
      handle: (c) => {
        if (c.path === '/preview') return [200, p];
        if (c.path === '/install') return [200, { name: 'weekly', version: '1.0.0', contentHash: HASH, enabled: true, enableProblem: null, warnings: [] }];
        return undefined;
      },
    });
    await page.goto('/admin/plugins/marketplace');
    await page.getByRole('button', { name: 'Weekly review: details' }).click();
    await page.getByRole('dialog', { name: 'Weekly review' }).getByRole('button', { name: 'Install' }).click();
    const consent = page.getByTestId('plugin-consent');
    await expect(consent.getByRole('heading', { level: 2 })).toHaveText('Install Weekly review');
    expect(calls.find((c) => c.path === '/preview')?.body).toEqual({ registry: 'marketplace', name: 'weekly', version: '1.1.0' });
    const install = consent.getByRole('button', { name: 'Install', exact: true });
    const rows = consent.getByTestId('consent-item');
    await expect(rows).toHaveCount(p.declarations.length);
    await expect(consent.getByTestId('consent-content-hash')).toHaveText(HASH);
    await expect(consent.locator('[data-id="schedule:nightly"]')).toContainText('15 2 * * * UTC → sync');
    await expect(consent.locator('[data-id="schedule:nightly"]').getByTestId('consent-guidance')).toContainText('Runs unattended');
    await expect(consent.getByTestId('consent-notes')).toContainText('Signed by a key this host does not know');
    await expect(install).toBeDisabled();
    // Each label ticks its own checkbox; all but one is not enough.
    const ids = p.declarations.map((d) => d.id);
    for (const id of ids.slice(0, -1)) await consent.locator(`[data-id="${id}"] input`).check();
    await expect(consent.getByTestId('consent-progress')).toHaveText(`${ids.length - 1} of ${ids.length} agreed`);
    await expect(install).toBeDisabled();
    await consent.locator(`[data-id="${ids.at(-1)}"] label`).click();
    await expect(install).toBeEnabled();
    await consent.getByLabel('Enable after install').check();
    await expect(install).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/marketplace-consent.png` });
    await install.click();
    await expect(page.getByTestId('marketplace-message')).toContainText('weekly 1.0.0 is installed and enabled');
    expect(calls.find((c) => c.path === '/install')?.body).toEqual({ previewId: PREVIEW_ID, contentHash: HASH, accepted: ids, enable: true });
  });

  test('a refused install says why and installs nothing', async ({ authenticatedPage: page }) => {
    await stubPlugins(page, {
      handle: (c) => (c.path === '/preview' ? [400, { error: 'The listing of weekly 1.1.0 does not state what the package asks for; not installed' }] : undefined),
    });
    await page.goto('/admin/plugins/marketplace');
    await page.getByRole('button', { name: 'Weekly review: details' }).click();
    await page.getByRole('dialog', { name: 'Weekly review' }).getByRole('button', { name: 'Install' }).click();
    const consent = page.getByTestId('plugin-consent');
    await expect(consent.getByRole('alert')).toContainText('does not state what the package asks for');
    await expect(consent.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  });

  test('an unconfigured build says so', async ({ authenticatedPage: page }) => {
    await stubPlugins(page, { listing: { state: 'unconfigured', message: 'The Octipus marketplace is not configured in this build', generatedAt: null, plugins: [], categories: [], errors: [] } });
    await page.goto('/admin/plugins/marketplace');
    await expect(page.getByTestId('marketplace-state')).toHaveText('The Octipus marketplace is not configured in this build.');
    await expect(page.getByTestId('marketplace-empty')).toHaveText('No plugins listed.');
  });

  test('the old Browse page opens the Marketplace', async ({ authenticatedPage: page }) => {
    await stubPlugins(page);
    await page.goto('/admin/plugins/browse');
    await expect(page).toHaveURL(/\/admin\/plugins\/marketplace$/);
    await expect(cards(page)).toHaveCount(4);
  });

  test('an upgrade from Updates shows the diff, carries the unchanged items and marks what changed', async ({ authenticatedPage: page }) => {
    const before = weeklyPerms;
    const after = perms('weekly', { ...weeklyPerms, version: '1.1.0', host: ['notes:write', 'tasks:read'], contributions: { ...weeklyPerms.contributions, schedules: [{ id: 'nightly', cron: '* * * * *', tool: 'sync' }] } });
    const diff = diffPermissions(before, after);
    const upgrade = preview(after, { title: 'Weekly review', version: '1.1.0', upgradeFrom: '1.0.0', diff, declarations: items(after, null, before) });
    let revocations = [{
      id: '55555555-5555-4555-8555-555555555555', kind: 'package', name: 'cafe', version: '0.9.0', keyId: null, reason: 'leaks notes', registryUrl: `${ORIGIN}/index.json`,
      signedByKey: 'ed25519:x', indexGeneratedAt: '2026-11-09T00:00:00Z', firstSeenAt: '2026-11-09T00:00:00Z', clearedAt: null as string | null, clearedBy: null, clearReason: null as string | null,
    }];
    const calls = await stubPlugins(page, {
      handle: (c) => {
        if (c.path === '/updates') return [200, [{ name: 'weekly', installed: '1.0.0', latest: '1.1.0', registry: 'marketplace', diff, warnings: [] }]];
        if (c.path === '/revocations') return [200, revocations];
        if (c.method === 'DELETE' && c.path.startsWith('/revocations/')) {
          revocations = revocations.map((r) => ({ ...r, clearedAt: '2026-11-10T00:00:00Z', clearReason: (c.body as { reason: string }).reason }));
          return [200, { cleared: true }];
        }
        if (c.path === '/preview') return [200, upgrade];
        if (c.path === '/install') return [200, { name: 'weekly', version: '1.1.0', contentHash: HASH, enabled: false, enableProblem: null, warnings: [] }];
        return undefined;
      },
    });
    await page.goto('/admin/plugins/updates');
    const row = page.locator('[data-testid="plugin-update"][data-name="weekly"]');
    await expect(row).toContainText('1.0.0 → 1.1.0 · Octipus marketplace');
    await expect(row.locator('[data-widens="true"]')).toHaveCount(diff.changes.filter((c) => c.widens).length);
    await expect(row).toContainText('schedule nightly: cron 15 2 * * * → * * * * * (UTC)');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/marketplace-updates.png`, fullPage: true });

    await row.getByRole('button', { name: 'Upgrade weekly to 1.1.0' }).click();
    const consent = page.getByTestId('plugin-consent');
    await expect(consent.getByRole('heading', { level: 2 })).toHaveText('Upgrade Weekly review');
    await expect(consent.getByTestId('consent-diff')).toContainText('asks for more');
    const carried = consent.locator('[data-testid="consent-item"][data-carried="true"]');
    await expect(carried.first()).toBeVisible();
    for (const box of await carried.locator('input').all()) {
      await expect(box).toBeChecked();
      await expect(box).toBeDisabled();
    }
    await expect(consent.locator('[data-id="host:notes:write"]')).toContainText('new');
    await expect(consent.locator('[data-id="schedule:nightly"]')).toContainText('changed');
    await expect(consent.locator('[data-id="schedule:nightly"]')).toHaveAttribute('data-status', 'changed');
    const upgradeButton = consent.getByRole('button', { name: 'Upgrade', exact: true });
    await expect(upgradeButton).toBeDisabled();
    await tickAll(consent);
    await expect(upgradeButton).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/marketplace-upgrade-consent.png` });
    await upgradeButton.click();
    await expect(page.getByTestId('updates-message')).toContainText('weekly is now 1.1.0, disabled');
    expect((calls.find((c) => c.path === '/install')?.body as { accepted: string[] }).accepted.sort()).toEqual(['host:notes:write', 'schedule:nightly']);

    // A revocation is cleared only with a reason.
    const revocation = page.getByTestId('plugin-revocation');
    await revocation.getByRole('button', { name: 'Clear the revocation of cafe' }).click();
    const submit = revocation.getByRole('button', { name: 'Clear revocation' });
    await expect(submit).toBeDisabled();
    await revocation.getByLabel('Why clear it? (kept in the audit log)').fill('fixed upstream');
    await submit.click();
    await expect(revocation).toContainText('cleared: fixed upstream');
    expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ path: `/revocations/${revocations[0].id}`, body: { reason: 'fixed upstream' } });
  });

  test('the installed tab shows origin, revocation, usage, and cancels a running run', async ({ authenticatedPage: page }) => {
    const pkg = {
      name: 'research', version: '1.0.0',
      manifest: { name: 'research', version: '1.0.0', apiVersion: '1.0.0', title: 'Research', description: 'Background research', server: { command: 'node', args: ['s.mjs'] }, tools: { start: { effect: 'write' } }, host: ['agent:run'] },
      enabled: true, settings: {}, secretsSet: [], problem: null, connected: true,
      network: { state: 'restricted', detail: 'Only the Octipus host API.' }, contentHash: HASH, actualHash: null, signedBy: 'Octipus', runtime: 'package', inProcess: null,
      signature: { status: 'valid', keyId: 'ed25519:x', publisher: 'Octipus', detail: 'Signed by Octipus' }, approvedHostScopes: ['agent:run'],
      origin: { source: 'marketplace', registry: 'Octipus' }, revocation: { kind: 'package', keyId: null, reason: 'leaks notes', source: 'marketplace', since: '2026-11-09T00:00:00Z' },
      installedBy: 'e2e-user-id', installedAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z',
    };
    let runs = [{ id: '66666666-6666-4666-8666-666666666666', userId: 'u-1', startedAt: '2026-11-10T08:00:00Z', role: 'research', title: 'Market sizes' }];
    const calls = await stubPlugins(page, {
      handle: (c) => {
        if (c.method === 'GET' && c.path === '/') return [200, [pkg]];
        if (c.path === '/research/usage') return [200, { name: 'research', days: 30, since: '2026-10-11T00:00:00Z', scope: 'all', modelCalls: 4, runs: 2, inputTokens: 1000, outputTokens: 234, cost: 0.42, byUser: [{ userId: 'u-1', modelCalls: 4, runs: 2, tokens: 1234, cost: 0.42 }] }];
        if (c.path === '/research/runs' && c.method === 'GET') return [200, runs];
        if (c.method === 'DELETE' && c.path.startsWith('/research/runs/')) { runs = []; return [200, { id: c.path.split('/').pop(), status: 'cancelled' }]; }
        return undefined;
      },
    });
    await page.goto('/admin/plugins');
    const row = page.locator('[data-testid="plugin-package"][data-name="research"]');
    await expect(row.getByTestId('plugin-origin')).toHaveText('From the Octipus marketplace');
    await expect(row.getByTestId('plugin-revocation-banner')).toContainText('revoked by the Octipus marketplace: leaks notes');
    await row.getByRole('button', { name: 'Usage of research' }).click();
    const usage = row.getByRole('group', { name: 'Usage of research' });
    await expect(usage.getByTestId('plugin-usage-tokens')).toHaveText('1,234');
    await expect(usage.getByTestId('plugin-usage-cost')).toHaveText('$0.42');
    await expect(usage.getByTestId('plugin-usage-by-user')).toContainText('u-1');
    await usage.getByRole('button', { name: 'Cancel the run Market sizes' }).click();
    await expect(usage).toContainText('None running.');
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`/research/runs/${'66666666-6666-4666-8666-666666666666'}`);
  });

  test('a user sees their own plugin usage in settings and cancels their own run', async ({ authenticatedPage: page }) => {
    let runs = [{ id: '77777777-7777-4777-8777-777777777777', userId: 'e2e-user-id', startedAt: '2026-11-10T08:00:00Z', role: 'research', title: 'Competitors' }];
    const calls = await stubPlugins(page, {
      handle: (c) => {
        if (c.path === '/my-usage') return [200, [{ name: 'research', title: 'Research', usage: { name: 'research', days: 30, since: '', scope: 'me', modelCalls: 1, runs: 1, inputTokens: 10, outputTokens: 5, cost: 0.01 }, runs }]];
        if (c.method === 'DELETE') { runs = []; return [200, { id: 'x', status: 'cancelled' }]; }
        return undefined;
      },
    });
    await page.goto('/settings?tab=plugin-usage');
    const item = page.locator('[data-testid="my-plugin"][data-name="research"]');
    await expect(item.getByTestId('my-plugin-totals')).toHaveText('15 tokens · $0.01 · 1 model calls · 1 runs');
    await item.getByRole('button', { name: 'Cancel the run Competitors' }).click();
    await expect(item.getByTestId('my-plugin-run')).toHaveCount(0);
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/research/runs/77777777-7777-4777-8777-777777777777');
  });

  for (const theme of ['light', 'dark']) {
    test(`${theme}: the marketplace and the consent have readable contrast`, async ({ authenticatedPage: page }) => {
      await page.addInitScript((t) => localStorage.setItem('octipus-theme', t), theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await stubPlugins(page, { handle: (c) => (c.path === '/preview' ? [200, preview(weeklyPerms, { title: 'Weekly review' })] : undefined) });
      await page.goto('/admin/plugins/marketplace');
      await expect(cards(page)).toHaveCount(4);
      const check = async (include: string) => {
        const result = await new AxeBuilder({ page }).include(include).withRules(['color-contrast']).analyze();
        expect(result.violations, JSON.stringify(result.violations.map((v) => ({ help: v.help, nodes: v.nodes.map((n) => n.target) })))).toEqual([]);
      };
      await check('[data-testid="admin-plugin-marketplace"]');
      await page.getByRole('button', { name: 'Weekly review: details' }).click();
      await page.getByRole('dialog', { name: 'Weekly review' }).getByRole('button', { name: 'Install' }).click();
      await expect(page.getByTestId('consent-item').first()).toBeVisible();
      await check('[data-testid="plugin-consent"]');
    });
  }
});
