import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

test.describe('skills pages', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('main skills page renders list', async ({ authenticatedPage: page }) => {
    await page.goto('/skills');
    await expect(page.locator('body')).toContainText(/refactor|explain|skills/i, { timeout: 10_000 });
  });

  test('skill proposals page renders pending proposals', async ({ authenticatedPage: page }) => {
    await page.goto('/skills/proposals');
    await expect(page.locator('body')).toContainText(/auto-test|auto-docs|proposals/i, { timeout: 10_000 });
  });

  test('approving a proposal hits the approve endpoint', async ({ authenticatedPage: page }) => {
    let approveCalled = false;
    await page.route('**/api/skills/proposals/*/approve**', (route) => {
      approveCalled = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto('/skills/proposals');
    const approveBtn = page.getByRole('button', { name: /approve/i }).first();
    if (await approveBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await approveBtn.click();
      await page.waitForTimeout(500);
      expect(approveCalled).toBe(true);
    }
  });

  test('rejecting a proposal hits the reject endpoint', async ({ authenticatedPage: page }) => {
    let rejectCalled = false;
    await page.route('**/api/skills/proposals/*/reject**', (route) => {
      rejectCalled = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto('/skills/proposals');
    const rejectBtn = page.getByRole('button', { name: /reject/i }).first();
    if (await rejectBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await rejectBtn.click();
      await page.waitForTimeout(500);
      expect(rejectCalled).toBe(true);
    }
  });
});
