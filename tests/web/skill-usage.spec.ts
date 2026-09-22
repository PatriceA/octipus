import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test('chat skill modes persist on reopen and default controls omit session-only selection', async ({ authenticatedPage: page }) => {
  const modes = new Map<string, string>();
  const updates: any[] = [];
  await page.route('**/api/skills/usage**', async route => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get('sessionId') ?? '';
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON(); updates.push(body);
      modes.set(body.sessionId ?? '', body.mode);
      return json(route, 200, { saved: true });
    }
    return json(route, 200, { skills: [{ id: 'writing', name: 'Writing', description: 'Write clearly.',
      mode: modes.get(scope) ?? 'automatic', available: true }] });
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await page.getByRole('button', { name: /Skills/ }).click();
  await page.getByLabel('Writing', { exact: true }).selectOption('session');
  await expect(page.getByLabel('Writing', { exact: true })).toHaveValue('session');
  expect(updates.at(-1)).toEqual({ skillId: 'writing', mode: 'session', sessionId: 'sess-1' });
  await page.reload();
  await page.getByRole('button', { name: /Skills/ }).click();
  await expect(page.getByLabel('Writing', { exact: true })).toHaveValue('session');
  await selectChatSession(page, 'sess-2');
  await page.getByRole('button', { name: /Skills/ }).click();
  await expect(page.getByLabel('Writing', { exact: true })).toHaveValue('automatic');
  await page.goto('/skills');
  await page.getByRole('button', { name: /Skills/ }).click();
  const choice = page.getByLabel('Writing', { exact: true });
  await expect(choice.locator('option')).toHaveCount(2);
  await choice.selectOption('always');
  await expect(choice).toHaveValue('always');
  expect(updates.at(-1)).toEqual({ skillId: 'writing', mode: 'always' });
});
