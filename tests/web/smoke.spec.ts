import { expect, expectNoConsoleErrors, test } from './fixtures/auth';

test.describe('smoke — page load + nav', () => {
  test('landing / dashboard renders', async ({ authenticatedPage: page, consoleErrors }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/Assistant/);
    await expect(page.getByText('Assistant', { exact: true }).first()).toBeVisible();
    expectNoConsoleErrors(consoleErrors);
  });

  test('nav link: chat', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await Promise.all([page.waitForURL(/\/chat/), page.getByRole('link', { name: /chat/i }).first().click()]);
  });

  test('nav link: models', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await Promise.all([page.waitForURL(/\/models/), page.getByRole('link', { name: /models/i }).first().click()]);
  });

  test('nav link: knowledge', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await Promise.all([
      page.waitForURL(/\/knowledge/),
      page.getByRole('link', { name: /knowledge/i }).first().click(),
    ]);
  });

  test('nav link: skills', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await Promise.all([page.waitForURL(/\/skills/), page.getByRole('link', { name: /^skills/i }).first().click()]);
  });

  test('nav link: settings', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await Promise.all([
      page.waitForURL(/\/settings/),
      page.getByRole('link', { name: /settings/i }).first().click(),
    ]);
  });

  test('direct route: /mcp loads', async ({ authenticatedPage: page, consoleErrors }) => {
    await page.goto('/mcp');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/mcp/);
    expectNoConsoleErrors(consoleErrors);
  });

  test('direct route: /pipelines loads', async ({ authenticatedPage: page, consoleErrors }) => {
    await page.goto('/pipelines');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/pipelines/);
    expectNoConsoleErrors(consoleErrors);
  });
});
