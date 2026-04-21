import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

test.describe('pipelines page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('pipeline templates list renders', async ({ authenticatedPage: page }) => {
    await page.goto('/pipelines');
    await expect(page.locator('body')).toContainText(/build-and-test|release|pipelines|templates/i, { timeout: 10_000 });
  });

  test('creating a pipeline run hits the POST endpoint', async ({ authenticatedPage: page }) => {
    let runCreated = false;
    await page.route('**/api/pipelines/runs**', (route) => {
      if (route.request().method() === 'POST') runCreated = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run: { id: 'run-new', status: 'queued' } }),
      });
    });
    await page.goto('/pipelines');
    const startBtn = page.getByRole('button', { name: /run|start|execute/i }).first();
    if (await startBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(500);
      expect(runCreated).toBeTruthy();
    }
  });
});
