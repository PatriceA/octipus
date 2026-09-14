import type { WebSocketRoute } from '@playwright/test';
import { test, expect } from './fixtures/auth';

test('permissions resolved elsewhere disappear and reconnect snapshots replace stale entries', async ({ authenticatedPage: page }) => {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/permissions/, ws => { socket = ws; });
  await page.goto('/settings');
  await expect.poll(() => !!socket).toBe(true);
  const request = (id: string) => ({ id, toolId: 'shell', action: 'execute' });
  socket!.send(JSON.stringify({ type: 'pending_requests', requests: [request('a'), request('b'), request('c')] }));
  await expect(page.getByText('3 pending', { exact: true })).toBeVisible();
  socket!.send(JSON.stringify({ type: 'response_recorded', requestId: 'b', status: 'approved' }));
  await expect(page.getByText('2 pending', { exact: true })).toBeVisible();
  socket!.send(JSON.stringify({ type: 'permission_request', requestId: 'b', toolId: 'shell', action: 'execute' }));
  socket!.send(JSON.stringify({ type: 'pending_requests', requests: [request('a'), request('b'), request('c')] }));
  await expect(page.getByText('3 pending', { exact: true })).toHaveCount(0);

  socket!.send(JSON.stringify({ type: 'response_recorded', requestId: 'a', status: 'denied' }));
  socket!.send(JSON.stringify({ type: 'response_recorded', requestId: 'c', status: 'expired' }));
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(0);
  socket!.send(JSON.stringify({ type: 'pending_requests', requests: [request('d'), request('e')] }));
  await expect(page.getByText('2 pending', { exact: true })).toBeVisible();
  socket!.send(JSON.stringify({ type: 'pending_requests', requests: [] }));
  await expect(page.getByText('2 pending', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(0);
});
