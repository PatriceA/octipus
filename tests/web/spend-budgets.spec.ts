import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, selectChatSession, stubAllDefaults } from './fixtures/api-stubs';
import { stubGateway } from './fixtures/gateway';

/**
 * Dollar spend budgets in the web UI, every /api call stubbed:
 *   - admin: pick a user, add / edit / resume / delete a budget (/admin/quotas);
 *   - the global banner: PAUSED (not dismissible) and warned (dismissible);
 *   - the dashboard budgets card;
 *   - a chat turn refused by a budget renders the budget, not a bare error.
 *
 * Screenshots go to $SPEND_BUDGET_SHOTS when set (see the PR notes).
 */

const SHOTS = process.env.SPEND_BUDGET_SHOTS;
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const WS_ID = '33333333-3333-4333-8333-333333333333';

type State = 'ok' | 'warned' | 'paused';
interface View {
  id: string; userId: string; scopeKind: 'user' | 'role' | 'workspace'; scopeRef: string | null; scopeName: string | null;
  period: 'day' | 'month'; limitUsd: number; warnRatio: number; spentUsd: number; estimatedUsd: number;
  unmeasuredCalls: number; unmeasured: boolean; percent: number; state: State;
  periodStart: string; resetsAt: string; pausedAt: string | null; warnedAt: string | null; updatedAt: string;
}

const now = new Date();
const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const dayEnd = new Date(dayStart.getTime() + 86_400_000);
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

function view(p: Partial<View> & Pick<View, 'id' | 'scopeKind' | 'period' | 'limitUsd' | 'spentUsd'>): View {
  const warnRatio = p.warnRatio ?? 0.8;
  const state: State = p.state ?? (p.spentUsd >= p.limitUsd ? 'paused' : p.spentUsd >= p.limitUsd * warnRatio ? 'warned' : 'ok');
  return {
    userId: ALICE, scopeRef: null, scopeName: null, estimatedUsd: 0, unmeasuredCalls: 0, unmeasured: false,
    pausedAt: state === 'paused' ? new Date().toISOString() : null, warnedAt: null, updatedAt: new Date().toISOString(),
    periodStart: (p.period === 'day' ? dayStart : monthStart).toISOString(),
    resetsAt: (p.period === 'day' ? dayEnd : monthEnd).toISOString(),
    percent: Math.round((p.spentUsd / p.limitUsd) * 1000) / 10,
    warnRatio,
    state,
    ...p,
  };
}

async function stubMyBudgets(page: Page, budgets: View[]) {
  await page.route('**/api/spend-budgets/me', (route) => json(route, 200, { budgets }));
}

async function shot(page: Page, name: string, target?: ReturnType<Page['locator']>) {
  if (!SHOTS) return;
  if (target) await target.screenshot({ path: `${SHOTS}/${name}` });
  else await page.screenshot({ path: `${SHOTS}/${name}` });
}

