import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures/auth';

for (const theme of ['light', 'dark']) {
  test(`${theme} theme persists across navigation and sign-in with readable settings`, async ({ authenticatedPage: page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/settings?tab=appearance');
    await page.getByLabel('Color theme').selectOption(theme);
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
    await page.reload();
    await expect(page.getByLabel('Color theme')).toHaveValue(theme);
    for (const path of ['/settings', '/settings?tab=integrations', '/login']) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
      await expect(page.locator('body')).toHaveCSS('color', theme === 'dark' ? 'rgb(224, 233, 237)' : 'rgb(32, 50, 61)');
      if (path === '/login') await expect(page.getByPlaceholder('alice')).toBeVisible();
      else await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      const result = await new AxeBuilder({ page }).include(path === '/login' ? 'body' : 'main').withRules(['color-contrast']).analyze();
      expect(result.violations, JSON.stringify(result.violations.map(v => ({ help: v.help, nodes: v.nodes.map(n => n.target) })))).toEqual([]);
    }
  });
}

test('device theme tracks system changes and top-bar switch overrides it', async ({ authenticatedPage: page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/settings?tab=appearance');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.getByLabel('Color theme')).toHaveValue('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/dark/);
});
