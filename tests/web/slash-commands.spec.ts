import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test('slash commands filter, complete, dismiss and preserve arguments', async ({ authenticatedPage: page }) => {
  await page.route('**/api/chat/commands', route => json(route, 200, { commands: [
    { name: 'help', description: 'List commands' },
    { name: 'compact', description: 'Summarize older context' },
    { name: 'clear', description: 'Reset context' },
  ] }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const input = page.getByPlaceholder('Send a message or change direction...');
  await input.fill('/');
  await expect(page.getByRole('option')).toHaveCount(3);
  await input.press('ArrowDown');
  await input.press('Tab');
  await expect(input).toHaveValue('/compact ');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await input.fill('/co');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option').click();
  await expect(input).toHaveValue('/compact ');
  await input.fill('/compact keep decisions');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await input.fill('/');
  await input.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await input.fill('text /');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});
