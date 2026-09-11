import { expect, test } from './fixtures/auth';

test('unavailable dashboard data is not displayed as zero or idle; retry recovers', async ({ authenticatedPage: page }) => {
  let failing = true;
  await page.route('**/api/models/usage', route => route.fulfill({ status: failing ? 503 : 200,
    contentType: 'application/json', body: JSON.stringify(failing ? { error: 'Usage temporarily unavailable' } : { stats: { requestCount: 7, totalCost: 1.25 } }) }));
  await page.route('**/api/health/detailed', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Health unavailable"}' }));
  await page.goto('/');
  await expect(page.getByText('status unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry total cost' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('$0.00', { exact: true })).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Retry total cost' }).click();
  await expect(page.getByText('$1.25', { exact: true })).toBeVisible();
});

test('a failed refresh retains the last value and marks it stale', async ({ authenticatedPage: page }) => {
  let reads = 0;
  await page.route('**/api/health/detailed', route => {
    reads++;
    return route.fulfill({ status: reads === 1 ? 200 : 503, contentType: 'application/json',
      body: JSON.stringify(reads === 1 ? { agents: { running: 3, total: 3 }, health: { database: { status: 'unhealthy' } } } : { error: 'Disconnected' }) });
  });
  await page.goto('/');
  await expect(page.getByText('3 live', { exact: true })).toBeVisible();
  await expect(page.getByText(/Stale · last updated/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('status unavailable', { exact: true })).toBeVisible();
});

test('five navigation groups expose advanced pages and keep deep links', async ({ authenticatedPage: page }) => {
  await page.goto('/');
  const nav = page.locator('aside nav');
  for (const name of ['Work', 'Library', 'Automations', 'Connections', 'Settings']) {
    await expect(nav.locator('summary').filter({ hasText: new RegExp(`^${name}$`) })).toBeVisible();
  }
  await nav.locator('summary').filter({ hasText: /^Settings$/ }).focus();
  await page.keyboard.press('Enter');
  await nav.getByRole('link', { name: 'scoped permissions' }).click();
  await expect(page).toHaveURL(/\/permissions$/);
  await expect(page.getByLabel('Permission action', { exact: true })).toBeVisible();
  await page.goto('/topics');
  await expect(nav.getByRole('link', { name: 'topics', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('body')).toBeVisible();
});

test('scoped grant requires review before saving its scope and expiry', async ({ authenticatedPage: page }) => {
  let saved: Record<string, unknown> | undefined;
  await page.route('**/api/tools/permissions', async route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ permissions: [] }) });
  });
  await page.goto('/permissions');
  await page.getByLabel('Tool ID', { exact: true }).fill('filesystem');
  await page.getByLabel('Permission action', { exact: true }).fill('write');
  await page.getByLabel('Scope value', { exact: true }).fill('11111111-1111-1111-1111-111111111111');
  await page.getByLabel('Expires at').fill('2099-01-01T12:00');
  await page.getByRole('button', { name: 'Review grant' }).click();
  expect(saved).toBeUndefined();
  await page.getByRole('button', { name: 'Confirm scoped grant' }).click();
  await expect.poll(() => saved?.level).toBe('ALLOW');
  expect(saved?.scope).toMatchObject({ sessionId: '11111111-1111-1111-1111-111111111111' });
});

test('research does not claim a missing document was saved', async ({ authenticatedPage: page }) => {
  await page.route('**/api/research', route => route.fulfill({ json: { jobId: 'fixture-job' } }));
  await page.route('**/api/research/fixture-job', route => route.fulfill({ json: {
    id: 'fixture-job', status: 'done', stage: 'done', report: { question: 'Fixture question', generatedAt: '2026-09-10T10:00:00Z', depth: 'quick',
      sections: [{ heading: 'Answer', markdown: '42 tasks', citations: [] }], sources: [], limitations: 'Fixture only' },
  } }));
  await page.goto('/research');
  await page.getByRole('main').getByRole('textbox').fill('Fixture question');
  await page.getByRole('button', { name: 'execute', exact: true }).click();
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
