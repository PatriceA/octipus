import type { Route, WebSocketRoute } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

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
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => Boolean(socket)).toBe(true);
  await page.clock.install();
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