test.describe('admin: spend budgets', () => {
  /** In-memory backend for /api/admin/spend-budgets. */
  let budgets: View[];
  let calls: { method: string; path: string; body?: unknown }[];

  test.beforeEach(async ({ authenticatedPage: page }) => {
    budgets = [
      view({ id: 'b-user', scopeKind: 'user', period: 'month', limitUsd: 50, spentUsd: 12.5, estimatedUsd: 2.1, unmeasuredCalls: 3, unmeasured: true }),
    ];
    calls = [];
    await stubAllDefaults(page);
    await stubMyBudgets(page, []);
    await page.route('**/api/admin/quotas', (route) => json(route, 200, {
      quotas: [ALICE, BOB].map((id, i) => ({
        userId: id, username: i === 0 ? 'alice' : 'bob', isAdmin: false, isActive: true,
        quota: {
          maxConcurrentAgents: 5, maxTokensPerDay: 1_000_000, maxApiCallsPerMinute: 60,
          overrides: { maxConcurrentAgents: false, maxTokensPerDay: false, maxApiCallsPerMinute: false },
        },
        usage: { concurrentAgents: 0, tokensToday: 1000, apiCallsLastMinute: 0 },
      })),
    }));
    await page.route('**/api/roles', (route) => json(route, 200, {
      roles: [{ role: 'coder', description: '' }, { role: 'researcher', description: '' }],
    }));
    await page.route('**/api/admin/users/*/workspaces', (route) => json(route, 200, {
      workspaces: [{ id: WS_ID, name: 'Client A', slug: 'client-a', isDefault: false }],
    }));
    await page.route(/\/api\/admin\/spend-budgets/, async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      const body = req.postDataJSON?.() ?? undefined;
      calls.push({ method: req.method(), path: url.pathname, body });
      const resume = url.pathname.match(/spend-budgets\/([^/]+)\/resume$/);
      const byId = url.pathname.match(/spend-budgets\/([^/]+)$/);
      if (req.method() === 'GET') {
        const userId = url.searchParams.get('userId');
        const mine = budgets.filter((b) => b.userId === userId);
        return json(route, 200, { budgets: mine, statuses: mine });
      }
      if (req.method() === 'PUT') {
        const b = body as { userId: string; scopeKind: View['scopeKind']; scopeRef: string | null; period: View['period']; limitUsd: number; warnRatio: number };
        const existing = budgets.find((x) => x.userId === b.userId && x.scopeKind === b.scopeKind
          && (x.scopeRef ?? null) === (b.scopeRef ?? null) && x.period === b.period);
        const spent = existing?.spentUsd ?? 0;
        const next = view({
          id: existing?.id ?? `b-${budgets.length + 1}`, userId: b.userId, scopeKind: b.scopeKind, scopeRef: b.scopeRef,
          scopeName: b.scopeKind === 'workspace' ? 'Client A' : b.scopeRef, period: b.period,
          limitUsd: b.limitUsd, warnRatio: b.warnRatio, spentUsd: spent,
        });
        budgets = existing ? budgets.map((x) => (x.id === existing.id ? next : x)) : [...budgets, next];
        return json(route, 200, next);
      }
      if (req.method() === 'POST' && resume) {
        budgets = budgets.map((x) => (x.id === resume[1] ? { ...x, state: 'warned', pausedAt: null } : x));
        return json(route, 200, budgets.find((x) => x.id === resume[1]));
      }
      if (req.method() === 'DELETE' && byId) {
        budgets = budgets.filter((x) => x.id !== byId[1]);
        return json(route, 200, { deleted: true });
      }
      return json(route, 404, { error: 'unexpected' });
    });
  });

  test('pick a user, add, edit, resume and delete a budget', async ({ authenticatedPage: page }) => {
    await page.goto('/admin/quotas');
    const section = page.getByTestId('spend-budgets-section');
    await expect(section.getByText('Pick a user to see and set')).toBeVisible();

    // The wallet button on a quota row selects that user.
    await page.getByRole('button', { name: 'Spend budgets for alice' }).click();
    await expect(section.getByLabel('User')).toHaveValue(ALICE);
    const userBudget = section.getByTestId('spend-budget').first();
    await expect(userBudget).toContainText('All agents');
    await expect(userBudget).toContainText('$12.50');
    await expect(userBudget).toContainText('/ $50.00 per month');
    await expect(userBudget).toContainText('3 calls this month reported no cost');
    await expect(userBudget.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');

    // Add a daily role budget; warn % defaults to 80.
    await section.getByRole('button', { name: 'Add budget' }).click();
    const dialog = page.getByRole('dialog', { name: 'Spend budget' });
    await dialog.getByLabel('Scope').selectOption('role');
    await dialog.getByLabel('Role').selectOption('coder');
    await dialog.getByLabel('Period').selectOption('day');
    await expect(dialog.getByLabel('Warn at %')).toHaveValue('80');
    await dialog.getByLabel('Limit (USD)').fill('5');
    await dialog.getByRole('button', { name: 'Save budget' }).click();
    await expect(dialog).toHaveCount(0);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      userId: ALICE, scopeKind: 'role', scopeRef: 'coder', period: 'day', limitUsd: 5, warnRatio: 0.8,
    });
    const roleBudget = section.getByTestId('spend-budget').filter({ hasText: 'Role "coder"' });
    await expect(roleBudget).toContainText('daily');
    await expect(roleBudget).toContainText('/ $5.00 per day');

    // A workspace budget offers the user's workspaces by name.
    await section.getByRole('button', { name: 'Add budget' }).click();
    await dialog.getByLabel('Scope').selectOption('workspace');
    await dialog.getByLabel('Workspace').selectOption({ label: 'Client A' });
    await dialog.getByLabel('Limit (USD)').fill('100');
    await dialog.getByLabel('Warn at %').fill('90');
    await dialog.getByRole('button', { name: 'Save budget' }).click();
    await expect(section.getByTestId('spend-budget').filter({ hasText: 'Workspace "Client A"' })).toBeVisible();
    expect(calls.filter((c) => c.method === 'PUT')[1]?.body).toMatchObject({ scopeKind: 'workspace', scopeRef: WS_ID, warnRatio: 0.9 });

    // Edit the user budget down so it is PAUSED; scope/period are locked.
    await userBudget.getByRole('button', { name: 'Edit budget' }).click();
    await expect(dialog.getByLabel('Scope')).toBeDisabled();
    await expect(dialog.getByLabel('Limit (USD)')).toHaveValue('50');
    await dialog.getByLabel('Limit (USD)').fill('10');
    await dialog.getByRole('button', { name: 'Save budget' }).click();
    await expect(userBudget).toHaveAttribute('data-state', 'paused');
    await expect(userBudget).toContainText('PAUSED');
    // Resume explains itself: spend is still over the limit.
    await expect(section.getByTestId('resume-hint').first()).toContainText('still at or over the limit');
    await shot(page, 'budget-admin.png', section);

    // Resume clears the pause.
    await userBudget.getByRole('button', { name: 'Resume' }).click();
    await expect(userBudget).toHaveAttribute('data-state', 'warned');
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/b-user/resume'))).toBe(true);

    // Delete needs a confirm click.
    await roleBudget.getByRole('button', { name: 'Delete budget' }).click();
    await roleBudget.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(section.getByTestId('spend-budget').filter({ hasText: 'Role "coder"' })).toHaveCount(0);
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/b-2'))).toBe(true);
  });

  test('another user with no budgets reads as uncapped', async ({ authenticatedPage: page }) => {
    await page.goto('/admin/quotas');
    const section = page.getByTestId('spend-budgets-section');
    await section.getByLabel('User').selectOption(BOB);
    await expect(section.getByText('No spend budget for bob')).toBeVisible();
  });
});

