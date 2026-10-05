import type { Page } from '@playwright/test';
import { json } from './fixtures/api-stubs';
import { expect, expectNoConsoleErrors, STUB_USER, test } from './fixtures/auth';

/**
 * Space funding, budgets and My work in the web (coworking spec §9.1–§9.3):
 * an owner sponsors the space and picks sponsor models, sets and removes a
 * budget; a member sees both read-only with their own share; "My work"
 * lists my tasks grouped by space.
 *
 * The server is stubbed; the stubs answer as `src/api/routes/spaces.ts` and
 * `src/api/routes/me-work.ts` do.
 */

const NOW = new Date().toISOString();
const SPACE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000009';
type Role = 'owner' | 'editor';

interface Funding { funding: 'own' | 'unattended' | 'sponsored'; sponsorUserId: string | null; sponsorModels: string[] }

function space(role: Role, funding: Funding) {
  return {
    id: SPACE_ID, name: 'Launch', slug: 'launch-9z', role, memberCount: 2, archivedAt: null,
    createdBy: 'owner-id', createdAt: NOW, agentEditMode: 'suggest', ...funding,
  };
}

const MY_MODEL = `u/${STUB_USER.id}/paid`;

async function stubs(page: Page, role: Role, initial: Funding) {
  let funding = { ...initial };
  const calls: Array<{ path: string; body: unknown }> = [];
  let budgets: Array<Record<string, unknown>> = [];
  await page.addInitScript((id) => localStorage.setItem('octipus.activeWorkspace', id), SPACE_ID);
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: [space(role, funding)] }));
  await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space(role, funding)));
  await page.route(`**/api/spaces/${SPACE_ID}/members`, (route) => json(route, 200, {
    members: [
      { userId: 'owner-id', username: 'olga', role: 'owner', joinedAt: NOW },
      { userId: STUB_USER.id, username: STUB_USER.username, role, joinedAt: NOW },
    ],
  }));
  await page.route(`**/api/spaces/${SPACE_ID}/invites`, (route) => json(route, 200, { invites: [] }));
  await page.route(`**/api/spaces/${SPACE_ID}/activity**`, (route) => json(route, 200, { activity: [] }));
  await page.route('**/api/me/models', (route) => json(route, 200, {
    models: [{ name: MY_MODEL, slug: 'paid', provider: 'openai', modelId: 'gpt-x', label: 'My paid model', endpoint: null, isEnabled: true, hasKey: true, topics: [] }],
    providers: ['openai'], topics: ['build'],
  }));
  await page.route(`**/api/spaces/${SPACE_ID}/funding`, (route) => {
    const body = route.request().postDataJSON() as { mode?: Funding['funding']; sponsor?: 'me' | null; sponsorModels?: string[] };
    calls.push({ path: 'funding', body });
    if (body.mode) funding.funding = body.mode;
    if (body.sponsor === 'me') funding = { ...funding, sponsorUserId: STUB_USER.id, sponsorModels: [] };
    if (body.sponsor === null) funding = { ...funding, sponsorUserId: null, sponsorModels: [] };
    if (body.sponsorModels) funding.sponsorModels = body.sponsorModels;
    return json(route, 200, { mode: funding.funding, sponsorUserId: funding.sponsorUserId, sponsorModels: funding.sponsorModels });
  });
  await page.route(`**/api/spaces/${SPACE_ID}/budget`, (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { kind: string; period: string; limitUsd: number | null };
      calls.push({ path: 'budget', body });
      budgets = budgets.filter((b) => !(b.scopeKind === body.kind && b.period === body.period));
      if (body.limitUsd !== null) {
        budgets.push({ id: `b-${body.kind}`, scopeKind: body.kind, period: body.period, limitUsd: body.limitUsd, warnRatio: 0.8, spentUsd: 1.25, percent: 10, state: 'ok', resetsAt: NOW });
      }
      return json(route, 200, { budgets });
    }
    return json(route, 200, { budgets });
  });
  return { calls, setBudgets: (b: Array<Record<string, unknown>>) => { budgets = b; } };
}

