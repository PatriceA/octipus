import type { Page } from '@playwright/test';
import { json, selectChatSession, stubAllDefaults } from './fixtures/api-stubs';
import { expect, STUB_USER, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

/**
 * The web on the gateway (coworking S0d): one `/gateway` connection per tab,
 * shared by the chat page and the permission prompts; the account's
 * connection cap; and the workspace header on a switch.
 */

/** The page-level stubs the auth fixture installs, for a second tab of the same context. */
async function stubTab(tab: Page): Promise<void> {
  await tab.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await tab.route('**/api/auth/me', (route) => json(route, 200, STUB_USER));
  await stubAllDefaults(tab);
}

test('two tabs of one user both receive the user\'s events', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page.context());
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const second = await page.context().newPage();
  await stubTab(second);
  await second.goto('/chat');
  await selectChatSession(second, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(2);
  // One connection per tab: the chat page and the permission prompts share it.
  expect(gateway.sockets).toHaveLength(2);

  gateway.event('chat.response', { response: { response: 'Delivered to every tab.' } }, 'sess-1');
  await expect(page.getByText('Delivered to every tab.', { exact: true })).toBeVisible();
  await expect(second.getByText('Delivered to every tab.', { exact: true })).toBeVisible();

  // A failed turn stops both spinners with the error.
  gateway.event('chat.error', { error: 'model unavailable' }, 'sess-1');
  await expect(page.getByText('Error: model unavailable')).toBeVisible();
  await expect(second.getByText('Error: model unavailable')).toBeVisible();
});

test('a message sent from one tab goes out as chat.send with the workspace', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  const input = page.getByPlaceholder(/send a message/i).first();
  await input.fill('Hello there');
  await input.press('Enter');
  await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send'))
    .toEqual({ type: 'chat.send', sessionId: 'sess-1', content: 'Hello there', workspaceId: 'ws-1' });
});

test('an in-app delivery shows in its session', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  // The chat page tells the server it can show one (otherwise it is not delivered).
  await expect.poll(() => gateway.sent.find((m) => m.type === 'subscribe' && m.resources)).toEqual({ type: 'subscribe', resources: ['chat:inbox'] });
  gateway.event('chat.message', { role: 'assistant', content: 'Your nightly report is ready.', proactive: true }, 'sess-1');
  await expect(page.getByText('Your nightly report is ready.', { exact: true })).toBeVisible();
});

test('a tab over the account\'s connection cap says so', async ({ authenticatedPage: page }) => {
  let full = true;
  const gateway = await stubGateway(page, { tooManyConnections: () => full });
  await page.goto('/chat');
  const banner = page.getByTestId('too-many-tabs');
  await expect(banner).toContainText('Too many open tabs');
  // A slot frees up; Retry connects.
  full = false;
  await banner.getByRole('button', { name: /retry/i }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => gateway.subscribed()).toBe(1);
});

test('a workspace switch never fetches with the old header', async ({ authenticatedPage: page }) => {
  const now = new Date().toISOString();
  await page.route('**/api/me/workspaces', (route) => json(route, 200, {
    workspaces: [
      { id: 'ws-1', userId: STUB_USER.id, slug: 'default', name: 'Default', isDefault: true, createdAt: now, updatedAt: now },
      { id: 'ws-2', userId: STUB_USER.id, slug: 'work', name: 'Work', isDefault: false, createdAt: now, updatedAt: now },
    ],
  }));
  await stubGateway(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await page.waitForLoadState('networkidle');

  const after: Array<{ url: string; workspace: string | undefined }> = [];
  let switched = false;
  page.on('request', (request) => {
    if (!switched || !request.url().includes('/api/')) return;
    after.push({ url: request.url(), workspace: request.headers()['x-octipus-workspace'] });
  });
  switched = true;
  await page.getByRole('button', { name: 'Work work', exact: true }).click();

  // The dashboard's workspace-scoped data is fetched again, for the new workspace.
  await expect.poll(() => after.some((r) => r.url.includes('/api/sessions'))).toBe(true);
  expect(after.length).toBeGreaterThan(0);
  expect(after.filter((r) => r.workspace !== 'ws-2')).toEqual([]);
});

test('a chat.send the server refuses stops the spinner and says why', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  const input = page.getByPlaceholder(/send a message/i).first();
  await input.fill('Hello there');
  await input.press('Enter');
  await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')?.content).toBe('Hello there');
  await expect(page.getByText('Thinking...', { exact: true })).toBeVisible();

  // Refused before any turn started: an error frame only, no chat.error.
  gateway.send({ type: 'error', code: 'RATE_LIMITED', message: 'Rate limited. Retry after 12s' });
  await expect(page.getByText('Message not sent: Rate limited. Retry after 12s')).toBeVisible();
  await expect(page.getByText('Thinking...', { exact: true })).toHaveCount(0);

  // A message over the length limit is refused here, before it is sent.
  const sends = gateway.sent.filter((m) => m.type === 'chat.send').length;
  await input.fill('x'.repeat(100_001));
  await input.press('Enter');
  await expect(page.getByText(/Message not sent: it is 100,001 characters/)).toBeVisible();
  await expect(page.getByText('Thinking...', { exact: true })).toHaveCount(0);
  expect(gateway.sent.filter((m) => m.type === 'chat.send')).toHaveLength(sends);
});

