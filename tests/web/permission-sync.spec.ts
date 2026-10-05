import { test, expect } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

const request = (requestId: string) => ({ requestId, toolId: 'shell', action: 'execute', toolName: 'shell', args: {} });

test('permissions resolved elsewhere disappear and reconnect snapshots replace stale entries', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  gateway.setPending({ requests: [request('a'), request('b'), request('c')] });
  await page.goto('/settings');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  await expect(page.getByText('3 pending', { exact: true })).toBeVisible();
  gateway.event('permission.resolved', { requestId: 'b', status: 'approved' });
  await expect(page.getByText('2 pending', { exact: true })).toBeVisible();
  // A late duplicate of a resolved request, and a snapshot that still lists
  // it, do not bring it back.
  gateway.event('permission.request', request('b'));
  gateway.send({ type: 'permission.pending', requests: [request('a'), request('b'), request('c')], approvals: [] });
  await expect(page.getByText('3 pending', { exact: true })).toHaveCount(0);

  gateway.event('permission.resolved', { requestId: 'a', status: 'denied' });
  gateway.event('permission.resolved', { requestId: 'c', status: 'expired' });
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(0);
  gateway.send({ type: 'permission.pending', requests: [request('d'), request('e')], approvals: [] });
  await expect(page.getByText('2 pending', { exact: true })).toBeVisible();
  gateway.send({ type: 'permission.pending', requests: [], approvals: [] });
  await expect(page.getByText('2 pending', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(0);
});

test('answering a prompt goes over the gateway; the resolution removes it', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  gateway.setPending({ requests: [request('only')] });
  await page.goto('/settings');
  await page.getByRole('button', { name: /^allow$/i }).click();
  await expect.poll(() => gateway.sent.find((m) => m.type === 'permission.respond')).toEqual({ type: 'permission.respond', requestId: 'only', approved: true });
  // The row stays until the server says it is resolved.
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(1);
  gateway.event('permission.resolved', { requestId: 'only', status: 'approved' });
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(0);
});

test('a tab opened after a permission request was raised shows it', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page.context());
  await page.goto('/settings');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  // Raised while only the first tab is open: it hears it live.
  gateway.event('permission.request', request('late'));
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(1);

  // The server's list now holds it; a new tab gets it in its snapshot.
  gateway.setPending({ requests: [request('late')] });
  const second = await page.context().newPage();
  await stubTab(second);
  await second.goto('/settings');
  await expect.poll(() => gateway.subscribed()).toBe(2);
  await expect(second.getByRole('button', { name: /^allow$/i })).toHaveCount(1);
});

/** The page-level stubs the auth fixture installs, for a second tab of the same context. */
async function stubTab(tab: import('@playwright/test').Page): Promise<void> {
  const { stubAllDefaults } = await import('./fixtures/api-stubs');
  const { STUB_USER } = await import('./fixtures/auth');
  await tab.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await tab.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB_USER) }));
  await stubAllDefaults(tab);
}
