import type { Page } from '@playwright/test';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import { expect, expectNoConsoleErrors, installConsoleWatchdog, STUB_USER, test } from './fixtures/auth';

/**
 * Guests and registration modes in the web (coworking spec §10, S6):
 *
 *   - the invite dialog lets an owner make a guest invite with rooms and
 *     folders, and the members list edits a guest's access;
 *   - the sign-in page honours `security.registration`: `closed` hides the
 *     register tab, `invite_only` says an invite is required unless the
 *     visitor came from an invite link, whose token is sent with the
 *     registration, and the joined space is selected.
 *
 * The server is stubbed; the stubs answer as `src/api/routes/spaces.ts` and
 * `src/api/routes/auth.ts` do.
 */

const NOW = new Date().toISOString();
const SPACE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000002';
const CLIENT_ROOM = '0b9d3c55-5f2c-4c37-9a3e-6d1f0000c001';
const GENERAL_ROOM = '0b9d3c55-5f2c-4c37-9a3e-6d1f0000c002';
const TOKEN = 'b'.repeat(64);

function space(role: string) {
  return { id: SPACE_ID, name: 'Launch', slug: 'launch-2b', role, memberCount: 3, archivedAt: null, createdBy: STUB_USER.id, createdAt: NOW, funding: 'own' };
}

function room(id: string, title: string, visibility = 'space') {
  return { id, workspaceId: SPACE_ID, title, visibility, createdBy: STUB_USER.id, createdAt: NOW, updatedAt: NOW, unreadCount: 0, muted: false };
}

async function ownerSettings(page: Page) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space('owner')));
  await page.route(`**/api/spaces/${SPACE_ID}/rooms`, (route) => json(route, 200, {
    rooms: [room(GENERAL_ROOM, 'General'), room(CLIENT_ROOM, 'Client')],
  }));
  await page.route(`**/api/spaces/${SPACE_ID}/members`, (route) => json(route, 200, {
    members: [
      { userId: STUB_USER.id, username: STUB_USER.username, role: 'owner', joinedAt: NOW },
      { userId: 'gina-id', username: 'gina', role: 'guest', joinedAt: NOW, scope: { rooms: [CLIENT_ROOM], folders: ['client'] } },
    ],
  }));
  await page.route(`**/api/spaces/${SPACE_ID}/members/*`, (route) => {
    calls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return json(route, 200, { userId: 'gina-id', username: 'gina', role: 'guest', joinedAt: NOW });
  });
  await page.route(`**/api/spaces/${SPACE_ID}/invites`, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      calls.push({ method: 'POST', path: 'invites', body });
      return json(route, 201, { id: 'inv-1', token: TOKEN, role: body.role, expiresAt: NOW, maxUses: body.maxUses });
    }
    return json(route, 200, { invites: [] });
  });
  await page.route(`**/api/spaces/${SPACE_ID}/activity**`, (route) => json(route, 200, { activity: [] }));
  return calls;
}

test.describe('guest invites and access', () => {
  test('an owner invites a guest to chosen rooms and folders, and edits a guest\'s access', async ({ authenticatedPage: page, consoleErrors }) => {
    const calls = await ownerSettings(page);
    await page.goto(`/spaces/${SPACE_ID}/settings`);

    // No scope fields until the role is guest.
    await expect(page.getByTestId('guest-scope')).toHaveCount(0);
    await page.getByLabel('Invite role').selectOption('guest');
    const scope = page.getByTestId('guest-scope');
    await expect(scope).toBeVisible();
    await scope.getByLabel('Guest room Client').check();
    await scope.getByLabel('Guest folders').fill('client\nshared/specs');
    await page.getByRole('button', { name: /create invite link/ }).click();
    await expect.poll(() => calls.find((c) => c.path === 'invites')?.body).toEqual({
      role: 'guest',
      scope: { rooms: [CLIENT_ROOM], folders: ['client', 'shared/specs'] },
      expiresInHours: 168,
      maxUses: 1,
    });
    await expect(page.getByTestId('invite-link')).toContainText('will see 1 room and folders client, shared/specs');

    // The guest's access, from the members list.
    const summary = page.getByTestId('guest-scope-summary');
    await expect(summary).toContainText('sees 1 room and folder client');
    await summary.getByRole('button', { name: 'edit access' }).click();
    const editor = page.getByTestId('space-member').filter({ hasText: 'gina' }).getByTestId('guest-scope');
    await editor.getByLabel('Guest room General').check();
    await editor.getByLabel('Guest folders').fill('client');
    await page.getByRole('button', { name: /save access/ }).click();
    await expect.poll(() => calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `/api/spaces/${SPACE_ID}/members/gina-id`,
      body: { role: 'guest', scope: { rooms: [CLIENT_ROOM, GENERAL_ROOM], folders: ['client'] } },
    });
    expectNoConsoleErrors(consoleErrors);
  });
});

