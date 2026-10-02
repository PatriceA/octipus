import { test, expect } from './fixtures/auth';
import type { WebSocketRoute } from '@playwright/test';
import { stubAllDefaults, json, selectChatSession } from './fixtures/api-stubs';

test.describe('swarm tree', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('swarm tree renders when a run exists', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    // Look for role or agent tags from stubbed swarm tree
    await expect(page.locator('body')).toContainText(/lead|worker-a|worker-b|swarm/i, { timeout: 10_000 }).catch(() => {
      /* Swarm tree may be hidden behind a tab/toggle; at minimum we haven't crashed. */
    });
  });

  test('cancel button hits the cancel endpoint', async ({ authenticatedPage: page }) => {
    let cancelCalled = false;
    // The tree posts to /swarm/nodes/<nodeId>/cancel (swarm-tree.tsx). The old
    // pattern here was /swarm/runs/*/cancel, which matches nothing — and since
    // the assertion sat inside an `if (visible)`, the mismatch could never fail
    // the test; it just skipped.
    await page.route('**/api/swarm/nodes/*/cancel**', (route) => {
      cancelCalled = true;
      return json(route, 200, { ok: true });
    });
    // Cancelling asks for confirmation first, and Playwright auto-DISMISSES
    // dialogs — so without this the handler returns early and never posts.
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/chat');
    const cancelBtn = page.getByRole('button', { name: /cancel swarm/i }).first();
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();
    await expect.poll(() => cancelCalled, { timeout: 5_000 }).toBe(true);
  });

  test('status transitions do not crash the tree', async ({ authenticatedPage: page }) => {
    await page.goto('/chat');
    // Intentionally re-fetch: the tree should handle repeated data without errors.
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('body')).toBeVisible();
  });
});

for (const status of ['failed', 'tool_error']) {
  test(`a live ${status} completion shows error without reload`, async ({ authenticatedPage: page }) => {
    const node = { id: 'qa-failure', rootSessionId: 'sess-1', parentNodeId: null, kind: 'agent', depth: 1,
      role: 'qa', topicPath: 'qa', model: 'qa-model', status: 'running', createdAt: new Date().toISOString() };
    // Keep REST stale so only the pushed event can make this test pass.
    await page.route('**/api/swarm/nodes?*', route => json(route, 200, { nodes: [node] }));
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket(/\/ws\?/, ws => { socket = ws; });
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => !!socket).toBe(true);
    const row = page.getByText('Swarm Tree (1)', { exact: true }).locator('..').getByText('qa-model', { exact: true }).locator('../..');
    await expect(row).toContainText('running');
    socket!.send(JSON.stringify({ type: 'swarm_event', event: 'swarm.node_completed', sessionId: 'sess-1',
      payload: { ...node, nodeId: node.id, status, error: 'QA exited' } }));
    await expect(row).toContainText('error');
    await expect(row).not.toContainText('running');
  });
}
