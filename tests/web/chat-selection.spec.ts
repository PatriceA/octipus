import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test('multi-paragraph selection survives chat polling and copies every line', async ({ authenticatedPage: page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.install();
  let reads = 0;
  await page.route('**/api/sessions/*/messages**', route => {
    reads++;
    return json(route, 200, { messages: [{ id: 'multiline', role: 'assistant',
      content: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.', createdAt: '2026-09-22T10:00:00Z' }] });
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const paragraphs = page.locator('[data-role="assistant"] p');
  await expect(paragraphs).toHaveCount(3);
  await paragraphs.first().evaluate(node => {
    const last = node.parentElement!.querySelector('p:last-child')!;
    const range = document.createRange();
    range.setStart(node.firstChild!, 0);
    range.setEnd(last.firstChild!, last.textContent!.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  const selection = await page.evaluate(() => window.getSelection()!.toString());
  expect(selection).toContain('Third paragraph.');
  const previousReads = reads;
  await page.clock.runFor(11000);
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  // Wait for the polled state to reach React, then copy the selection the user made.
  await page.clock.runFor(100);
  await expect.poll(() => page.evaluate(() => window.getSelection()!.toString())).toBe(selection);
  await page.keyboard.press('ControlOrMeta+c');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, '\n')).toBe(selection.replace(/\r\n/g, '\n'));
});
