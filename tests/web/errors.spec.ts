import { stubKnowledge } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test.describe('error handling', () => {
  test('500 on models page does not crash the shell', async ({ authenticatedPage: page }) => {
    await page.route('**/api/models', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server"}' }),
    );
    await page.goto('/models');
    await page.waitForLoadState('networkidle');
    // Shell chrome still renders — the sidebar's Octipus logo is present.
    await expect(page.getByRole('img', { name: 'Octipus' }).first()).toBeVisible();
  });

  test('503 on KB shows readiness banner', async ({ authenticatedPage: page }) => {
    await stubKnowledge(page, { ready: false });
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText(/initializing|not ready|preparing|unavailable|503/i, {
      timeout: 10_000,
    });
  });

  test('network failure on sessions does not crash chat', async ({ authenticatedPage: page }) => {
    await page.route('**/api/sessions', (route) => route.abort('failed'));
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
  });
});

test('a missing lazy page shows recovery and reload keeps the requested URL', async ({ authenticatedPage: page }) => {
  await page.route('**/assets/page-*.js', route => route.abort('failed'));
  await page.goto('/settings?section=general');
  await expect(page.getByRole('heading', { name: 'This page could not be loaded' })).toBeVisible();
  await expect(page.getByText('Unexpected Application Error!', { exact: true })).toHaveCount(0);
  await page.unroute('**/assets/page-*.js');
  await page.getByRole('button', { name: 'Reload page' }).click();
  await expect(page).toHaveURL(/\/settings\?section=general$/);
  await expect(page.getByRole('heading', { name: 'This page could not be loaded' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Octipus' }).first()).toBeVisible();
});
