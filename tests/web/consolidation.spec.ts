import { expect, test } from './fixtures/auth';

const desk = () => ({ observedAt: new Date().toISOString(), total: 1, warnings: [], sessions: [{ id: 'sess-1', title: 'Current work', state: 'working', activity: 'Running release checks', outcome: null, next: null, updatedAt: new Date().toISOString(), plan: null, pipelineId: null, events: [] }] });
test('unavailable workspace status is not displayed as zero or idle; retry recovers', async ({ authenticatedPage: page }) => {
  let failing = true;
  await page.route('**/api/sessions/desk', route => route.fulfill({ status: failing ? 503 : 200, json: failing ? { error: 'Status unavailable' } : desk() }));
  await page.goto('/');
  await expect(page.getByText('Workspace status is unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('No active run', { exact: true })).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect Current work' })).toBeVisible();
});
test('failed refresh keeps the snapshot but marks its live state unconfirmed', async ({ authenticatedPage: page }) => {
  await page.clock.install();
  let failing = false;
  await page.route('**/api/sessions/desk', route => route.fulfill({ status: failing ? 503 : 200, json: failing ? { error: 'Disconnected' } : desk() }));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.desk-session .desk-state')).toHaveText('Working');
  failing = true;
  const response = page.waitForResponse(response => response.url().includes('/sessions/desk') && response.status() === 503);
  await page.clock.fastForward(30_000); await response;
  await expect(page.getByText(/Showing a saved snapshot/)).toBeVisible();
  await expect(page.locator('.desk-session .desk-state')).toHaveText('Status unconfirmed');
});
test('settings exposes advanced destinations and preserves direct links', async ({ authenticatedPage: page }) => {
  await page.goto('/settings');
  await page.getByRole('searchbox', { name: 'Find a setting' }).fill('permissions');
  await page.getByRole('link', { name: 'Permissions & exceptions', exact: true }).click();
  await expect(page).toHaveURL(/\/permissions$/);
  await expect(page.getByLabel('Permission action', { exact: true })).toBeVisible();
  await page.goto('/topics');
  await expect(page.getByRole('heading', { name: /topics/i }).first()).toBeVisible();
});

test('project discovery keeps partial results and exposes a retry', async ({ authenticatedPage: page }) => {
  await page.route('**/api/workspace', route => route.fulfill({ json: { rootPath: '/projects', additionalPaths: ['/denied'] } }));
  await page.route('**/api/tools/filesystem/tools/list_directory/execute', route => {
    const args = route.request().postDataJSON().args;
    return args.path === '/denied'
      ? route.fulfill({ status: 403, json: { error: 'Directory access denied' } })
      : route.fulfill({ json: { result: { entries: [{ name: 'good-project', isDirectory: true }] } } });
  });
  await page.goto('/chat');
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByRole('button', { name: /Development/ }).click();
  await expect(page.getByText('Project list may be incomplete.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry loading projects' })).toBeEnabled();
  await page.getByPlaceholder('Some projects could not be loaded').focus();
  await expect(page.getByText('good-project', { exact: true })).toBeVisible();
});
