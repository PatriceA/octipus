import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

for (const theme of ['light', 'dark']) test(`${theme} connected accounts controls have readable contrast before and after hover`, async ({ authenticatedPage: page }) => {
  await page.addInitScript(theme => localStorage.setItem('octipus-theme', theme), theme);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/auth/oauth/google/status', route => json(route, 200, { provider: 'google', connected: true }));
  await page.route('**/api/auth/oauth/microsoft/status', route => json(route, 200, { provider: 'microsoft', connected: false }));
  await page.goto('/settings?tab=integrations');
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toBeVisible();
  for (const hover of [false, true]) {
    if (hover) await connect.hover();
    const result = await new AxeBuilder({ page }).include('main').withRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations.map(item => ({ help: item.help, nodes: item.nodes.map(node => node.target) })))).toEqual([]);
  }
  await page.screenshot({ path: `/tmp/octipus-connected-accounts-${theme}.png`, fullPage: true });
});