test('another session\'s turn events leave the open tab\'s turn alone', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  const input = page.getByPlaceholder(/send a message/i).first();
  await input.fill('A long task');
  await input.press('Enter');
  await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')?.sessionId).toBe('sess-1');
  gateway.event('chat.delta', { agentId: 'root', delta: 'Working on the long task', iteration: 0 }, 'sess-1');
  await expect(page.getByText('Working on the long task')).toBeVisible();

  // Another tab's turn in sess-2: streams, reports status, finishes, fails.
  gateway.event('chat.delta', { agentId: 'root-2', delta: 'Other tab text', iteration: 0 }, 'sess-2');
  gateway.event('rootAgent.status', { message: 'Other tab status' }, 'sess-2');
  gateway.event('chat.response', { response: { response: 'Other tab answer' } }, 'sess-2');
  gateway.event('chat.error', { error: 'other tab failed' }, 'sess-2');
  await page.waitForTimeout(300);
  // The streamed text shows only while this tab's turn is running.
  await expect(page.getByText('Working on the long task')).toBeVisible();
  await expect(page.getByText('Other tab text')).toHaveCount(0);
  await expect(page.getByText('Other tab status')).toHaveCount(0);
  await expect(page.getByText('Other tab answer')).toHaveCount(0);

  // Its own reply ends it.
  gateway.event('chat.response', { response: { response: 'Long task done.' } }, 'sess-1');
  await expect(page.getByText('Long task done.', { exact: true })).toBeVisible();
  await expect(page.getByText('Working on the long task')).toHaveCount(0);
  await expect(page.getByText('Thinking...', { exact: true })).toHaveCount(0);
});

test('a reconnect without a watermark reloads from REST, and a replayed reply is not shown twice', async ({ authenticatedPage: page }) => {
  const createdAt = new Date().toISOString();
  let messageLoads = 0;
  await page.route('**/api/sessions/sess-1/messages**', (route) => {
    messageLoads++;
    return json(route, 200, { messages: [
      { id: 'q-1', role: 'user', content: 'What happened?', createdAt },
      { id: 'a-1', role: 'assistant', content: 'The deploy finished.', createdAt },
    ] });
  });
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  await expect(page.getByText('The deploy finished.', { exact: true })).toHaveCount(1);

  // The connection drops; the tab saw no live event of sess-1.
  const loadsBefore = messageLoads;
  await gateway.sockets[0].close();
  await expect.poll(() => gateway.subscribed(), { timeout: 15_000 }).toBe(2);
  await expect.poll(() => gateway.sent.find((m) => m.type === 'replay')).toEqual({ type: 'replay', sessionId: 'sess-1' });
  // As the server answers it: nothing to bridge from, reload.
  gateway.send({ type: 'replay', sessionId: 'sess-1', events: [], gap: true });
  await expect.poll(() => messageLoads).toBeGreaterThan(loadsBefore);

  // Even an old reply replayed as an event is the one already shown.
  gateway.send({ type: 'replay', sessionId: 'sess-1', gap: false, events: [{
    id: 'evt-old-reply', type: 'chat.response', source: 'rootAgent', userId: 'e2e-user-id', sessionId: 'sess-1',
    timestamp: Date.parse(createdAt), payload: { response: { response: 'The deploy finished.' } },
  }] });
  await page.waitForTimeout(300);
  await expect(page.getByText('The deploy finished.', { exact: true })).toHaveCount(1);
});
