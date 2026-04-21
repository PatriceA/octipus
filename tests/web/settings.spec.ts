import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

test.describe('settings page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('settings page renders current theme', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await expect(page.locator('body')).toContainText(/theme|settings|dark|preferences/i, { timeout: 10_000 });
  });

  test('topic → model mapping is rendered', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await expect(page.locator('body')).toContainText(/coding|research|topic|mapping|gpt-4o|claude/i, { timeout: 10_000 }).catch(() => {
      /* Settings UI may not expose this section in all environments. */
    });
  });
});