test('an owner sponsors the space, picks a sponsor model and sets a budget', async ({ authenticatedPage: page, consoleErrors }) => {
  const { calls } = await stubs(page, 'owner', { funding: 'unattended', sponsorUserId: null, sponsorModels: [] });
  await page.goto(`/spaces/${SPACE_ID}/settings`);

  const funding = page.getByRole('region', { name: 'Funding' });
  await expect(funding.getByLabel('Agent funding')).toHaveValue('unattended');
  await expect(funding.getByTestId('funding-no-sponsor')).toBeVisible();
  await funding.getByLabel('Agent funding').selectOption('sponsored');
  await expect.poll(() => calls.find((c) => c.path === 'funding')?.body).toEqual({ mode: 'sponsored' });

  await funding.getByRole('button', { name: 'sponsor this space' }).click();
  await expect(funding.getByTestId('space-sponsor')).toHaveText(STUB_USER.username);
  // A controlled box: checked once the server's answer is read back.
  await funding.getByLabel('Sponsor model My paid model').click();
  await expect(funding.getByLabel('Sponsor model My paid model')).toBeChecked();
  await expect.poll(() => calls.at(-1)?.body).toEqual({ sponsorModels: [MY_MODEL] });
  await expect(page.getByText(/agent runs paid by/)).toBeVisible();

  const budget = page.getByRole('region', { name: 'Budget' });
  await expect(budget.getByTestId('space-budgets')).toContainText('not capped');
  await budget.getByLabel('Budget kind').selectOption('space_member');
  await budget.getByLabel('Budget period').selectOption('day');
  await budget.getByLabel('Budget limit').fill('5');
  await budget.getByRole('button', { name: 'set budget' }).click();
  await expect.poll(() => calls.find((c) => c.path === 'budget')?.body).toEqual({ kind: 'space_member', period: 'day', limitUsd: 5 });
  await expect(budget.getByTestId('space-budget')).toContainText('$1.25 of $5.00');
  await budget.getByTestId('space-budget').getByRole('button', { name: 'remove' }).click();
  await expect.poll(() => calls.at(-1)?.body).toEqual({ kind: 'space_member', period: 'day', limitUsd: null });
  await expect(budget.getByTestId('space-budget')).toHaveCount(0);
  expectNoConsoleErrors(consoleErrors);
});

test('a member sees funding and their share of the budget read-only', async ({ authenticatedPage: page, consoleErrors }) => {
  const { setBudgets } = await stubs(page, 'editor', { funding: 'sponsored', sponsorUserId: 'owner-id', sponsorModels: ['u/owner-id/x'] });
  setBudgets([{ id: 'b1', scopeKind: 'space_member', period: 'month', limitUsd: 10, warnRatio: 0.8, spentUsd: 9, percent: 90, state: 'warned', resetsAt: NOW }]);
  await page.goto(`/spaces/${SPACE_ID}/settings`);
  const funding = page.getByRole('region', { name: 'Funding' });
  await expect(funding.getByTestId('space-funding')).toHaveText('sponsored');
  await expect(funding.getByTestId('space-sponsor')).toHaveText('olga');
  await expect(funding.getByTestId('sponsor-models')).toContainText("1 of the sponsor's own models");
  await expect(funding.getByLabel('Agent funding')).toHaveCount(0);
  const budget = page.getByRole('region', { name: 'Budget' });
  await expect(budget.getByTestId('space-budget')).toContainText('each member (your share) / month');
  await expect(budget.getByTestId('space-budget')).toContainText('$9.00 of $10.00 · warned');
  await expect(budget.getByRole('button', { name: 'set budget' })).toHaveCount(0);
  expectNoConsoleErrors(consoleErrors);
});

test('My work lists my open tasks grouped by space', async ({ authenticatedPage: page, consoleErrors }) => {
  await page.route('**/api/me/work', (route) => json(route, 200, {
    groups: [
      { workspaceId: null, name: 'Personal', kind: 'personal', tasks: [{ id: 't1', title: 'Renew passport', status: 'open', priority: 0, dueAt: null, workspaceId: null }] },
      { workspaceId: SPACE_ID, name: 'Launch', kind: 'shared', tasks: [
        { id: 't2', title: 'Ship release notes', status: 'in_progress', priority: 3, dueAt: NOW, workspaceId: SPACE_ID },
        { id: 't3', title: 'Review the deck', status: 'open', priority: 0, dueAt: null, workspaceId: SPACE_ID },
      ] },
    ],
  }));
  await page.goto('/my-work');
  await expect(page.getByTestId('my-work-group')).toHaveCount(2);
  const launch = page.getByRole('region', { name: 'Launch' });
  await expect(launch.getByTestId('my-work-task')).toHaveCount(2);
  await expect(launch.getByTestId('my-work-task').first()).toContainText('Ship release notes');
  await expect(launch.getByTestId('my-work-task').first()).toContainText('high');
  await expect(page.getByRole('region', { name: 'Personal' })).toContainText('Renew passport');
  await expect(page.getByRole('link', { name: 'my work' })).toBeVisible();
  expectNoConsoleErrors(consoleErrors);
});

test('My work says when nothing is assigned', async ({ authenticatedPage: page }) => {
  await page.route('**/api/me/work', (route) => json(route, 200, { groups: [] }));
  await page.goto('/my-work');
  await expect(page.getByTestId('my-work-empty')).toBeVisible();
});
