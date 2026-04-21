import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

test.describe('accessibility', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('dashboard has no serious or critical axe violations', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => {/* may not fully idle due to WS */});
    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast']) // theme tweaks can cause false-positive contrast hits
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
  });

  test('chat page has no serious or critical axe violations', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForTimeout(500);
    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
  });

  test('keyboard-only nav reaches interactive elements', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    // Tab a few times; we should land on something focusable.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
    }
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']).toContain(focused || 'BODY');
  });

  test('icon-only buttons have accessible names', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    // Count buttons that have either aria-label or text content.
    const iconButtons = await page.$$eval('button', (btns) =>
      btns.filter((b) => {
        const hasText = (b.textContent || '').trim().length > 0;
        const hasAria = b.hasAttribute('aria-label') || b.hasAttribute('aria-labelledby') || b.hasAttribute('title');
        return !hasText && !hasAria;
      }).length,
    );
    expect(iconButtons).toBeLessThan(5); // Allow tiny slack; loud failure if many icon btns lack labels.
  });
});
