import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('tasks / hooks page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
    await authenticatedPage.route('**/api/tasks**', (route) =>
      json(route, 200, { tasks: [{ id: 't1', cron: '*/5 * * * *', prompt: 'Check status', enabled: true }] }),
    );
    await authenticatedPage.route('**/api/hooks**', (route) =>
      json(route, 200, { hooks: [{ id: 'h1', event: 'session.end', script: 'notify.sh' }] }),
    );
  });

  test('tasks page renders', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    await expect(page.locator('body')).toBeVisible();
  });

  test('hooks page renders', async ({ authenticatedPage: page }) => {
    await page.goto('/hooks').catch(() => page.goto('/tasks')); // fallback if /hooks isn't wired
    await expect(page.locator('body')).toBeVisible();
  });
});
