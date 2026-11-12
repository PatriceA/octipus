import AxeBuilder from '@axe-core/playwright';
import { expect, test, STUB_USER } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

for (const theme of ['light', 'dark']) {
  test(`Administration is a distinct workspace with readable ${theme} styling`, async ({ authenticatedPage: page }) => {
    await page.addInitScript(theme => localStorage.setItem('octipus-theme', theme), theme);
    await page.route('**/api/admin/users', route => json(route, 200, { users: [
      { id: STUB_USER.id, username: 'Operator', email: 'operator@example.test', isAdmin: true, isActive: true, installModels: true, totpEnabled: true, createdAt: '2026-11-01T12:00:00Z', lastLoginAt: null },
      { id: 'alex', username: 'Alex', email: 'alex@example.test', isAdmin: false, isActive: true, installModels: false, totpEnabled: false, createdAt: '2026-11-01T12:00:00Z', lastLoginAt: null },
    ] }));
    await page.goto('/');
    await expect(page.locator('.app-sidebar').getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.locator('.settings-groups').getByRole('link', { name: 'Administration', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
    for (const group of ['People & access', 'Connections & extensions', 'Usage & oversight']) {
      await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible();
    }
    const anchor = page.locator('.settings-nav-anchor');
    await expect(anchor).toHaveClass(/nav-selected/);
    const nav = page.getByRole('navigation', { name: 'Administration sections' });
    await nav.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(nav.getByRole('link', { name: 'Users', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(anchor).toHaveClass(/nav-selected/);
    await expect.poll(() => page.locator('tbody tr').last().evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    const font = await page.locator('.admin-workspace').evaluate(el => getComputedStyle(el).fontFamily);
    expect(font).not.toMatch(/mono/i);
    const axe = await new AxeBuilder({ page }).include('.admin-workspace').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations).toEqual([]);
    await nav.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'People & access', exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/octipus-administration-${theme}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await nav.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.locator('tbody tr').last().evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    await page.screenshot({ path: `/tmp/octipus-admin-users-mobile-${theme}.png`, fullPage: true });
  });
}

test('Settings search leads to Administration and nested sections keep their identity', async ({ authenticatedPage: page }) => {
  await page.goto('/settings');
  await page.getByRole('searchbox', { name: 'Find a setting' }).fill('users');
  await page.locator('.settings-groups').getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto('/admin/orgs/sso');
  await expect(page.getByRole('navigation', { name: 'Administration sections' }).getByRole('link', { name: 'Organizations', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.settings-nav-anchor')).toHaveClass(/nav-selected/);
});

test('non-admins have no Administration entry and cannot open its workspace', async ({ authenticatedPage: page }) => {
  await page.route('**/api/auth/me', route => json(route, 200, { ...STUB_USER, isAdmin: false }));
  const adminReads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/admin/')) adminReads.push(request.url()); });
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  expect(adminReads).toEqual([]);
  await page.goto('/settings');
  await expect(page.locator('.settings-groups').getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
});
