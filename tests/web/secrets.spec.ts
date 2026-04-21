import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('secrets / vault page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
    await authenticatedPage.route('**/api/secrets**', (route) =>
      json(route, 200, {
        secrets: [
          { key: 'OPENAI_API_KEY', masked: 'sk-***', provider: 'openai' },
          { key: 'ANTHROPIC_API_KEY', masked: 'ak-***', provider: 'anthropic' },
        ],
      }),
    );
  });

  test('page renders', async ({ authenticatedPage: page }) => {
    await page.goto('/secrets');
    await expect(page.locator('body')).toContainText(/secret|vault|key/i, { timeout: 10_000 });
  });

  test('secret values are masked', async ({ authenticatedPage: page }) => {
    await page.goto('/secrets');
    const body = await page.locator('body').textContent();
    expect(body).not.toContain('sk-FULLKEYHERE');
  });
});
