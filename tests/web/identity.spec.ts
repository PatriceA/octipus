import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

const persona = { id: 'octipus', presetId: 'octipus', name: 'Sparkle', pronouns: 'they/them', tone: 'playful', narration: 'minimal', signaturePhrases: [], userFacts: [], appearance: { form: 'ribbon', color: 'coral' } };

test('workspace welcome uses the personal companion and routes into work', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your workspace', exact: true })).toBeVisible();
  const welcome = page.getByRole('region', { name: 'Start work' });
  await expect(welcome).toContainText('Sparkle · your companion');
  await expect(welcome.locator('.octi-companion')).toHaveAttribute('data-form', 'ribbon');
  await expect(welcome.locator('.octi-companion')).toHaveAttribute('data-motion', 'off');
  await expect(welcome.getByRole('link', { name: 'Work on a project' })).toHaveAttribute('href', '/chat');
  await expect(welcome.getByRole('link', { name: 'Research a question' })).toHaveAttribute('href', '/research');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: '/tmp/octipus-app-identity-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/octipus-app-identity-mobile.png' });
  await welcome.getByRole('link', { name: 'Make it yours' }).click();
  await expect(page).toHaveURL(/\/persona$/);
});

test('large idle preview follows attention; working, paused, and reduced motion do not', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto('/persona');
  const preview = page.getByTestId('appearance-preview').locator('svg');
  await preview.scrollIntoViewIfNeeded();
  await page.mouse.move(1200,400);
  await expect(preview).toHaveAttribute('data-gaze', 'pointer');
  const pupils = preview.locator('.pupils');
  await expect.poll(() => preview.evaluate(el => el.style.getPropertyValue('--gaze-x'))).not.toBe('');
  const gaze = await preview.evaluate(el => el.style.getPropertyValue('--gaze-x'));
  await page.mouse.move(20,400);
  await expect.poll(() => preview.evaluate(el => el.style.getPropertyValue('--gaze-x'))).not.toBe(gaze);
  await page.getByRole('button', { name: 'Working', exact: true }).click();
  await page.mouse.move(1100,500);
  await expect(preview).not.toHaveAttribute('data-gaze', 'pointer');
  await page.getByRole('button', { name: 'Looking around', exact: true }).click();
  await page.getByRole('button', { name: 'Pause preview motion' }).click();
  await page.mouse.move(1200,600);
  await expect(preview).not.toHaveAttribute('data-gaze', 'pointer');
  await page.getByRole('button', { name: 'Resume preview motion' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(1200,500);
  await expect(preview).not.toHaveAttribute('data-gaze', 'pointer');
  expect(await pupils.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.getByTestId('appearance-preview').screenshot({ path: '/tmp/octipus-app-identity-preview.png' });
});
