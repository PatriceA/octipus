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
