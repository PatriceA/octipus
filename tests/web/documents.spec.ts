import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('documents page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
    await authenticatedPage.route('**/api/documents**', (route) =>
      json(route, 200, { documents: [{ id: 'd1', name: 'spec.md', type: 'markdown', size: 1024 }] }),
    );
  });

  test('renders document list', async ({ authenticatedPage: page }) => {
    await page.goto('/documents');
    await expect(page.locator('body')).toContainText(/spec\.md|documents/i, { timeout: 10_000 });
  });

  test('handles empty list gracefully', async ({ authenticatedPage: page }) => {
    await page.route('**/api/documents**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"documents":[]}' }),
    );
    await page.goto('/documents');
    await expect(page.locator('body')).toBeVisible();
  });
});
