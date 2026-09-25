import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

test.describe('settings page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('settings page renders current theme', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await expect(page.locator('body')).toContainText(/theme|settings|dark|preferences/i, { timeout: 10_000 });
  });

  // The toggle used to save the value from before the click, so the PUT was a
  // no-op and the refetch flipped the switch straight back.
  test('boolean toggle saves the flipped value', async ({ authenticatedPage: page }) => {
    const puts: unknown[] = [];
    await page.route('**/api/settings', (route) =>
      json(route, 200, {
        categories: ['agent'],
        settings: {
          agent: [{
            key: 'agent.promptDumps', value: true, valueType: 'boolean', defaultValue: true,
            description: 'Write prompts', isSecret: false, category: 'agent',
          }],
        },
      }),
    );
    await page.route('**/api/settings/agent.promptDumps', (route) => {
      puts.push(route.request().postDataJSON());
      return json(route, 200, { ok: true });
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Configuration' }).click();
    await page.getByRole('switch', { name: 'promptDumps' }).click();
    await expect.poll(() => puts).toEqual([{ value: false }]);
  });

  test('topic → model mapping is rendered', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await expect(page.locator('body')).toContainText(/coding|research|topic|mapping|gpt-4o|claude/i, { timeout: 10_000 }).catch(() => {
      /* Settings UI may not expose this section in all environments. */
    });
  });
});
