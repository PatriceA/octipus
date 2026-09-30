import type { Route, WebSocketRoute } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test('midrun messages appear once, survive reload and keep the active turn running', async ({ authenticatedPage: page }) => {
  let socket: WebSocketRoute | undefined;
  let persisted: any[] = [];
  await page.routeWebSocket(/\/ws\?/, ws => { socket = ws; });
  await page.route('**/api/sessions/sess-1/messages**', route => json(route, 200, { messages: persisted }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => Boolean(socket)).toBe(true);
  const input = page.getByPlaceholder(/send a message/i).first();
  await input.fill('Investigate the regression');
  await input.press('Enter');
  await expect(page.getByText('Thinking...', { exact: true })).toBeVisible();
  const createdAt = new Date().toISOString();
  const update = { type: 'turn_event', event: 'status_update', sessionId: 'sess-1',
    data: { message: 'Found the cause; verifying the fix.', messageId: 'progress-1', createdAt } };
  socket!.send(JSON.stringify(update));
  socket!.send(JSON.stringify(update));
  await expect(page.getByText(update.data.message, { exact: true })).toHaveCount(1);
  await expect(page.getByText('Thinking...', { exact: true })).toBeVisible();
  persisted = [{ id: 'progress-1', role: 'assistant', content: update.data.message, createdAt, metadata: { kind: 'progress' } }];
  socket!.send(JSON.stringify({ type: 'chat_response', sessionId: 'sess-1', response: 'Fixed and tested.' }));
  await expect(page.getByText('Fixed and tested.', { exact: true })).toHaveCount(1);
  await page.reload();
  await selectChatSession(page, 'sess-1');
  await expect(page.getByText(update.data.message, { exact: true })).toHaveCount(1);
});

test('a pasted image is uploaded, referenced in the turn, and survives history reload', async ({ authenticatedPage: page }) => {
  let socket: WebSocketRoute | undefined;
  let sent: any;
  let persisted: any[] = [];
  await page.routeWebSocket(/\/ws\?/, ws => { socket = ws; ws.onMessage(raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'chat') sent = message;
  }); });
  await page.route('**/api/sessions/sess-1/messages**', route => json(route, 200, { messages: persisted }));
  await page.route('**/api/sessions/sess-1/attachments', async route => {
    expect(route.request().headers()['content-type']).toContain('multipart/form-data');
    expect(route.request().postDataBuffer()!.includes(Buffer.from('paste.png'))).toBe(true);
    return json(route, 200, { uploaded: [{ path: '.octipus/attachments/upload/paste.png', name: 'paste.png' }] });
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => Boolean(socket)).toBe(true);
  const input = page.getByPlaceholder(/send a message/i).first();
  await input.fill('Read this image');
  await input.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'paste.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByText('paste.png', { exact: true })).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => sent?.type).toBe('chat');
  expect(sent.fileRefs).toEqual([{ path: '.octipus/attachments/upload/paste.png' }]);
  expect(sent.content).toContain('Read this image');
  expect(sent.content).toContain('Attached file: .octipus/attachments/upload/paste.png');
  persisted = [{ id: 'persisted-image-message', role: 'user', content: sent.content, createdAt: new Date().toISOString() }];
  await page.reload();
  await selectChatSession(page, 'sess-1');
  await expect(page.getByText(/Attached file: .octipus\/attachments\/upload\/paste.png/)).toBeVisible();
});

test('stale refresh cannot erase a live answer while activity history is loading', async ({ authenticatedPage: page }) => {
  let socket: WebSocketRoute | undefined;
  const held: Route[] = [];
  let hold = false;
  await page.routeWebSocket(/\/ws\?/, ws => { socket = ws; });
  await page.route('**/api/sessions/sess-1/messages**', route => hold ? void held.push(route) : json(route, 200, { messages: [] }));
  // Before navigation, so the page's refresh timer is created on the fake
  // clock; installed later, a timer already scheduled on the real clock can
  // miss the fast-forward and the held refresh never starts.
  await page.clock.install();
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => Boolean(socket)).toBe(true);
  hold = true;
  await page.clock.fastForward(10_000);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  socket!.send(JSON.stringify({ type: 'chat_response', sessionId: 'sess-1', response: 'This answer must stay visible.' }));
  await expect(page.getByText('This answer must stay visible.')).toBeVisible();
  hold = false;
  for (const route of held) await json(route, 200, { messages: [] });
  await page.clock.fastForward(10_000);
  await expect(page.getByText('This answer must stay visible.')).toBeVisible();
});

test('rate-limited history pauses requests, keeps messages and shows an inline explanation', async ({ authenticatedPage: page }) => {
  let requests = 0;
  let limited = false;
  const messages = [{ id: 'kept', role: 'assistant', content: 'Previously loaded answer', createdAt: new Date().toISOString() }];
  await page.routeWebSocket(/\/ws\?/, () => {});
  await page.route('**/api/sessions/sess-1/messages**', route => {
    requests++;
    return limited ? route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '30' }, body: JSON.stringify({ error: 'Too many requests. Please try again later.' }) })
      : json(route, 200, { messages });
  });
  await page.clock.install();
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect(page.getByText('Previously loaded answer', { exact: true })).toBeVisible();
  limited = true;
  await page.clock.fastForward(10_000);
  const status = page.getByTestId('chat-sync-status');
  await expect(status).toContainText('Your agent continues working');
  expect(await status.evaluate(el => getComputedStyle(el).position)).toBe('static');
  await expect(status.getByRole('button')).toBeDisabled();
  const before = requests;
  await page.clock.fastForward(20_000);
  expect(requests).toBe(before);
  await expect(page.getByText('Previously loaded answer', { exact: true })).toBeVisible();
  limited = false;
  await page.clock.fastForward(10_000);
  await expect(status).toHaveCount(0);
  expect(requests).toBeGreaterThan(before);
});

test('chat bounds event backfill and stops polling completed agents', async ({ authenticatedPage: page }) => {
  test.setTimeout(60_000);
  const counts = new Map<string, number>();
  let messageRequests = 0;
  const agents = Array.from({ length: 8 }, (_, i) => ({ id: `old-${i}`, sessionId: 'sess-1', role: 'coding', model: 'test', status: 'completed',
    createdAt: new Date(2026, 8, 29, 12, i).toISOString(), completedAt: new Date(2026, 8, 29, 12, i + 1).toISOString(), iteration: 1 }));
  await page.routeWebSocket(/\/ws\?/, () => {});
  await page.route('**/api/sessions/sess-1/messages**', route => { messageRequests++; return json(route, 200, { messages: [] }); });
  await page.route('**/api/agents?sessionId=sess-1', route => json(route, 200, { agents }));
  await page.route('**/api/agents/*/events?**', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    counts.set(id, (counts.get(id) ?? 0) + 1);
    return json(route, 200, { events: [], nextCursor: 0, hasMore: false });
  });
  await page.clock.install();
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => counts.size).toBe(4);
  await page.clock.runFor(200);
  expect([...counts.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(messageRequests * 4);
  for (let i = 0; i < 5; i++) {
    await page.clock.fastForward(10_000);
    await expect.poll(() => messageRequests).toBeGreaterThan(i + 1);
    await expect.poll(() => [...counts.values()].reduce((a, b) => a + b, 0)).toBe(Math.min(16, (i + 2) * 4));
    await page.clock.runFor(200);
  }
  await expect.poll(() => [...counts.values()].reduce((a, b) => a + b, 0)).toBe(16);
  await page.clock.fastForward(20_000);
  expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(16);
});
