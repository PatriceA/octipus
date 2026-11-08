import type { Page } from '@playwright/test';
import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const day = new Date();
day.setHours(0, 0, 0, 0);
const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000).toISOString();
const triggers = {
  since: day.toISOString(), now: at(10, 5),
  triggers: [
    { hookId: 'hb', name: 'writer heartbeat', kind: 'heartbeat', action: 'spawn_agent', enabled: true, role: 'writer', nextRunAt: at(10, 40), intervalMinutes: 60, lastExecutedAt: at(9, 40), lastError: null,
      events: [
        { at: at(6, 40), kind: 'skipped', reason: 'quiet_hours', readyTasks: null },
        { at: at(7, 40), kind: 'skipped', reason: 'nothing_pending', readyTasks: 0 },
        { at: at(8, 40), kind: 'skipped', reason: 'tasks_permission_required', readyTasks: 2 },
        { at: at(9, 40), kind: 'ran', reason: null, readyTasks: 2 },
      ] },
    { hookId: 'ci', name: 'CI triage', kind: 'webhook', action: 'spawn_agent', enabled: true, role: null, nextRunAt: null, intervalMinutes: null, lastExecutedAt: at(8, 12), lastError: 'gh auth expired',
      events: [{ at: at(8, 12), kind: 'failed', reason: 'gh auth expired', readyTasks: null }] },
  ],
  funnel: { checks: 4, ran: 1, skipped: { quiet_hours: 1, nothing_pending: 1, tasks_permission_required: 1 } },
};

async function open(page: Page, body: unknown = triggers) {
  await page.route('**/api/agents/triggers', (route) => json(route, 200, body));
  await page.goto('/agents/triggers');
}

test('the triggers page shows what each trigger decided today and why a heartbeat skipped', async ({ authenticatedPage: page }) => {
  await open(page);
  await expect(page.getByRole('heading', { name: 'Triggers', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'writer heartbeat: 1 ran, 3 skipped, 0 failed today' })).toBeVisible();

  const funnel = page.getByRole('region', { name: 'Heartbeat checks today' });
  await expect(funnel).toContainText('Quiet hours');
  await expect(funnel).toContainText('Needs permission to update to-dos');
  await expect(funnel).toContainText('= Started a turn');
  await expect(funnel).toContainText('3 skipped checks used no model tokens.');

  const why = page.getByRole('region', { name: 'Why did it run, or not?' });
  await expect(why).toContainText('Started a turn for 2 ready to-dos');
  await expect(why).toContainText('Needs permission to update to-dos (2 ready)');
  await expect(why).toContainText('Next check');

  const row = page.getByRole('row', { name: /CI triage/ });
  await expect(row).toContainText('1 failed');
  await expect(page.getByRole('row', { name: /writer heartbeat/ })).toContainText('writer (role agent)');
  // The page's nav item is the active one, not Mission control too.
  await expect(page.locator('aside nav').getByRole('link', { name: 'triggers' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('aside nav').getByRole('link', { name: 'mission control' })).not.toHaveAttribute('aria-current', 'page');
});

test('no trigger set up says how to add one', async ({ authenticatedPage: page }) => {
  await open(page, { ...triggers, triggers: [], funnel: { checks: 0, ran: 0, skipped: {} } });
  await expect(page.getByText('No trigger is set up.')).toBeVisible();
});
