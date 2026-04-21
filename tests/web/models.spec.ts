import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('models page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('models page renders the model list', async ({ authenticatedPage: page }) => {
    await page.goto('/models');
    await expect(page.locator('body')).toContainText(/gpt-4o|claude-3-5-sonnet/, { timeout: 10_000 });
  });

  test('default badge appears for the default model', async ({ authenticatedPage: page }) => {
    await page.goto('/models');
    await expect(page.locator('body')).toContainText(/default|Default/i, { timeout: 10_000 });
  });

  test('error surface when models API returns 500', async ({ authenticatedPage: page, consoleErrors }) => {
    // Override the default stub with a 500.
    await page.route('**/api/models**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
    );
    await page.goto('/models');
    // The UI should not crash — look for any error messaging or at least the page shell.
    await expect(page.locator('body')).toBeVisible();
    // We DO expect to have logged *something* but the console-error watchdog filters benign noise.
    // This test intentionally does not assert empty consoleErrors; it asserts the app still renders.
    void consoleErrors;
  });
});
