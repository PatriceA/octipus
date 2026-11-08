import type { Page } from '@playwright/test';
import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const role = (over: Record<string, unknown>) => ({
  root: false, description: null, lane: 'everyday', toolGroups: 3, readOnly: false, known: true,
  heartbeat: { enabled: false, hookId: null, nextCheckAt: null, intervalMinutes: null, lastCheck: null },
  tasks: { active: 0, total: 0 }, runsToday: 0, liveRuns: 0, lastRun: null, ...over,
});
const roster = {
  boardWritesAllowed: false, heartbeatEnabled: true,
  roles: [
    role({ role: 'general', root: true, description: 'Your root agent.' }),
    role({ role: 'writing', lane: 'writing', description: 'Drafts docs and replies.', tasks: { active: 3, total: 5 }, runsToday: 2, liveRuns: 1,
      heartbeat: { enabled: true, hookId: 'hb', nextCheckAt: at(10, 40), intervalMinutes: 60, lastCheck: { at: at(9, 40), ran: false, reason: 'tasks_permission_required' } },
      lastRun: { id: 'w2', status: 'running', createdAt: at(9, 41), title: 'Release notes', source: 'heartbeat' } }),
    role({ role: 'research', readOnly: true, tasks: { active: 1, total: 1 } }),
  ],
};

async function open(page: Page) {
  await page.route('**/api/agents/roster', (route) => json(route, 200, roster));
  await page.goto('/agents/roster');
}

test('the roster shows each role as an agent and toggles its heartbeat', async ({ authenticatedPage: page }) => {
  let put: unknown = null;
  await page.route('**/api/tasks/role-agents', (route) => { put = route.request().postDataJSON(); return json(route, 200, { ok: true }); });
  await open(page);
  await expect(page.getByRole('heading', { name: 'Roster' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('Role agents cannot update to-dos');

  await page.getByRole('button', { name: /writing/ }).click();
  const profile = page.getByRole('complementary', { name: 'writing profile' });
  await expect(page.getByRole('button', { name: /^wr writing/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^O Octipus/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(profile).toContainText('Checks every 60 min');
  await expect(profile).toContainText('skipped: needs permission to update to-dos');
  await expect(profile).toContainText('3 open of 5');
  await expect(profile).toContainText('started by heartbeat — Release notes');

  await page.getByRole('button', { name: /research/ }).click();
  const research = page.getByRole('complementary', { name: 'research profile' });
  await expect(research).toContainText('waiting: its heartbeat is off');
  // Controlled by the server's state: it flips once the roster is read again.
  await research.getByRole('switch').click();
  await expect.poll(() => put).toEqual({ role: 'research', enabled: true });
});
