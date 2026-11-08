import type { Page } from '@playwright/test';
import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

const now = new Date();
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const run = (over: Record<string, unknown>) => ({
  sessionId: 'sess-1', model: 'm', status: 'completed', root: false, parentAgentId: null, origin: null, title: 'Compare vector DBs',
  createdAt: at(30), completedAt: at(28), durationMs: 91_000, totalTokens: 12_700, costUsd: 0.07, error: null, completionReason: null, ...over,
});
const overview = {
  since: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
  runs: [
    run({ id: 'root-1', role: 'general', root: true, status: 'running', origin: { source: 'chat', channel: 'webchat' }, createdAt: at(5), completedAt: null, durationMs: null }),
    run({ id: 'res-1', role: 'researcher', status: 'running', parentAgentId: 'root-1', origin: { source: 'spawned', channel: 'webchat' }, createdAt: at(4), completedAt: null, durationMs: null, costUsd: 0.21, totalTokens: 38_200 }),
    run({ id: 'wr-1', role: 'writer', origin: { source: 'heartbeat', hookName: 'writer heartbeat' }, title: 'Draft release notes', costUsd: null }),
    run({ id: 'co-1', role: 'coder', status: 'failed', origin: { source: 'webhook', hookName: 'CI triage' }, error: 'tool_error: gh auth expired', title: 'Triage PR 412' }),
    run({ id: 'old-1', role: 'analyst', origin: null, title: 'Older row' }),
  ],
  counts: { live: 2, today: 5, failedToday: 1, bySource: { chat: 1, spawned: 1, heartbeat: 1, webhook: 1, unknown: 1 } },
  spendTodayUsd: 1.82,
  pendingApprovals: 2,
  upcoming: [
    { hookId: 'h1', name: 'Daily briefing', kind: 'schedule', role: null, nextRunAt: at(-60), everyMinutes: null, lastError: null },
    { hookId: 'h2', name: 'writer heartbeat', kind: 'heartbeat', role: 'writer', nextRunAt: null, everyMinutes: 60, lastError: null },
  ],
};

async function open(page: Page, body: unknown = overview) {
  await page.route('**/api/agents/overview', (route) => json(route, 200, body));
  await page.goto('/agents');
}

test('mission control lists every run of the day with who started it', async ({ authenticatedPage: page }) => {
  await open(page);
  await expect(page.getByRole('heading', { name: 'Mission control' })).toBeVisible();
  const glance = page.getByRole('region', { name: 'Today at a glance' });
  await expect(glance).toContainText('1 you, in chat · 1 spawned by an agent');
  await expect(glance).toContainText('Approvals waiting in chat');
  await expect(glance).toContainText('$1.82');

  const table = page.getByRole('table');
  await expect(table.getByRole('row', { name: /researcher/ })).toContainText('by Octipus');
  await expect(table.getByRole('row', { name: /writer/ })).toContainText('writer heartbeat');
  await expect(table.getByRole('row', { name: /writer/ })).toContainText('not recorded');
  await expect(table.getByRole('row', { name: /coder/ })).toContainText('gh auth expired');
  // A row written before origins were recorded says so; it is not counted as chat.
  await expect(table.getByRole('row', { name: /analyst/ })).toContainText('Not recorded');

  await page.getByRole('button', { name: /^Heartbeat/ }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Up next' })).toContainText('every 60m');
});

test('an empty day and an unreadable approval count are said plainly', async ({ authenticatedPage: page }) => {
  await open(page, { ...overview, runs: [], counts: { live: 0, today: 0, failedToday: 0, bySource: {} }, pendingApprovals: null, upcoming: [] });
  await expect(page.getByText('No agent is running.')).toBeVisible();
  await expect(page.getByText('No agent has run today.')).toBeVisible();
  await expect(page.getByText('Approvals could not be read')).toBeVisible();
});

test('stop asks the server to stop that agent', async ({ authenticatedPage: page }) => {
  let stopped = '';
  await page.route('**/api/agents/*/stop', (route) => { stopped = route.request().url(); return json(route, 200, { ok: true }); });
  await open(page);
  await page.getByRole('article').filter({ hasText: 'researcher' }).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => stopped).toContain('/api/agents/res-1/stop');
});
