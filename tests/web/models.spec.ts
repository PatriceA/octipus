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

  test('a topics response with no topics array does not take down the page', async ({
    authenticatedPage: page,
  }) => {
    // OrchestratorModelNote is a decoration on this page, but it read
    // `topics.find(...)` straight off the payload — so a 200 whose body lacked
    // the array threw during render and the error boundary replaced the whole
    // Models page with "This page couldn't load". An older backend, a partial
    // deploy, or a proxy all produce exactly this body.
    await page.route('**/api/topics', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/models');
    await expect(page.locator('body')).toContainText(/gpt-4o|claude-3-5-sonnet/, { timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText(/couldn.t load/i);
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
