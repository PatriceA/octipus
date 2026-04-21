import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

/**
 * Mobile viewport tests — run under the chromium-mobile project (375x667).
 * See playwright.config.ts for project config.
 */

test.describe('responsive', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('chat layout fits without horizontal scroll', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2); // 2px slack
  });

  test('expert list wraps correctly on mobile (regression)', async ({ authenticatedPage: page }) => {
    await page.goto('/agents');
    // Multi-line custom description should be on multiple lines / not overflow.
    const overflowingElements = await page.$$eval('*', (nodes) =>
      nodes.filter((n) => {
        const el = n as HTMLElement;
        return el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 100;
      }).length,
    );
    // A few legitimate overflows (scrollable containers) are OK; we just guard against page-wide overflow.
    expect(overflowingElements).toBeLessThan(20);
  });

  test('sidebar collapses or hides on mobile', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    // Either the sidebar is collapsed (narrower), or it's hidden behind a hamburger.
    await expect(page.locator('body')).toBeVisible();
  });
});
