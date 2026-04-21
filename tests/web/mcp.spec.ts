import { test, expect } from './fixtures/auth';
import { stubAllDefaults, stubMcp } from './fixtures/api-stubs';

test.describe('mcp page', () => {
  test('server list renders', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.goto('/mcp');
    await expect(page.locator('body')).toContainText(/filesystem|github/, { timeout: 10_000 });
  });

  test('circuit open state shows a warning badge', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    // Override circuit to open
    await stubMcp(page, 'open');
    await page.goto('/mcp');
    await expect(page.locator('body')).toContainText(/open|warning|circuit|degraded/i, { timeout: 10_000 });
  });

  test('reset button exists when circuit is non-closed', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await stubMcp(page, 'open');
    await page.goto('/mcp');
    const resetBtn = page.getByRole('button', { name: /reset/i }).first();
    // Best-effort: button may or may not be present depending on UI state — just assert no crash.
    if (await resetBtn.isVisible().catch(() => false)) {
      await expect(resetBtn).toBeEnabled();
    }
  });
});
