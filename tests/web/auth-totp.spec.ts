import type { Page } from '@playwright/test';
import { expect, expectNoConsoleErrors, installConsoleWatchdog, STUB_USER, test } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

/**
 * Sign-in with TOTP, and `returnTo`, from the web login page.
 *
 * The server answers a correct password on a TOTP account with
 * `401 { requiresTOTP: true }`; the page must show the code field and resubmit
 * the same credentials with the code, then land on the validated `returnTo`.
 */

const TOTP = '123456';

/** Signed out at first: `/auth/me` is 401 until a login succeeds. */
async function signedOutPage(page: Page, logins: Record<string, unknown>[]) {
  // Catch-all first so the specific stubs registered after it win.
  await page.route('**/api/**', (route) => json(route, 200, {}));
  await stubAllDefaults(page);
  await page.route('**/api/auth/me', (route) => json(route, 401, { error: 'Not authenticated' }));
  await page.route('**/api/auth/login', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    logins.push(body);
    if (body.password !== 'Correct-horse-1') return json(route, 401, { error: 'Invalid credentials' });
    if (!body.totpCode) return json(route, 401, { error: 'TOTP code required', requiresTOTP: true });
    if (body.totpCode !== TOTP) return json(route, 401, { error: 'Invalid TOTP code' });
    return json(route, 200, {
      user: STUB_USER,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      returnTo: body.returnTo ?? '/',
    });
  });
}

test.describe('TOTP sign-in', () => {
  test('asks for the code, resubmits with it, and returns to returnTo', async ({ browser, consoleErrors }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    installConsoleWatchdog(page, consoleErrors);
    const logins: Record<string, unknown>[] = [];
    await signedOutPage(page, logins);

    await page.goto('/login?returnTo=%2Fsettings');
    await page.getByPlaceholder('alice').fill('e2etest');
    await page.getByPlaceholder('••••••••').first().fill('Correct-horse-1');
    await page.locator('form').getByRole('button', { name: /sign in/i }).click();

    // The second factor, not an error: the TOTP field replaces the form.
    const code = page.getByPlaceholder('000000');
    await expect(code).toBeVisible();
    await expect(page.getByText('TOTP code required')).toHaveCount(0);
    expect(logins[0]).toMatchObject({ username: 'e2etest', returnTo: '/settings' });
    expect(logins[0]).not.toHaveProperty('totpCode');

    // A wrong code is reported and the field stays.
    await code.fill('000000');
    await page.getByRole('button', { name: /verify/i }).click();
    await expect(page.getByText('Invalid TOTP code')).toBeVisible();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings$/);

    await code.fill(TOTP);
    await page.getByRole('button', { name: /verify/i }).click();
    await page.waitForURL(/\/settings$/);
    expect(logins.at(-1)).toMatchObject({
      username: 'e2etest',
      password: 'Correct-horse-1',
      totpCode: TOTP,
      returnTo: '/settings',
    });
    expectNoConsoleErrors(consoleErrors);
    await ctx.close();
  });

  test('a foreign returnTo is not sent, and sign-in lands on /', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const logins: Record<string, unknown>[] = [];
    await signedOutPage(page, logins);

    await page.goto(`/login?returnTo=${encodeURIComponent('//evil.example/phish')}`);
    await page.getByPlaceholder('alice').fill('e2etest');
    await page.getByPlaceholder('••••••••').first().fill('Correct-horse-1');
    await page.locator('form').getByRole('button', { name: /sign in/i }).click();
    await page.getByPlaceholder('000000').fill(TOTP);
    await page.getByRole('button', { name: /verify/i }).click();

    await page.waitForURL((url) => url.pathname === '/');
    expect(new URL(page.url()).host).toMatch(/^localhost(:\d+)?$/);
    for (const body of logins) expect(body).not.toHaveProperty('returnTo');
    await ctx.close();
  });

  test('a signed-out visit to a page comes back to it after sign-in', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signedOutPage(page, []);

    await page.goto('/settings');
    await page.waitForURL(/\/login\?returnTo=%2Fsettings$/);
    await ctx.close();
  });
});
