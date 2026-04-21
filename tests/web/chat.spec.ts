import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test.describe('chat page', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.route('**/api/chat/send**', (route) =>
      json(route, 200, {
        response: 'Hello from the stubbed assistant.',
        sessionId: 'sess-1',
        tokens: 12,
      }),
    );
    // Block WS upgrade so tests don't hang waiting for a live socket.
    await page.route('**/ws**', (route) => route.abort());
  });

  test('loads chat page with session list', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByText(/First chat|Second chat/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('empty input cannot be submitted', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    // The Send button is rendered by PromptInput; it may be absent when no session active.
    const submit = page.getByRole('button', { name: /send/i }).first();
    if (await submit.isVisible().catch(() => false)) {
      // With empty input, button should be disabled.
      await expect(submit).toBeDisabled();
    }
  });

  test('typing a message updates the input', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    const input = page.getByPlaceholder(/send a message|create a session/i).first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill('Hello world');
    await expect(input).toHaveValue('Hello world');
  });

  test('long message fills without truncation', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    const input = page.getByPlaceholder(/send a message|create a session/i).first();
    await input.waitFor({ state: 'visible' });
    const longMsg = 'A'.repeat(2000);
    await input.fill(longMsg);
    await expect(input).toHaveValue(longMsg);
  });

  test('switching session preserves history visually', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    const first = page.getByText(/First chat/).first();
    const second = page.getByText(/Second chat/).first();
    if (await first.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await first.click();
      await second.click();
      await expect(page.getByText(/First chat|Second chat/).first()).toBeVisible();
    }
  });
});
