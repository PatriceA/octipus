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

test('research does not claim a missing document was saved', async ({ authenticatedPage: page }) => {
  await page.route('**/api/research', route => route.fulfill({ json: { jobId: 'fixture-job' } }));
  await page.route('**/api/research/fixture-job', route => route.fulfill({ json: {
    id: 'fixture-job', status: 'done', stage: 'done', report: { question: 'Fixture question', generatedAt: '2026-09-10T10:00:00Z', depth: 'quick',
      sections: [{ heading: 'Answer', markdown: '42 tasks', citations: [] }], sources: [], limitations: 'Fixture only' },
  } }));
  await page.goto('/research');
  await page.getByRole('main').getByRole('textbox').fill('Fixture question');
  await page.getByRole('button', { name: 'Start research', exact: true }).click();
  await expect(page.getByText('Report available here, but no saved document was confirmed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Saved to Documents' })).toHaveCount(0);
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