test.describe('user: banner and budgets card', () => {
  test('a user-scope pause: "Agents are paused", not dismissible', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await stubMyBudgets(page, [
      view({ id: 'p2', scopeKind: 'user', period: 'day', limitUsd: 10, spentUsd: 10.42 }),
      view({ id: 'p3', scopeKind: 'role', scopeRef: 'coder', scopeName: 'coder', period: 'day', limitUsd: 5, spentUsd: 6 }),
    ]);
    await page.goto('/');
    const banner = page.getByTestId('spend-budget-banner');
    await expect(banner).toHaveAttribute('data-state', 'paused');
    await expect(banner).toHaveAttribute('data-scope', 'user');
    await expect(banner).toContainText('Agents are paused: your daily budget of $10.00/day reached ($10.42 spent).');
    await expect(banner).toContainText('Resets');
    await expect(banner).toContainText('Ask an admin to raise it.');
    await expect(banner).toContainText('(+1 more paused)');
    await expect(banner.getByRole('button', { name: /dismiss/i })).toHaveCount(0);
    await expect(page.getByTestId('budgets-card')).toBeVisible();
    await shot(page, 'budget-banner.png');

    // Stays on navigation.
    await page.goto('/notifications');
    await expect(page.getByTestId('spend-budget-banner')).toHaveAttribute('data-state', 'paused');
  });

  test('a role pause names the role and can be dismissed for the session', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await stubMyBudgets(page, [
      view({ id: 'r1', scopeKind: 'role', scopeRef: 'coder', scopeName: 'coder', period: 'day', limitUsd: 10, spentUsd: 10.42 }),
      view({ id: 'u1', scopeKind: 'user', period: 'month', limitUsd: 100, spentUsd: 40 }),
    ]);
    await page.goto('/');
    const banner = page.getByTestId('spend-budget-banner');
    await expect(banner).toHaveAttribute('data-scope', 'role');
    await expect(banner).toContainText('Agents in role "coder" are paused: daily budget of $10.00/day reached ($10.42 spent).');
    await expect(banner).not.toContainText('Agents are paused');
    await expect(page.getByTestId('budgets-card')).toBeVisible();
    await shot(page, 'budget-banner-role.png');
    await banner.getByRole('button', { name: 'Dismiss budget notice' }).click();
    await expect(page.getByTestId('spend-budget-banner')).toHaveCount(0);
    await page.goto('/notifications');
    await expect(page.getByText('inbox').first()).toBeVisible();
    await expect(page.getByTestId('spend-budget-banner')).toHaveCount(0);
  });

  test('a workspace pause: dismissible for another workspace, not for the current one', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    // stubWorkspaces makes 'ws-1' ("Default") the active workspace.
    await stubMyBudgets(page, [
      view({ id: 'w-other', scopeKind: 'workspace', scopeRef: WS_ID, scopeName: 'Client A', period: 'month', limitUsd: 50, spentUsd: 51 }),
    ]);
    await page.goto('/');
    const banner = page.getByTestId('spend-budget-banner');
    await expect(banner).toContainText('Agents in workspace "Client A" are paused: monthly budget of $50.00/month reached');
    await expect(banner.getByRole('button', { name: 'Dismiss budget notice' })).toBeVisible();

    await stubMyBudgets(page, [
      view({ id: 'w-here', scopeKind: 'workspace', scopeRef: 'ws-1', scopeName: 'Default', period: 'month', limitUsd: 50, spentUsd: 51 }),
    ]);
    await page.reload();
    await expect(banner).toContainText('Agents in workspace "Default" are paused');
    await expect(banner.getByRole('button', { name: /dismiss/i })).toHaveCount(0);
  });

  test('a warned budget shows a softer banner, dismissible for the session', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await stubMyBudgets(page, [view({ id: 'w1', scopeKind: 'user', period: 'month', limitUsd: 20, spentUsd: 17 })]);
    await page.goto('/');
    const banner = page.getByTestId('spend-budget-banner');
    await expect(banner).toHaveAttribute('data-state', 'warned');
    await expect(banner).toContainText('your monthly budget of $20.00/month is at 85% ($17.00 spent)');
    await banner.getByRole('button', { name: 'Dismiss budget warning' }).click();
    await expect(page.getByTestId('spend-budget-banner')).toHaveCount(0);
    // Dismissal survives navigation within the session.
    await page.goto('/notifications');
    await expect(page.getByText('inbox').first()).toBeVisible();
    await expect(page.getByTestId('spend-budget-banner')).toHaveCount(0);
  });

  test('no budgets: no banner, and the card says agents are uncapped', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await stubMyBudgets(page, []);
    await page.goto('/');
    await expect(page.getByTestId('budgets-card')).toContainText('No spend budget is set for you');
    await expect(page.getByTestId('spend-budget-banner')).toHaveCount(0);
  });

  test('the dashboard budgets card lists spend vs limit, state and reset', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await stubMyBudgets(page, [
      view({ id: 'c1', scopeKind: 'user', period: 'month', limitUsd: 50, spentUsd: 20, estimatedUsd: 4, unmeasuredCalls: 2, unmeasured: true }),
      view({ id: 'c2', scopeKind: 'workspace', scopeRef: WS_ID, scopeName: 'Client A', period: 'day', limitUsd: 5, spentUsd: 4.2 }),
      view({ id: 'c3', scopeKind: 'role', scopeRef: 'coder', scopeName: 'coder', period: 'day', limitUsd: 2, spentUsd: 2.5 }),
    ]);
    await page.goto('/#budgets');
    const card = page.getByTestId('budgets-card');
    const rows = card.getByTestId('spend-budget');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-state', 'ok');
    await expect(rows.nth(0)).toContainText('$20.00');
    await expect(rows.nth(0)).toContainText('Includes $4.00 estimated');
    await expect(rows.nth(0)).toContainText('2 calls this month reported no cost');
    await expect(rows.nth(1)).toHaveAttribute('data-state', 'warned');
    await expect(rows.nth(1)).toContainText('Workspace "Client A"');
    await expect(rows.nth(2)).toHaveAttribute('data-state', 'paused');
    await expect(rows.nth(2)).toContainText('PAUSED');
    await expect(rows.nth(2)).toContainText('resets');
    // Read-only: no admin actions on the user's card.
    await expect(card.getByRole('button')).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'budget-card.png', card.locator('xpath=..'));
  });

  test('budget notifications render with a label, the spend line and a link to the card', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/notifications**', (route) => json(route, 200, {
      unreadCount: 1,
      notifications: [{
        id: 'n-b', type: 'spend_budget_paused', title: 'Spend budget reached — agents paused',
        body: 'Your daily budget of $10.00 is spent ($10.42).', read: false, createdAt: new Date().toISOString(),
        metadata: { budgetId: 'p1', scopeKind: 'user', scopeRef: null, period: 'day', spentUsd: 10.42, limitUsd: 10 },
      }],
    }));
    await page.goto('/notifications');
    const row = page.getByTestId('notification-row').first();
    await expect(row).toContainText('budget reached · agents paused');
    await expect(row).toContainText('All agents · daily · $10.42 of $10.00');
    await expect(row.getByRole('link', { name: /open budgets/ })).toHaveAttribute('href', '/#budgets');
  });
});

