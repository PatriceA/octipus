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

test('the roster reports heartbeat status and directs configuration to Settings', async ({ authenticatedPage: page }) => {
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
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(research.getByRole('link', { name: 'Manage heartbeat in Settings' })).toHaveAttribute('href', '/settings?tab=heartbeat');
});

test('Octipus reports the same personal heartbeat as Settings without another control', async ({ authenticatedPage: page }) => {
  const state = structuredClone(roster);
  state.roles[0].heartbeat = { enabled: true, hookId: 'personal', nextCheckAt: at(10, 15), intervalMinutes: 15, lastCheck: null };
  await page.route('**/api/agents/roster', route => json(route, 200, state));
  await page.goto('/agents/roster');
  const profile = page.getByRole('complementary', { name: 'Octipus profile' });
  await expect(profile).toContainText('Uses the same personal heartbeat as Settings');
  await expect(profile.getByRole('switch')).toHaveCount(0);
  await expect(profile.getByRole('link', { name: 'Manage heartbeat in Settings' })).toHaveAttribute('href', '/settings?tab=heartbeat');
});

test('an enabled personal heartbeat reports the server pause clearly', async ({ authenticatedPage: page }) => {
  const state = structuredClone(roster); state.heartbeatEnabled = false;
  state.roles[0].heartbeat.enabled = true;
  await page.route('**/api/agents/roster', route => json(route, 200, state));
  await page.goto('/agents/roster');
  await expect(page.getByRole('button', { name: /^O Octipus/ })).toContainText('heartbeat on · server paused');
  await expect(page.getByRole('link', { name: 'Open heartbeat settings' })).toBeVisible();
});
