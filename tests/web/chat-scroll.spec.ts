import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

test('chat opens at the latest message, follows late layout, and respects reading older messages', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.route('**/api/sessions/*/messages**', async route => {
    const session = new URL(route.request().url()).pathname.split('/')[3];
    await json(route, 200, { messages: Array.from({ length: 70 }, (_, index) => ({
      id: `${session}-${index}`, role: index % 2 ? 'assistant' : 'user',
      content: `Message ${index} in ${session}\n\n${'Conversation history with enough detail to fill the viewport. '.repeat(8)}`,
      createdAt: new Date(Date.UTC(2026, 9, 25, 10, 0, index)).toISOString(),
    })) });
  });
  const timeline = page.getByTestId('chat-timeline');
  const distance = () => timeline.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect(page.locator('[data-message-id="sess-1-69"]')).toBeAttached();
  await expect.poll(distance).toBeLessThanOrEqual(2);
  // A media/markdown layout change after initial rendering must stay pinned.
  await page.locator('[data-message-id="sess-1-69"]').evaluate(el => { el.style.minHeight = '500px'; });
  await expect.poll(distance).toBeLessThanOrEqual(2);
  await timeline.evaluate(el => { el.scrollTop = 300; });
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  gateway.event('rootAgent.status', { message: 'A fresh progress update', messageId: 'new-progress', createdAt: new Date().toISOString() }, 'sess-1');
  await expect(page.locator('[data-message-id="new-progress"]')).toBeAttached();
  await expect.poll(() => timeline.evaluate(el => el.scrollTop)).toBeLessThan(400);
  await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  await expect.poll(distance).toBeLessThanOrEqual(2);
  // Switching from an older position to an equally long conversation resets follow state.
  await timeline.evaluate(el => { el.scrollTop = 300; });
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible();
  await selectChatSession(page, 'sess-2');
  await expect(page.locator('[data-message-id="sess-2-69"]')).toBeAttached();
  await expect.poll(distance).toBeLessThanOrEqual(2);
  await page.reload();
  await expect(page.locator('[data-message-id="sess-2-69"]')).toBeAttached();
  await expect.poll(distance).toBeLessThanOrEqual(2);
});
