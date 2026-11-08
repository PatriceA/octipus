import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const at = (m: number) => new Date(2026, 10, 8, 10, m).toISOString();

test('the sidebar shows runs working now and approvals waiting on Mission control', async ({ authenticatedPage: page }) => {
  await page.route('**/api/agents/pulse', (route) => json(route, 200, { live: 3, pendingApprovals: 2 }));
  await page.goto('/agents');
  await expect(page.getByTestId('nav-live-agents')).toHaveText('3');
  await expect(page.getByTestId('nav-live-agents')).toHaveAttribute('aria-label', '3 working now');
  await expect(page.getByTestId('nav-needs-you')).toHaveText('2');
  // Folded, the Agents heading still says so.
  const heading = page.locator('summary', { hasText: 'Agents' });
  await heading.click();
  await expect(heading.getByLabel('3 working now')).toBeVisible();
  await expect(heading.getByLabel('2 waiting on you')).toBeVisible();
});

test('nothing running and nothing waiting shows no counter', async ({ authenticatedPage: page }) => {
  await page.route('**/api/agents/pulse', (route) => json(route, 200, { live: 0, pendingApprovals: 0 }));
  await page.goto('/agents');
  await expect(page.getByRole('link', { name: /mission control/ })).toBeVisible();
  await expect(page.getByTestId('nav-live-agents')).toHaveCount(0);
  await expect(page.getByTestId('nav-needs-you')).toHaveCount(0);
});

test('the agents a session spawned sit at the top of the chat, working ones first, each opening its run', async ({ authenticatedPage: page }) => {
  const agents = [
    { id: 'root-1', sessionId: 'sess-1', role: 'general', root: true, model: 'm', status: 'completed', createdAt: at(0), completedAt: at(5), iteration: 2 },
    { id: 'w-done', sessionId: 'sess-1', role: 'research', model: 'm', status: 'completed', createdAt: at(1), completedAt: at(3), iteration: 3 },
    { id: 'w-live', sessionId: 'sess-1', role: 'coding', model: 'm', status: 'running', createdAt: at(2), iteration: 1 },
  ];
  await page.route('**/api/agents?sessionId=sess-1', (route) => json(route, 200, { agents }));
  await page.route('**/api/agents/*/events?**', (route) => json(route, 200, { events: [], nextCursor: 0, hasMore: false }));
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');

  const strip = page.getByRole('region', { name: 'Spawned agents' });
  await expect(strip).toContainText('1 working');
  const links = strip.getByRole('link');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toContainText('coding');
  await expect(links.first()).toHaveAttribute('href', '/agents/view?id=w-live');
  await expect(links.nth(1)).toContainText('research');
  await expect(strip).not.toContainText('general');
});
