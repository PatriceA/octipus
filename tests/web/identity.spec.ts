import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

const persona = { id: 'octipus', presetId: 'octipus', name: 'Sparkle', pronouns: 'they/them', tone: 'playful', narration: 'minimal', signaturePhrases: [], userFacts: [], appearance: { form: 'ribbon', color: 'coral' } };

test('workspace keeps Companion distinct and routes into focused work', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  await page.route('**/api/companion/settings', route => json(route, 200, { enabled: true, supervisorSessionId: 'saved-companion', modelName: 'configured' }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Companion', exact: true })).toHaveAttribute('href', '/chat?session=saved-companion');
  await expect(page.getByRole('link', { name: 'New session', exact: true })).toHaveAttribute('href', '/chat?new=1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: '/tmp/octipus-app-identity-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/octipus-app-identity-mobile.png' });
});

test('natural portrait uses the saved look and activity respects reduced motion', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.goto('/persona');
  const preview = page.getByTestId('appearance-preview').locator('img.octi-companion');
  await expect(preview).toHaveAttribute('src', '/companions/ribbon-coral.webp');
  expect(await preview.evaluate(el => (el as HTMLImageElement).decode().then(() => true))).toBe(true);
  await page.getByRole('button', { name: 'Working', exact: true }).click();
  await expect(preview).toHaveAttribute('data-state', 'working');
  expect(await preview.evaluate(el => getComputedStyle(el).animationName)).toBe('companion-attention');
  await page.getByRole('button', { name: 'Pause preview motion' }).click();
  expect(await preview.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Resume preview motion' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await preview.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  for (const look of ['Dumbo', 'Reef', 'Inky']) {
    await page.getByRole('radio', { name: look, exact: true }).check();
    for (const color of ['Sea glass', 'Coral', 'Lavender', 'Sunshine', 'Ocean blue']) {
      await page.getByRole('radio', { name: color, exact: true }).check();
      await expect.poll(() => preview.evaluate(el => (el as HTMLImageElement).decode().then(() => (el as HTMLImageElement).naturalWidth))).toBe(512);
    }
  }
  await page.getByTestId('appearance-preview').screenshot({ path: '/tmp/octipus-natural-appearance.png' });
});
