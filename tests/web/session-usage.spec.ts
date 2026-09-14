import type { Route, WebSocketRoute } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const stats = { requestCount: 2, totalCost: 0.125, totalInputTokens: 100, totalOutputTokens: 20 };

test('session usage keeps its row and last totals during failed refreshes', async ({ authenticatedPage: page }) => {
  await page.clock.install();
  await page.route('**/ws**', route => route.abort());
  let requests = 0;
  let pending: Route | undefined;
  await page.route('**/api/models/usage/session/*', route => {
    requests++;
    if (requests === 2) { pending = route; return; }
    return json(route, 500, { error: 'Usage temporarily unavailable' });
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  const usage = page.getByTestId('session-usage');
  await expect(usage).toContainText('Session usage unavailable');
  await expect(page.locator('.workspace-conversation').getByTestId('session-usage')).toBeVisible();
  const before = await page.locator('.workspace-conversation').boundingBox();

  await page.clock.fastForward(15_001);
  await expect.poll(() => requests).toBe(2);
  await expect(usage).toContainText('Session usage unavailable');
  await expect(usage.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  const during = await page.locator('.workspace-conversation').boundingBox();
  expect(during?.x).toBe(before?.x);
  expect(during?.width).toBe(before?.width);

  await json(pending!, 200, { stats });
  await expect(usage).toContainText('Session cost $0.1250');
  await page.clock.fastForward(15_001);
  await expect(usage).toContainText('update unavailable');
  await expect(usage).toContainText('Session cost $0.1250');
  await usage.locator('summary').click();
  await expect(usage).toContainText('Showing the last recorded usage.');
});

test('switching sessions does not reuse another session usage totals', async ({ authenticatedPage: page }) => {
  await page.route('**/ws**', route => route.abort());
  await page.route('**/api/models/usage/session/*', route => route.request().url().endsWith('/sess-1')
    ? json(route, 200, { stats })
    : json(route, 500, { error: 'Unavailable' }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect(page.getByTestId('session-usage')).toContainText('Session cost $0.1250');
  await selectChatSession(page, 'sess-2');
  await expect(page.getByTestId('session-usage')).toContainText('Session usage unavailable');
  await expect(page.getByTestId('session-usage')).not.toContainText('$0.1250');
});

test('a delayed swarm snapshot preserves a child that arrived over the socket', async ({ authenticatedPage: page }) => {
  const root = { id: 'root-1', rootSessionId: 'sess-1', parentNodeId: null, kind: 'root', depth: 0,
    role: 'general', topicPath: 'root', model: 'root-model', status: 'running', tokenCap: 1000,
    tokensUsed: 0, createdAt: new Date().toISOString() };
  let hydration: Route | undefined;
  await page.route('**/api/swarm/nodes?*', route => { hydration = route; });
  await page.route('**/api/models/usage/session/*', route => json(route, 200, { stats }));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\?/, ws => { socket = ws; });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => !!socket && !!hydration).toBe(true);
  socket!.send(JSON.stringify({ type: 'swarm_event', event: 'swarm.node_spawned', sessionId: 'sess-1',
    payload: { ...root, nodeId: root.id } }));
  socket!.send(JSON.stringify({ type: 'swarm_event', event: 'swarm.node_spawned', sessionId: 'sess-1',
    payload: { rootSessionId: 'sess-1', nodeId: 'child-1', parentNodeId: root.id, kind: 'agent', depth: 1,
      role: 'research', topicPath: 'root/research', model: 'child-model', status: 'running' } }));
  await expect(page.getByText('active agents', { exact: true }).locator('..')).toContainText('1');
  await json(hydration!, 200, { nodes: [root] });
  await expect(page.getByText('Swarm Tree (2)', { exact: true })).toBeVisible();
  await expect(page.getByText('child-model', { exact: true }).first()).toBeVisible();
});
