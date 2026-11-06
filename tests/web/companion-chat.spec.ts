import { test, expect } from './fixtures/auth';
import { json, selectChatSession } from './fixtures/api-stubs';
import { stubGateway } from './fixtures/gateway';
import { STUB_USER, STUB_TOKEN } from './fixtures/auth';

const controller = 'companion-controller';
const settings = { enabled: true, modelName: 'DeepSeek supervisor', autonomy: 'coordinate', maxConcurrent: 2,
  dailyTokenBudget: 100000, turnTokenBudget: 64000, maxRepairAttempts: 2, quietHoursStart: 22, quietHoursEnd: 7,
  timezone: 'UTC', revision: 1, supervisorSessionId: controller };

async function setup(page: import('@playwright/test').Page, includeController = true) {
  await stubGateway(page);
  await page.route('**/api/companion/settings', route => json(route, 200, settings));
  await page.route('**/api/companion/goals', route => json(route, 200, { goals: [] }));
  await page.route('**/api/sessions', route => json(route, 200, { sessions: [
    { id: 'sess-1', title: 'Direct project work', status: 'active', updatedAt: new Date().toISOString(), messageCount: 1 },
    { id: 'sess-2', title: 'Companion chat', pinned: true, status: 'active', updatedAt: new Date().toISOString(), messageCount: 1 },
    ...(includeController ? [{ id: controller, title: 'Renamed conversation', pinned: false, status: 'active', updatedAt: new Date().toISOString(), messageCount: 1 }] : []),
  ] }));
  await page.route('**/api/sessions/*/messages**', route => json(route, 200, { messages: [] }));
}

test('a rate-limited login check on reload keeps credentials and opens Companion after cooldown', async ({ authenticatedPage: page }) => {
  await setup(page);
  let checks = 0;
  await page.route('**/api/auth/me', route => {
    if (++checks === 1) return route.fulfill({ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' }, body: JSON.stringify({ error: 'Too many requests', retryAfter: 1 }) });
    return json(route, 200, STUB_USER);
  });
  await page.goto(`/chat?session=${controller}`);
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toBeVisible();
  expect(checks).toBeGreaterThan(1);
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe(STUB_TOKEN);
  await expect(page).not.toHaveURL(/\/login/);
});

test('Companion has its own identity while direct sessions remain optional and survive reload', async ({ authenticatedPage: page }) => {
  await setup(page);
  await page.goto('/chat?session=sess-1');
  const identity = page.getByRole('region', { name: 'Companion chat identity' });
  await expect(page.getByTestId('current-session-title')).toHaveText('Direct project work');
  await expect(identity).toHaveCount(0);
  const entry = page.getByRole('button', { name: 'Open Companion chat', exact: true });
  await expect(entry).toBeVisible();
  await expect(page.locator(`[data-session-id="${controller}"]`)).toHaveCount(1);
  await page.getByPlaceholder('search…').fill('nothing matches');
  await expect(entry).toBeVisible();
  await page.getByPlaceholder('search…').clear();
  await entry.click();
  await expect(identity).toContainText('Your cross-project coordinator');
  await expect(identity).toContainText('DeepSeek supervisor');
  await expect(page.getByPlaceholder('Plan work, check progress, or park an idea...')).toBeVisible();
  await page.reload();
  await expect(identity).toBeVisible();
  // A pinned conversation with the same label is still an ordinary session.
  await selectChatSession(page, 'sess-2');
  await expect(identity).toHaveCount(0);
  await selectChatSession(page, 'sess-1');
  await page.reload();
  await expect(page.getByTestId('current-session-title')).toHaveText('Direct project work');
  await expect(identity).toHaveCount(0);
});

test('Companion overview opens the saved chat even outside the recent session list', async ({ authenticatedPage: page }) => {
  await setup(page, false);
  await page.goto('/companion');
  const entry = page.getByRole('link', { name: /Companion chat.*Open Companion chat/ });
  await expect(entry).toContainText('Optional: you can always work directly in a session chat.');
  await entry.click();
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toBeVisible();
  await expect(page.getByTestId('current-session-title')).toHaveText('Companion chat');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toBeVisible();
});

test('delayed initial workspace resolution preserves an explicit Companion outside the recent list', async ({ authenticatedPage: page }) => {
  await setup(page, false);
  let resolveWorkspace!: () => void;
  const workspaceReady = new Promise<void>(resolve => { resolveWorkspace = resolve; });
  await page.route('**/api/me/workspaces', async route => {
    await workspaceReady;
    return json(route, 200, { workspaces: [
      { id: 'ws-1', userId: 'e2e-user-id', slug: 'default', name: 'Default', isDefault: true },
    ] });
  });
  const historyRead = page.waitForRequest(request => request.url().includes(`/sessions/${controller}/messages`));
  await page.goto(`/chat?session=${controller}`);
  await historyRead;
  resolveWorkspace();
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`session=${controller}`));
});

