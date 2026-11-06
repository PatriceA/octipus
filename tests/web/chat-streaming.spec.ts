import { test, expect } from './fixtures/auth';
import { json, selectChatSession } from './fixtures/api-stubs';
import { stubGateway } from './fixtures/gateway';

test('session list reads recover after a cooldown without reloading the page', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  let reads = 0;
  await page.route('**/api/sessions', route => {
    if (++reads === 1) return route.fulfill({ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' }, body: JSON.stringify({ error: 'Too many requests', retryAfter: 1 }) });
    return json(route, 200, { sessions: [{ id: 'recovered-session', title: 'Recovered project', status: 'active', updatedAt: new Date().toISOString(), messageCount: 0 }] });
  });
  await page.goto('/chat');
  await expect(page.locator('[data-session-id="recovered-session"]')).toBeVisible();
  expect(reads).toBeGreaterThan(1);
  expect(reads).toBeLessThanOrEqual(3);
});

for (const companion of [false, true]) test(`${companion ? 'Companion' : 'ordinary session'} replies keep their styled message bubble while streaming`, async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.route('**/api/companion/settings', route => json(route, 200, { supervisorSessionId: companion ? 'sess-1' : null, modelName: 'Test supervisor', enabled: true }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
  const input = page.getByPlaceholder(companion ? 'Plan work, check progress, or park an idea...' : 'Send a message or change direction...');
  await input.fill('Check progress');
  await input.press('Enter');
  await expect.poll(() => gateway.sent.some(message => message.type === 'chat.send' && message.sessionId === 'sess-1')).toBe(true);

  const start = '# Current status\n\n**Build passed**.\n\n- Check';
  const rest = ' the phone\n- Deploy relay\n\n```sh\necho ready\nprintf done\n```';
  gateway.event('chat.delta', { agentId: 'stream-root', iteration: 0, delta: start }, 'sess-1');
  const streaming = page.locator('[data-role="assistant"][data-streaming]');
  const body = streaming.getByTestId('assistant-message-body');
  await expect(body.getByRole('heading', { name: 'Current status' })).toBeVisible();
  await expect(body.locator('strong')).toHaveText('Build passed');
  gateway.event('chat.delta', { agentId: 'stream-root', iteration: 0, delta: rest }, 'sess-1');
  await expect(body.getByRole('listitem')).toHaveCount(2);
  await expect(body.locator('pre code')).toContainText('echo ready');
  const styles = await body.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.border, radius: style.borderRadius, padding: style.padding, x: element.getBoundingClientRect().x };
  });
  expect(styles.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(styles.border).not.toContain('0px');

  gateway.event('chat.response', { response: { response: start + rest } }, 'sess-1');
  await expect(streaming).toHaveCount(0);
  const complete = page.locator('[data-role="assistant"]').filter({ has: page.getByRole('heading', { name: 'Current status' }) }).getByTestId('assistant-message-body');
  await expect(complete.getByRole('heading', { name: 'Current status' })).toBeVisible();
  await expect(complete.locator('strong')).toHaveText('Build passed');
  expect(await complete.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.border, radius: style.borderRadius, padding: style.padding, x: element.getBoundingClientRect().x };
  })).toEqual(styles);
});