test.describe('registration modes', () => {
  async function signedOut(page: Page, mode: string, firstAccount = false) {
    await page.route('**/api/auth/registration', (route) => json(route, 200, { mode, firstAccount }));
  }

  test('closed: no register tab, even from the register link', async ({ unauthenticatedPage: page }) => {
    await signedOut(page, 'closed');
    await page.goto('/login?mode=register');
    await expect(page.locator('form').getByRole('button', { name: /sign in/i })).toBeVisible();
    await expect(page.getByTestId('register-tab')).toHaveCount(0);
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });

  test('closed, but no account yet: the first account may register', async ({ unauthenticatedPage: page }) => {
    await signedOut(page, 'closed', true);
    await page.goto('/login?mode=register');
    await expect(page.getByTestId('register-tab')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('invite_only without an invite: "invite required", no form', async ({ unauthenticatedPage: page }) => {
    await signedOut(page, 'invite_only');
    await page.goto('/login');
    await page.getByTestId('register-tab').click();
    await expect(page.getByTestId('invite-required')).toContainText('invite required');
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });

  test('invite_only from an invite link: registering sends the token and lands in the joined space', async ({ browser, consoleErrors }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    installConsoleWatchdog(page, consoleErrors);
    let registered = false;
    const registrations: Array<Record<string, unknown>> = [];
    await page.route('**/api/**', (route) => json(route, 200, {}));
    await stubAllDefaults(page);
    await page.route('**/api/auth/me', (route) => (registered ? json(route, 200, STUB_USER) : json(route, 401, { error: 'Not authenticated' })));
    await signedOut(page, 'invite_only');
    await page.route(`**/api/invites/${TOKEN}`, (route) => json(route, 200, {
      spaceName: 'Launch', inviterName: 'olga', role: 'guest', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    await page.route('**/api/auth/register', (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      registrations.push(body);
      registered = true;
      return json(route, 200, { id: STUB_USER.id, user: STUB_USER, token: 'new-token', returnTo: body.returnTo, joinedSpaceId: SPACE_ID });
    });
    await page.route('**/api/spaces', (route) => json(route, 200, { spaces: registered ? [space('guest')] : [] }));
    await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space('guest')));

    await page.goto(`/join/${TOKEN}`);
    await expect(page.getByTestId('invite-preview')).toContainText('see only the rooms and folders you are given');
    await page.getByRole('link', { name: 'register' }).click();
    await expect(page.getByTestId('invite-required')).toHaveCount(0);
    await page.locator('input[type="text"]').first().fill('newguest');
    await page.locator('input[type="email"]').fill('newguest@example.com');
    await page.locator('input[type="password"]').nth(0).fill('Correct-horse-1');
    await page.locator('input[type="password"]').nth(1).fill('Correct-horse-1');
    await page.locator('form').getByRole('button', { name: /create account/i }).click();
    await expect.poll(() => registrations[0]?.inviteToken).toBe(TOKEN);
    // The invite was spent with the account: the app opens in its space.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Launch');
    await ctx.close();
    expectNoConsoleErrors(consoleErrors);
  });
});
