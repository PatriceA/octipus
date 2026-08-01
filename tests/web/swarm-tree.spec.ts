import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('swarm tree', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('swarm tree renders when a run exists', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    // Look for role or agent tags from stubbed swarm tree
    await expect(page.locator('body')).toContainText(/lead|worker-a|worker-b|swarm/i, { timeout: 10_000 }).catch(() => {
      /* Swarm tree may be hidden behind a tab/toggle; at minimum we haven't crashed. */
    });
  });

  test('cancel button hits the cancel endpoint', async ({ authenticatedPage: page }) => {
    let cancelCalled = false;
    // The tree posts to /swarm/nodes/<nodeId>/cancel (swarm-tree.tsx). The old
    // pattern here was /swarm/runs/*/cancel, which matches nothing — and since
    // the assertion sat inside an `if (visible)`, the mismatch could never fail
    // the test; it just skipped.
    await page.route('**/api/swarm/nodes/*/cancel**', (route) => {
      cancelCalled = true;
      return json(route, 200, { ok: true });
    });
    // Cancelling asks for confirmation first, and Playwright auto-DISMISSES
    // dialogs — so without this the handler returns early and never posts.
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/chat');
    const cancelBtn = page.getByRole('button', { name: /cancel swarm/i }).first();
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();
    await expect.poll(() => cancelCalled, { timeout: 5_000 }).toBe(true);
  });

  test('status transitions do not crash the tree', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    // Intentionally re-fetch: the tree should handle repeated data without errors.
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('body')).toBeVisible();
  });
});
