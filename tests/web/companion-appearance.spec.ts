import type { CompanionAppearance } from '../../src/shared/companion';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

const persona = {
  id: 'octipus', presetId: 'octipus', name: 'Sparkle', pronouns: 'they/them', tone: 'playful',
  narration: 'minimal', signaturePhrases: [], userFacts: [],
};

test('preview, save and reload appearance; private chat uses the saved look', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  let saved: CompanionAppearance = { form: 'pebble', color: 'sea-glass' };
  const writes: CompanionAppearance[] = [];
  await page.route('**/api/persona', route => json(route, 200, { ...persona, appearance: saved }));
  await page.route('**/api/persona/appearance', route => {
    saved = route.request().postDataJSON() as CompanionAppearance;
    writes.push(saved);
    return json(route, 200, { appearance: saved });
  });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto('/persona');
  const preview = page.getByTestId('appearance-preview').locator('.octi-companion');
  await page.getByRole('radio', { name: 'Ribbon', exact: true }).check();
  await page.getByRole('radio', { name: 'Coral', exact: true }).check();
  await expect(preview).toHaveAttribute('data-form', 'ribbon');
  await expect(preview).toHaveAttribute('data-color', 'coral');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Working', exact: true }).click();
  await expect(preview).toHaveAttribute('data-state', 'working');
  await page.getByRole('button', { name: 'Pause preview motion' }).click();
  await expect(preview).toHaveAttribute('data-motion', 'off');
  await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save appearance', exact: true })).toBeDisabled();
  expect(writes).toEqual([{ form: 'ribbon', color: 'coral' }]);
  await expect(preview).toHaveAttribute('data-motion', 'off');
  await page.reload();
  await expect(preview).toHaveAttribute('data-form', 'ribbon');
  await expect(preview).toHaveAttribute('data-color', 'coral');
  await page.locator('[aria-labelledby="companion-appearance-title"]').screenshot({ path: '/tmp/octipus-companion-appearance.png' });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect(page.locator('.octi-companion').first()).toHaveAttribute('data-form', 'ribbon');
  await expect(page.locator('.octi-companion').first()).toHaveAttribute('data-color', 'coral');
});

test('failed saves keep the draft, discard restores saved choices, reduced motion and mobile fit', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/persona', route => json(route, 200, { ...persona, appearance: { form: 'pebble', color: 'sea-glass' } }));
  await page.route('**/api/persona/appearance', route => json(route, 409, { error: 'Please retry' }));
  await page.goto('/persona');
  await page.getByRole('radio', { name: 'Inky', exact: true }).check();
  await page.getByRole('radio', { name: 'Lavender', exact: true }).check();
  await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save appearance');
  const preview = page.getByTestId('appearance-preview').locator('.octi-companion');
  await expect(preview).toHaveAttribute('data-form', 'ink');
  expect(await preview.evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length)).toBe(0);
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(preview).toHaveAttribute('data-form', 'pebble');
  await expect(preview).toHaveAttribute('data-color', 'sea-glass');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