test('phone session drawer keeps Companion distinct and project sessions accessible', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto('/chat?session=sess-1');
  await page.getByRole('button', { name: 'Switch conversation: Direct project work' }).click();
  const drawer = page.getByRole('dialog', { name: 'Conversations', exact: true });
  await drawer.getByRole('button', { name: 'Open Companion chat', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch conversation: Companion chat' }).click();
  await drawer.locator('[data-session-id="sess-1"]').click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('new direct work created from Companion stays selected after reload', async ({ authenticatedPage: page }) => {
  await setup(page);
  let created = false;
  const session = { id: 'direct-new', title: 'New Chat', status: 'active', updatedAt: new Date().toISOString(), messageCount: 0 };
  await page.route('**/api/sessions', route => {
    if (route.request().method() === 'POST') { created = true; return json(route, 200, session); }
    return json(route, 200, { sessions: created ? [session] : [] });
  });
  await page.goto(`/chat?session=${controller}`);
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toBeVisible();
  await page.getByRole('button', { name: 'New work', exact: true }).click();
  await page.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByTestId('current-session-title')).toHaveText('New Chat');
  await expect(page).toHaveURL(/session=direct-new/);
  await page.reload();
  await expect(page.getByTestId('current-session-title')).toHaveText('New Chat');
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toHaveCount(0);
});

for (const emptyDestination of [false, true]) test(`workspace change to ${emptyDestination ? 'empty' : 'populated'} scope replaces the old Companion link and survives reload`, async ({ authenticatedPage: page }) => {
  await setup(page);
  await page.route('**/api/me/workspaces', route => json(route, 200, { workspaces: [
    { id: 'ws-1', userId: 'e2e-user-id', slug: 'default', name: 'Default', isDefault: true },
    { id: 'ws-2', userId: 'e2e-user-id', slug: 'other', name: 'Other project', isDefault: false },
  ] }));
  await page.route('**/api/companion/settings', route => json(route, 200,
    route.request().headers()['x-octipus-workspace'] === 'ws-2' ? { ...settings, supervisorSessionId: null, enabled: false } : settings));
  await page.route('**/api/sessions', route => json(route, 200, { sessions:
    route.request().headers()['x-octipus-workspace'] === 'ws-2'
      ? (emptyDestination ? [] : [{ id: 'other-session', title: 'Other direct work', status: 'active', updatedAt: new Date().toISOString(), messageCount: 0 }])
      : [{ id: controller, title: 'Coordinator', status: 'active', updatedAt: new Date().toISOString(), messageCount: 1 }],
  }));
  await page.goto(`/chat?session=${controller}`);
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toBeVisible();
  await page.getByRole('button', { name: /Switch workspace:/ }).click();
  await page.getByRole('button', { name: /Other project/ }).click();
  const expectedTitle = emptyDestination ? 'Choose a conversation' : 'Other direct work';
  await expect(page.getByTestId('current-session-title')).toHaveText(expectedTitle);
  if (emptyDestination) await expect(page).not.toHaveURL(/session=/);
  else await expect(page).toHaveURL(/session=other-session/);
  await page.reload();
  await expect(page.getByTestId('current-session-title')).toHaveText(expectedTitle);
  await expect(page.getByRole('region', { name: 'Companion chat identity' })).toHaveCount(0);
});
