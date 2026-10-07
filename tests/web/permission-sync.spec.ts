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

test('CLI questions show all choices and submit answers instead of permission', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  gateway.setPending({ requests: [{ requestId: 'questions', toolId: 'cli-native:AskUserQuestion', action: 'AskUserQuestion', toolName: 'CLI: AskUserQuestion', args: {
    questions: [
      { header: 'Rate limit', question: 'How should the suite handle the limit?', multiSelect: false, options: [
        { label: 'Lift during run', description: 'Restarts the pod twice and affects real users.' },
        { label: 'Measure as-is', description: 'Count the 429 responses.' },
      ] },
      { header: 'Model swap', question: 'How should the run switch models?', multiSelect: true, options: [
        { label: 'Manual', description: 'Switch it yourself.' }, { label: 'Test header', description: 'Requires a deploy.' },
      ] },
    ],
  } }] });
  await page.goto('/settings');
  await expect(page.getByText('How should the suite handle the limit?', { exact: false })).toBeVisible();
  await expect(page.getByText('Restarts the pod twice and affects real users.')).toBeVisible();
  await expect(page.getByText('How should the run switch models?', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit answers' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^allow$/i })).toHaveCount(0);
  await page.getByRole('radio', { name: /Measure as-is/ }).check();
  await page.getByRole('checkbox', { name: /Manual/ }).check();
  await page.getByRole('checkbox', { name: /Test header/ }).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect.poll(() => gateway.sent.find(m => m.type === 'permission.respond')).toEqual({
    type: 'permission.respond', requestId: 'questions', approved: true,
    resolution: JSON.stringify({ 'How should the suite handle the limit?': 'Measure as-is', 'How should the run switch models?': 'Manual, Test header' }),
  });
  gateway.event('permission.resolved', { requestId: 'questions', status: 'approved' });
  await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(0);
});

test('recovery warning is readable without expanding details', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  gateway.setPending({ requests: [{ requestId: 'recovery', toolId: 'action_recovery', action: 'retry', toolName: 'Review', args: {
    warning: 'This is not a request for more retries.', previousActions: 'Earlier write outcome unknown.',
  } }] });
  await page.goto('/settings');
  await expect(page.getByText('Review uncertain outcome', { exact: true })).toBeVisible();
  await expect(page.getByText('This is not a request for more retries.', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier write outcome unknown.', { exact: true })).toBeVisible();
});

test('CLI custom answers work on a narrow screen and cancellation does not submit them', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const gateway = await stubGateway(page);
  gateway.setPending({ requests: [{ requestId: 'custom', toolId: 'cli-native:AskUserQuestion', action: 'AskUserQuestion', toolName: 'CLI: AskUserQuestion', args: {
    questions: [{ question: 'Which limit?', options: [{ label: 'Unlimited', description: 'Turns the limit off for everyone.' }] }],
  } }] });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Unlimited/ }).check();
  await page.getByRole('textbox', { name: 'Your own answer' }).fill('Use a separate test tenant');
  await expect(page.getByRole('radio', { name: /Unlimited/ })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Submit answers' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel questions' }).click();
  await expect.poll(() => gateway.sent.find(m => m.type === 'permission.respond')).toEqual({
    type: 'permission.respond', requestId: 'custom', approved: false,
  });
});
