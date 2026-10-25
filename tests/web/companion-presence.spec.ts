import type { Page } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

const persona = {
  id: 'octipus', presetId: 'octipus', name: 'Sparkle', pronouns: 'they/them', tone: 'playful',
  narration: 'minimal', signaturePhrases: [], userFacts: [], appearance: { form: 'ink', color: 'coral' },
};

/**
 * A recording `Notification` in place of the browser's, with permission
 * `initial` until the page asks. `away` makes the window report no focus, as
 * when the user is in another app.
 */
async function stubNotifications(page: Page, { initial = 'granted', away = false }: { initial?: NotificationPermission; away?: boolean } = {}) {
  await page.addInitScript(({ initial, away }) => {
    const shown: Array<{ title: string; body?: string; tag?: string; icon?: string }> = [];
    const instances: Array<{ onclick: (() => void) | null }> = [];
    let permission = initial;
    class RecordingNotification {
      static get permission() { return permission; }
      static async requestPermission() { permission = 'granted'; return permission; }
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions = {}) {
        shown.push({ title, body: options.body, tag: options.tag, icon: options.icon });
        instances.push(this);
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: RecordingNotification, configurable: true });
    Object.assign(window, { __notifications: shown, __notificationInstances: instances });
    if (away) document.hasFocus = () => false;
  }, { initial, away });
  return {
    shown: () => page.evaluate(() => (window as unknown as { __notifications: Array<{ title: string; body?: string; tag?: string; icon?: string }> }).__notifications),
    click: (index: number) => page.evaluate(i => (window as unknown as { __notificationInstances: Array<{ onclick: () => void }> }).__notificationInstances[i].onclick(), index),
  };
}

async function enableNotifications(page: Page) {
  await page.addInitScript(() => localStorage.setItem('octipus.companion.prefs', JSON.stringify({ notify: true })));
}

test('while away: notifies, updates the tab icon, counts unseen moments, and a click opens the conversation', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  const notifications = await stubNotifications(page, { away: true });
  await enableNotifications(page);
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);

  gateway.event('rootAgent.status', { message: 'Reading the repo' }, 'sess-2');
  const icon = page.locator('link[rel="icon"][data-companion]');
  await expect(icon).toHaveAttribute('data-companion', 'working');
  await expect.poll(() => icon.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
  // The brand icons step aside while the companion's is up.
  await expect(page.locator('link[rel="icon"]:not([data-companion])')).toHaveCount(0);

  gateway.event('chat.response', { response: { response: 'All **three** checks pass.' } }, 'sess-2');
  await expect.poll(notifications.shown).toEqual([
    expect.objectContaining({ title: 'Sparkle finished', body: 'All three checks pass.', tag: 'done:sess-2' }),
  ]);
  expect((await notifications.shown())[0].icon).toMatch(/^data:image\/png/);
  await expect(page).toHaveTitle('(1) Octipus');
  await expect(icon).toHaveAttribute('data-companion', 'done');

  gateway.event('permission.request', { requestId: 'r1', toolId: 'shell', action: 'execute', toolName: 'shell', args: {} }, 'sess-2');
  await expect.poll(async () => (await notifications.shown()).at(-1)).toEqual(expect.objectContaining({ title: 'Sparkle needs your input', body: 'Wants to use shell.' }));
  await expect(icon).toHaveAttribute('data-companion', 'waiting');
  await expect(page).toHaveTitle('(2) Octipus');

  // Answered elsewhere: the companion is calm again and the brand icons return.
  gateway.event('permission.resolved', { requestId: 'r1', status: 'approved' }, 'sess-2');
  await expect(page.locator('link[rel="icon"][data-companion]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('link[rel="icon"]')).not.toHaveCount(0);

  await notifications.click(0);
  await expect(page).toHaveURL(/\/chat\?session=sess-2/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chat_active_session'))).toBe('sess-2');
});

test('the conversation on screen does not notify; another one does', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  const notifications = await stubNotifications(page);
  await enableNotifications(page);
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  await page.bringToFront();

  gateway.event('chat.response', { response: { response: 'Shown right here.' } }, 'sess-1');
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: 'Shown right here.' })).toBeVisible();
  gateway.event('chat.error', { error: 'Provider timed out' }, 'sess-2');
  await expect.poll(notifications.shown).toEqual([expect.objectContaining({ title: 'Sparkle hit a problem', body: 'Provider timed out' })]);
  await expect(page).toHaveTitle('Octipus');
});

test('presence settings ask for permission, send a test, and remember choices', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  const notifications = await stubNotifications(page, { initial: 'default' });
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.goto('/persona');
  const card = page.locator('[aria-labelledby="companion-presence-title"]');
  await expect(card.getByTestId('presence-now')).toContainText('Sparkle is ready');

  const toggle = card.getByRole('checkbox', { name: 'System notifications' });
  await expect(toggle).not.toBeChecked();
  await expect(card.getByRole('button', { name: 'Send a test notification' })).toBeDisabled();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await card.getByRole('button', { name: 'Send a test notification' }).click();
  await expect.poll(notifications.shown).toEqual([expect.objectContaining({ title: 'Sparkle says hello' })]);
  await card.screenshot({ path: '/tmp/octipus-companion-presence.png' });

  await card.getByRole('checkbox', { name: 'Something went wrong' }).uncheck();
  await page.reload();
  await expect(card.getByRole('checkbox', { name: 'System notifications' })).toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'Something went wrong' })).not.toBeChecked();
  await expect(card.getByRole('checkbox', { name: 'Work is done' })).toBeChecked();
});

test('blocked notifications explain how to fix it', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  await page.addInitScript(() => {
    class Blocked { static permission = 'denied'; static async requestPermission() { return 'denied'; } }
    Object.defineProperty(window, 'Notification', { value: Blocked, configurable: true });
  });
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.goto('/persona');
  const card = page.locator('[aria-labelledby="companion-presence-title"]');
  await card.getByRole('checkbox', { name: 'System notifications' }).click();
  await expect(card.getByRole('alert')).toContainText('blocked for this site');
  await expect(card.getByRole('checkbox', { name: 'System notifications' })).not.toBeChecked();
});

test('settings keep a static status thumbnail without recurring icon updates', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.route('**/api/persona', route => json(route, 200, persona));
  await page.goto('/settings');
  await expect.poll(() => gateway.subscribed()).toBe(1);

  gateway.event('rootAgent.status', { message: 'Reading the repo' }, 'sess-2');
  const icon = page.locator('link[rel="icon"][data-companion]');
  await expect(icon).toHaveAttribute('data-companion', 'working');
  await expect(icon).toHaveAttribute('href', /^data:image\/png;base64,/);
  const updates = await icon.evaluate(async link => {
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(link, { attributes: true, attributeFilter: ['href'] });
    await new Promise(resolve => setTimeout(resolve, 1200));
    observer.disconnect();
    return count;
  });
  expect(updates).toBe(0);

  gateway.event('permission.request', { requestId: 'static-r1', toolId: 'shell', action: 'execute', toolName: 'shell', args: {} }, 'sess-2');
  await expect(icon).toHaveAttribute('data-companion', 'waiting');
  await expect(icon).toHaveAttribute('href', /^data:image\/png;base64,/);
  await page.goto('/persona');
  await expect(page.getByTestId('presence-now').locator('.octi-companion')).toHaveAttribute('data-motion', 'off');
});
