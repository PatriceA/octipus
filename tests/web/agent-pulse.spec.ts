import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const at = (m: number) => new Date(2026, 10, 8, 10, m).toISOString();

test('the sidebar shows runs working now and approvals waiting on Mission control', async ({ authenticatedPage: page }) => {
  await page.route('**/api/agents/pulse', (route) => json(route, 200, { live: 3, pendingApprovals: 2 }));
  await page.goto('/agents');
  await page.locator('aside summary', { hasText: 'Automation' }).click();
  await expect(page.getByTestId('nav-live-agents')).toHaveText('3');
  await expect(page.getByTestId('nav-live-agents')).toHaveAttribute('aria-label', '3 working now');
  await expect(page.getByTestId('nav-needs-you')).toHaveText('2');
  // Folded, the Agents heading still says so.
  const heading = page.locator('summary', { hasText: 'Automation' });
  await heading.click();
  await expect(heading.getByLabel('3 working now')).toBeVisible();
  await expect(heading.getByLabel('2 waiting on you')).toBeVisible();
});

test('nothing running and nothing waiting shows no counter', async ({ authenticatedPage: page }) => {
  await page.route('**/api/agents/pulse', (route) => json(route, 200, { live: 0, pendingApprovals: 0 }));
  await page.goto('/agents');
  await page.locator('aside summary', { hasText: 'Automation' }).click();
  await expect(page.getByRole('link', { name: /mission control/ })).toBeVisible();
  await expect(page.getByTestId('nav-live-agents')).toHaveCount(0);
  await expect(page.getByTestId('nav-needs-you')).toHaveCount(0);
});

test('session header omits the repetitive spawned-agent strip', async ({ authenticatedPage: page }) => {
  const agents = [
    { id: 'root-1', sessionId: 'sess-1', role: 'general', root: true, model: 'm', status: 'completed', createdAt: at(0), completedAt: at(5), iteration: 2 },
    { id: 'w-done', sessionId: 'sess-1', role: 'research', model: 'm', status: 'completed', createdAt: at(1), completedAt: at(3), iteration: 3 },
    { id: 'w-live', sessionId: 'sess-1', role: 'coding', model: 'm', status: 'running', createdAt: at(2), iteration: 1 },
  ];
  await page.route('**/api/agents?sessionId=sess-1', (route) => json(route, 200, { agents }));
  await page.route('**/api/agents/*/events?**', (route) => json(route, 200, { events: [], nextCursor: 0, hasMore: false }));
  await page.route('**/api/sessions/sess-1/execution-environment', route => json(route, 200, {
    selectedEnvironmentId: 'host', projectPath: '/home/patrice/Github Rep/BPMN-editor',
    environment: { id: 'host', name: 'Workstation automation', backend: 'host', account: 'patrice', machine: 'patrice-AI-machine' },
    available: [{ id: 'host', name: 'Workstation automation', backend: 'host', roots: ['/home/patrice/Github Rep'] }],
  }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');

  await expect(page.getByTestId('current-session-title')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Spawned agents' })).toHaveCount(0);
  await expect(page.getByTestId('session-usage')).toBeVisible();
  await expect(page.getByRole('button', { name: /Skills/ })).toBeVisible();
  await expect(page.getByTestId('current-session-title')).toHaveCSS('font-size', '16px');
  await expect(page.getByTestId('session-usage')).toHaveCSS('font-family', await page.locator('.session-chat-header').evaluate(element => getComputedStyle(element).fontFamily));
  await page.screenshot({ path: '/tmp/octipus-session-header-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /Switch conversation:/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/octipus-session-header-mobile.png', fullPage: true });
});
