import type { Route } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

/**
 * The interactive-answer focus guard (S14), where the browser lets a frame's
 * script take the keyboard focus: the desktop app's webviews and older
 * browsers. Chromium 158 refuses that focus by itself
 * (BlockingFocusWithoutUserActivation, see inline-ui.spec.ts), so this file
 * turns the rule off: the guard must give the focus back and stop the block.
 */
test.use({ launchOptions: { args: ['--disable-features=BlockingFocusWithoutUserActivation'] } });

const THIEF = '66666666-6666-4666-8666-666666666666';
const block = { id: THIEF, title: 'Thief', html: '<input id="i" aria-label="x">', css: '', js: "setTimeout(function () { document.getElementById('i').focus(); }, 1500);", scripts: true };

test('a block that takes the keyboard focus by itself is stopped and the focus returns', async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/sess-1/inline-ui/*', (route: Route) => json(route, 200, { block: { heightHint: 120, tainted: false, risk: 'normal', issues: [], shared: false, ...block } }));
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
  gateway.event('chat.response', { response: { response: `[[octi-ui:${THIEF}|Thief]]`, sessionId: 'sess-1' } }, 'sess-1');
  const input = page.getByPlaceholder(/send a message/i).first();
  await input.click();
  await input.pressSequentially('typing my own message', { delay: 80 });
  await expect(page.getByTestId('inline-ui-block').filter({ hasText: 'Thief' })).toContainText('Stopped: It tried to take the keyboard focus.');
  await expect(input).toBeFocused();
});
