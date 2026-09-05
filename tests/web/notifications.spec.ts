import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

const rows = [
  {
    id: 'n1', type: 'agent_complete', title: 'Agent "coding" completed', body: 'Wrote the migration.',
    metadata: { workerId: 'w-1', role: 'coding' }, read: false, createdAt: new Date().toISOString(),
  },
  {
    id: 'n2', type: 'pipeline_error', title: 'Pipeline "Bug Fix" failed', body: 'Failed at stage "Verify"',
    metadata: { pipelineId: 'p-1' }, read: false, createdAt: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    id: 'n3', type: 'approval_required', title: 'Approval Required', body: 'Delete the branch?',
    metadata: { requestId: 'r-1' }, read: true, createdAt: new Date(Date.now() - 86400_000).toISOString(),
  },
];

test.describe('notifications inbox', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    // Playwright matches routes newest-first: the list stub goes FIRST so the
    // two POST stubs below take precedence over it.
    await page.route('**/api/notifications**', (route) => {
      const url = new URL(route.request().url());
      const unread = url.searchParams.get('unread') === '1';
      const type = url.searchParams.get('type');
      const list = rows.filter((r) => (!unread || !r.read) && (!type || r.type.startsWith(type)));
      return json(route, 200, { notifications: list, unreadCount: rows.filter((r) => !r.read).length });
    });
    await page.route('**/api/notifications/*/read', (route) => json(route, 200, { success: true }));
    await page.route('**/api/notifications/read-all', (route) => json(route, 200, { success: true }));
  });

  test('shows unread by default, with links to what happened', async ({ authenticatedPage: page }) => {
    await page.goto('/notifications');
    await expect(page.getByText('Agent "coding" completed')).toBeVisible();
    await expect(page.getByText('Pipeline "Bug Fix" failed')).toBeVisible();
    // Read rows are hidden under the default "unread" filter.
    await expect(page.getByText('Approval Required')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /open agent/ })).toHaveAttribute('href', '/agents/view?id=w-1');
  });

  test('"all" reveals read rows; marking one read removes it from unread', async ({ authenticatedPage: page }) => {
    await page.goto('/notifications');
    await page.getByRole('button', { name: /^all$/ }).click();
    await expect(page.getByText('Approval Required')).toBeVisible();
    // The type tabs filter server-side: only the matching row is requested.
    const approvalsReq = page.waitForRequest((req) => req.url().includes('/api/notifications?') && req.url().includes('type=approval'));
    await page.getByRole('button', { name: /^approvals$/ }).click();
    await approvalsReq;
    await expect(page.getByText('Agent "coding" completed')).toHaveCount(0);
    await expect(page.getByText('Approval Required')).toBeVisible();

    await page.getByRole('button', { name: /^unread/ }).click();
    const marked = page.waitForRequest((req) => req.url().includes('/api/notifications/n1/read') && req.method() === 'POST');
    await page.locator('[data-testid="notification-row"]', { hasText: 'Agent "coding" completed' }).getByRole('button', { name: /mark read/ }).click();
    await marked;
    await expect(page.getByText('Agent "coding" completed')).toHaveCount(0);
  });

  test('a 200 that says success:false is surfaced, not swallowed', async ({ authenticatedPage: page }) => {
    await page.route('**/api/notifications/*/read', (route) => json(route, 200, { success: false }));
    await page.goto('/notifications');
    await page.locator('[data-testid="notification-row"]', { hasText: 'Agent "coding" completed' }).getByRole('button', { name: /mark read/ }).click();
    await expect(page.getByText('Notification not found')).toBeVisible();
  });

  test('mark all read empties the unread view', async ({ authenticatedPage: page }) => {
    await page.goto('/notifications');
    const all = page.waitForRequest((req) => req.url().includes('/api/notifications/read-all'));
    await page.getByRole('button', { name: /mark all read/ }).click();
    await all;
    await expect(page.getByText(/caught up/)).toBeVisible();
  });

  test('sidebar links to the inbox', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await Promise.all([page.waitForURL(/\/notifications/), page.getByRole('link', { name: /inbox/i }).first().click()]);
  });
});