test.describe('chat: a turn refused by a spend budget', () => {
  test('names the budget, limit, spend and reset time', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBe(1);
    const reason = {
      budgetId: 'p1', userId: ALICE, scopeKind: 'role', scopeRef: 'coder', period: 'day',
      spentUsd: 10.42, limitUsd: 10, resetsAt: dayEnd.toISOString(),
    };
    gateway.event('chat.response', { response: {
      response: 'Agents are paused: the daily spend budget for the "coder" role of $10.00/day is reached ($10.42 spent this day).',
      metadata: { limit: { code: 'SPEND_BUDGET_EXCEEDED', reason } },
    } }, 'sess-1');
    const card = page.getByTestId('limit-refusal');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Agents are paused — spend budget reached');
    await expect(card).toContainText('Role "coder" daily budget of $10.00/day is reached: $10.42 spent this day.');
    await expect(card).toContainText('Resets');
    await expect(card).toContainText('Ask an admin to raise the limit.');
    await expect(page.getByText(/^Error:/)).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'See your budgets' })).toHaveAttribute('href', '/#budgets');
  });

  test('the refusal card survives a reload (persisted metadata.limit)', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    const reason = {
      budgetId: 'p1', userId: ALICE, scopeKind: 'user', scopeRef: null, period: 'month',
      spentUsd: 51, limitUsd: 50, resetsAt: monthEnd.toISOString(),
    };
    await page.route(/\/api\/sessions\/sess-1\/messages/, (route) => json(route, 200, {
      messages: [
        { id: 'm1', role: 'user', content: 'refactor the parser', createdAt: new Date().toISOString(), metadata: {} },
        {
          id: 'm2', role: 'assistant', createdAt: new Date().toISOString(),
          content: 'Agents are paused: your monthly spend budget of $50.00/month is reached ($51.00 spent this month).',
          metadata: { limit: { code: 'SPEND_BUDGET_EXCEEDED', reason } },
        },
      ],
      total: 2,
    }));
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    const card = page.getByTestId('limit-refusal');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Your monthly budget of $50.00/month is reached: $51.00 spent this month.');
  });
});
