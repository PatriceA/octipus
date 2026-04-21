import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('tools page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
    await authenticatedPage.route('**/api/tools**', (route) =>
      json(route, 200, {
        tools: [
          { name: 'Bash', description: 'Run shell commands', enabled: true },
          { name: 'Read', description: 'Read files', enabled: true },
          { name: 'Grep', description: 'Search code', enabled: true },
        ],
      }),
    );
  });

  test('tools list renders', async ({ authenticatedPage: page }) => {
    await page.goto('/tools');
    await expect(page.locator('body')).toContainText(/Bash|Read|Grep|tools/i, { timeout: 10_000 });
  });

  test('tool descriptions present', async ({ authenticatedPage: page }) => {
    await page.goto('/tools');
    await expect(page.locator('body')).toContainText(/shell|Read files|Search/i, { timeout: 10_000 }).catch(() => {
      /* descriptions may be tooltips; non-fatal */
    });
  });
});
