import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

test('authentication surfaces keep readable contrast in sign-in, register, errors and two-factor states', async ({ unauthenticatedPage: page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/auth/registration', route => json(route, 200, { mode: 'open', firstAccount: false }));
  let challenge = false;
  await page.route('**/api/auth/login', route => json(route, 401, challenge ? { requiresTOTP: true } : { error: 'Invalid credentials' }));
  async function checkContrast() {
    const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations.map(item => ({ help: item.help, nodes: item.nodes.map(node => node.target) })))).toEqual([]);
  }
  await page.goto('/login');
  await expect(page.getByPlaceholder('alice')).toBeVisible();
  await checkContrast();
  await page.screenshot({ path: '/tmp/octipus-login-contrast-fixed.png' });
  await page.getByTestId('register-tab').click();
  await expect(page.getByPlaceholder('alice@example.com')).toBeVisible();
  await checkContrast();
  await page.getByRole('button', { name: 'sign in', exact: true }).first().click();
  await page.getByPlaceholder('alice').fill('contrast-test');
  await page.getByPlaceholder('••••••••').first().fill('Synthetic-password-1');
  await page.locator('form').getByRole('button', { name: 'sign in', exact: true }).click();
  await expect(page.getByText('Invalid credentials', { exact: false })).toBeVisible();
  await checkContrast();
  challenge = true;
  await page.locator('form').getByRole('button', { name: 'sign in', exact: true }).click();
  await expect(page.getByPlaceholder('000000')).toBeVisible();
  await page.getByPlaceholder('000000').fill('123456');
  await checkContrast();
});
