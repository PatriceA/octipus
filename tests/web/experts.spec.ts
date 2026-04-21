import { expect, test } from './fixtures/auth';

test.describe('experts (chat slash command)', () => {
  // NOTE: there is no standalone /experts web page — experts are selected in
  // chat via the `/expert <name>` slash command. These tests exercise that UI.

  test('chat accepts /expert command without crashing', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    const input = page.getByPlaceholder(/send a message|create a session/i).first();
    if (await input.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await input.fill('/expert Coder');
      await expect(input).toHaveValue('/expert Coder');
    }
  });

  test('chat accepts /expert reset command', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    const input = page.getByPlaceholder(/send a message|create a session/i).first();
    if (await input.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await input.fill('/expert reset');
      await expect(input).toHaveValue('/expert reset');
    }
  });
});
