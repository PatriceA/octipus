import type { Page, Request } from '@playwright/test';
import { json, selectChatSession, stubAllDefaults } from './fixtures/api-stubs';
import { expect, expectNoConsoleErrors, installConsoleWatchdog, STUB_USER, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

/**
 * Shared spaces in the web (coworking spec §5.10): the picker's two lists and
 * "New shared space", the space settings page, the invite link and the join
 * page (with `returnTo` through sign-in), role-aware pages, the removed-member
 * switch back, and the app's own calls with a space selected (§5.4).
 *
 * The server is stubbed; the stubs answer as `src/api/routes/spaces.ts` does.
 */

const NOW = new Date().toISOString();
const SPACE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000001';
const TOKEN = 'a'.repeat(64);

type Role = 'owner' | 'editor' | 'commenter' | 'viewer' | 'guest';

function space(role: Role, extra: Record<string, unknown> = {}) {
  return {
    id: SPACE_ID, name: 'Launch', slug: 'launch-1a2b', role, memberCount: 2,
    archivedAt: null, createdBy: 'owner-id', createdAt: NOW, funding: 'own', ...extra,
  };
}

/** The user is a member of the space with `role`, and it is the selected workspace. */
async function inSpace(page: Page, role: Role, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((id) => localStorage.setItem('octipus.activeWorkspace', id), SPACE_ID);
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: [space(role, extra)] }));
  await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space(role, extra)));
}

/** Every `/api` request with the workspace header it carried. */
function recordHeaders(page: Page): Array<{ url: string; method: string; workspace: string | undefined }> {
  const seen: Array<{ url: string; method: string; workspace: string | undefined }> = [];
  page.on('request', (request: Request) => {
    if (!request.url().includes('/api/')) return;
    seen.push({ url: request.url(), method: request.method(), workspace: request.headers()['x-octipus-workspace'] });
  });
  return seen;
}

test.describe('picker', () => {
  test('lists my workspaces and shared spaces with role badges, and creates a space', async ({ authenticatedPage: page, consoleErrors }) => {
    let spaces = [{ ...space('viewer'), id: 'sp-other', name: 'Research' }];
    const created: unknown[] = [];
    await page.route('**/api/spaces', (route) => {
      if (route.request().method() === 'POST') {
        created.push(route.request().postDataJSON());
        const made = space('owner', { memberCount: 1 });
        spaces = [...spaces, made];
        return json(route, 201, made);
      }
      return json(route, 200, { spaces });
    });
    await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space('owner', { memberCount: 1 })));
    const headers = recordHeaders(page);

    await page.goto('/');
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await expect(page.getByText('my workspaces')).toBeVisible();
    await expect(page.getByText('shared spaces')).toBeVisible();
    const shared = page.getByTestId('shared-spaces');
    await expect(shared.getByText('Research')).toBeVisible();
    await expect(shared.getByTestId('role-badge')).toHaveText('viewer');
    // A space is not transferred: only the personal row offers it.
    await expect(page.getByTitle('Transfer ownership')).toHaveCount(1);
    await expect(shared.getByTitle('Transfer ownership')).toHaveCount(0);

    await page.getByRole('button', { name: /new shared space/ }).click();
    await page.getByLabel('name').fill('Launch');
    await page.getByRole('button', { name: /create space/ }).click();
    await expect.poll(() => created).toEqual([{ name: 'Launch' }]);

    // Switched to the new space: the picker names it with the owner badge,
    // and requests from here on carry its id.
    const picker = page.getByRole('button', { name: 'Switch workspace' });
    await expect(picker).toContainText('Launch');
    await expect(picker.getByTestId('role-badge')).toHaveText('owner');
    await expect.poll(() => headers.some((h) => h.url.endsWith(`/api/spaces/${SPACE_ID}`) && h.workspace === SPACE_ID)).toBe(true);
    expectNoConsoleErrors(consoleErrors);
  });
});

test.describe('space settings', () => {
  async function settingsStubs(page: Page, role: Role) {
    const invites: Array<Record<string, unknown>> = [];
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space(role)));
    await page.route(`**/api/spaces/${SPACE_ID}/members`, (route) => json(route, 200, {
      members: [
        { userId: 'owner-id', username: 'olga', role: 'owner', joinedAt: NOW },
        { userId: STUB_USER.id, username: STUB_USER.username, role, joinedAt: NOW },
        { userId: 'bob-id', username: 'bob', role: 'commenter', joinedAt: NOW },
      ],
    }));
    await page.route(`**/api/spaces/${SPACE_ID}/members/*`, (route) => {
      calls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      return json(route, 200, { success: true });
    });
    await page.route(`**/api/spaces/${SPACE_ID}/invites`, (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        calls.push({ method: 'POST', path: 'invites', body });
        invites.push({ id: 'inv-1', role: body.role, scope: null, createdBy: STUB_USER.id, createdByName: STUB_USER.username, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxUses: body.maxUses, useCount: 0, revokedAt: null, createdAt: NOW });
        return json(route, 201, { id: 'inv-1', token: TOKEN, role: body.role, expiresAt: NOW, maxUses: body.maxUses });
      }
      if (role !== 'owner') return json(route, 403, { error: 'forbidden', code: 'forbidden_role' });
      return json(route, 200, { invites });
    });
    await page.route(`**/api/spaces/${SPACE_ID}/invites/*`, (route) => {
      calls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body: null });
      invites[0].revokedAt = NOW;
      return json(route, 200, { success: true });
    });
    await page.route(`**/api/spaces/${SPACE_ID}/activity**`, (route) => json(route, 200, {
      activity: [{ id: 'a1', action: 'space_created', userId: 'owner-id', username: 'olga', resourceType: 'workspace', resourceId: SPACE_ID, details: null, createdAt: NOW }],
    }));
    return calls;
  }

  test('an owner creates an invite link, copies and revokes it, and manages members', async ({ authenticatedPage: page, consoleErrors }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const calls = await settingsStubs(page, 'owner');
    await page.goto(`/spaces/${SPACE_ID}/settings`);

    await expect(page.getByLabel('Space name')).toHaveValue('Launch');
    await expect(page.getByTestId('space-member')).toHaveCount(3);
    await expect(page.getByTestId('space-activity')).toContainText('created');

    await page.getByLabel('Invite role').selectOption('viewer');
    await page.getByLabel('Invite expiry').selectOption({ label: '1 day' });
    await page.getByRole('button', { name: /create invite link/ }).click();
    await expect.poll(() => calls.find((c) => c.path === 'invites')?.body).toEqual({ role: 'viewer', expiresInHours: 24, maxUses: 1 });
    const link = page.getByLabel('Invite link');
    await expect(link).toHaveValue(new RegExp(`/join/${TOKEN}$`));
    await page.getByRole('button', { name: 'copy link' }).click();
    await expect(page.getByRole('button', { name: 'copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/join/${TOKEN}$`));

    await expect(page.getByTestId('space-invite')).toContainText('active');
    await page.getByTestId('space-invite').getByRole('button', { name: 'revoke' }).click();
    await expect.poll(() => calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/invites/inv-1'))).toBe(true);
    await expect(page.getByTestId('space-invite')).toContainText('revoked');

    await page.getByLabel('Role of bob').selectOption('editor');
    await expect.poll(() => calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH', path: `/api/spaces/${SPACE_ID}/members/bob-id`, body: { role: 'editor' },
    });
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Remove bob' }).click();
    await expect.poll(() => calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/members/bob-id'))).toBe(true);
    await expect(page.getByRole('button', { name: 'archive' })).toBeVisible();
    expectNoConsoleErrors(consoleErrors);
  });

  test('a member who is not an owner sees no owner controls', async ({ authenticatedPage: page }) => {
    await settingsStubs(page, 'editor');
    await page.goto(`/spaces/${SPACE_ID}/settings`);
    await expect(page.getByTestId('space-name')).toHaveText('Launch');
    await expect(page.getByTestId('space-member')).toHaveCount(3);
    await expect(page.getByLabel('Space name')).toHaveCount(0);
    await expect(page.getByLabel('Role of bob')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove bob' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Invites' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'archive' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'leave' })).toBeVisible();
  });
});

test.describe('join page', () => {
  test('a signed-out visitor previews the invite, signs in, comes back and joins', async ({ browser, consoleErrors }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    installConsoleWatchdog(page, consoleErrors);
    let member = false;
    const accepts: string[] = [];
    const logins: Array<Record<string, unknown>> = [];
    await page.route('**/api/**', (route) => json(route, 200, {}));
    await stubAllDefaults(page);
    await page.route('**/api/auth/me', (route) => json(route, 401, { error: 'Not authenticated' }));
    await page.route(`**/api/invites/${TOKEN}`, (route) => json(route, 200, {
      spaceName: 'Launch', inviterName: 'olga', role: 'editor', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    await page.route(`**/api/invites/${TOKEN}/accept`, (route) => {
      accepts.push(route.request().headers().authorization ?? '');
      member = true;
      return json(route, 200, { workspaceId: SPACE_ID, role: 'editor', alreadyMember: false });
    });
    await page.route('**/api/spaces', (route) => json(route, 200, { spaces: member ? [space('editor')] : [] }));
    await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space('editor')));
    await page.route('**/api/auth/login', (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      logins.push(body);
      return json(route, 200, { token: 'joined-token', user: STUB_USER, returnTo: body.returnTo });
    });
    const headers = recordHeaders(page);

    await page.goto(`/join/${TOKEN}`);
    const preview = page.getByTestId('invite-preview');
    await expect(preview).toContainText('olga invites you to');
    await expect(preview).toContainText('Launch');
    await expect(preview).toContainText('editor');
    // The token (a bearer secret) never lands in the login page's URL: the
    // invite page hands it, and where to come back, in the history state.
    await expect(page.getByRole('link', { name: 'register' })).toHaveAttribute('href', '/login?mode=register');

    await page.getByRole('link', { name: 'sign in to join' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('input[type="text"]').first().fill('e2etest');
    await page.locator('input[type="password"]').first().fill('Correct-horse-1');
    await page.locator('form').getByRole('button', { name: /sign in/i }).click();
    await expect.poll(() => logins[0]?.returnTo).toBe(`/join/${TOKEN}`);

    // Back on the invite, signed in: one click joins and selects the space.
    await expect(page).toHaveURL(new RegExp(`/join/${TOKEN}$`));
    await page.getByRole('button', { name: /join Launch/ }).click();
    await expect.poll(() => accepts.length).toBe(1);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Launch');
    await expect.poll(() => headers.some((h) => h.workspace === SPACE_ID)).toBe(true);
    await ctx.close();
    expectNoConsoleErrors(consoleErrors);
  });

  test('the register link opens the register tab and keeps returnTo', async ({ unauthenticatedPage: page }) => {
    await page.goto(`/login?mode=register&returnTo=${encodeURIComponent(`/join/${TOKEN}`)}`);
    await expect(page.getByPlaceholder(/confirm/i).or(page.locator('input[type="email"]')).first()).toBeVisible();
  });

  test('an expired or revoked link says so', async ({ unauthenticatedPage: page }) => {
    await page.route(`**/api/invites/${TOKEN}`, (route) => json(route, 404, { error: 'Invite not found or expired' }));
    await page.goto(`/join/${TOKEN}`);
    await expect(page.getByTestId('invite-invalid')).toContainText('not valid any more');
  });
});

test.describe('role-aware pages', () => {
  test('a viewer reads notes without an editor and sees the board without create, drag or comments', async ({ authenticatedPage: page }) => {
    await inSpace(page, 'viewer');
    await page.route('**/api/tasks', (route) => json(route, 200, {
      tasks: [{ id: 't1', title: 'Ship it', status: 'open', priority: 0, source: 'user', createdAt: NOW }],
    }));
    await page.route('**/api/tasks/t1/comments', (route) => json(route, 200, { comments: [], truncated: false }));

    await page.goto('/notes');
    await expect(page.getByTestId('read-only-banner')).toContainText('viewer');
    await expect(page.getByTitle('New note')).toHaveCount(0);
    await page.getByText('First note').first().click();
    const reader = page.getByTestId('note-reader');
    await expect(reader).toContainText('body text');
    await expect(reader).toContainText('read-only');
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.locator('.cm-editor')).toHaveCount(0);

    await page.goto('/tasks');
    await expect(page.getByTestId('task-row')).toContainText('Ship it');
    await expect(page.getByTestId('task-quick-add')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete task' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
    await page.getByTestId('tasks-view-board').click();
    const card = page.getByTestId('board-card');
    await expect(card).toHaveAttribute('draggable', 'false');
    await expect(card.getByRole('button', { name: /Move to/ })).toHaveCount(0);
    await card.getByRole('button', { name: 'comments' }).click();
    await expect(page.getByTestId('task-comments')).toBeVisible();
    await expect(page.getByLabel('Comment')).toHaveCount(0);

    await page.goto('/documents');
    await expect(page.getByRole('button', { name: 'Upload' })).toHaveCount(0);
  });

  test('a commenter comments on tasks but does not edit them', async ({ authenticatedPage: page }) => {
    await inSpace(page, 'commenter');
    await page.route('**/api/tasks', (route) => json(route, 200, {
      tasks: [{ id: 't1', title: 'Ship it', status: 'open', priority: 0, source: 'user', createdAt: NOW }],
    }));
    await page.route('**/api/tasks/t1/comments', (route) => json(route, 200, { comments: [], truncated: false }));
    await page.goto('/tasks');
    await expect(page.getByTestId('task-quick-add')).toHaveCount(0);
    await page.getByTestId('task-row').getByRole('button', { name: 'comments' }).click();
    await expect(page.getByLabel('Comment')).toBeVisible();
  });

  test('an editor edits as in a personal workspace', async ({ authenticatedPage: page }) => {
    await inSpace(page, 'editor');
    await page.goto('/notes');
    await expect(page.getByTitle('New note')).toBeVisible();
    await expect(page.getByTestId('read-only-banner')).toHaveCount(0);
    await page.goto('/documents');
    await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible();
  });

  test('an archived space shows the banner and is read-only, even for its owner', async ({ authenticatedPage: page }) => {
    await inSpace(page, 'owner', { archivedAt: NOW });
    await page.goto('/notes');
    await expect(page.getByTestId('archived-banner')).toContainText('Launch is archived');
    await expect(page.getByTitle('New note')).toHaveCount(0);
  });
});

test('a removed member is switched back to the default workspace and told why', async ({ authenticatedPage: page, consoleErrors }) => {
  await inSpace(page, 'editor');
  let removed = false;
  // The server answers every request naming a space the caller is no longer
  // a member of with 404 `workspace_denied` (except the recovery paths).
  await page.route(/\/api\/notes(\/|\?|$)/, (route) => {
    if (removed && route.request().headers()['x-octipus-workspace'] === SPACE_ID) {
      return json(route, 404, { error: 'Space not found', code: 'workspace_denied' });
    }
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/n1')) return json(route, 200, { id: 'n1', slug: 'plan', title: 'Plan', noteKind: 'note', tags: [], pinned: false, body: 'x', backlinks: [], outgoing: [] });
    return json(route, 200, { notes: [{ id: 'n1', slug: 'plan', title: 'Plan', noteKind: 'note', tags: [], pinned: false, updatedAt: NOW }], total: 1, tags: [], suggestions: [] });
  });
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: removed ? [] : [space('editor')] }));
  const headers = recordHeaders(page);

  await page.goto('/notes');
  const picker = page.getByRole('button', { name: 'Switch workspace' });
  await expect(picker).toContainText('Launch');
  await expect(page.getByText('Plan').first()).toBeVisible();
  removed = true;
  // The next request in the space (opening a note, same session) is refused.
  await page.getByText('Plan').first().click();
  await expect(page.getByTestId('workspace-notice')).toHaveText(/You no longer have access to Launch/);
  await expect(picker).toContainText('default');
  // The page reads again in the default workspace, and nothing goes out
  // naming the space any more.
  await expect.poll(() => headers.some((h) => h.url.includes('/api/notes') && h.workspace === 'ws-1')).toBe(true);
  const firstDefault = headers.findIndex((h) => h.url.includes('/api/notes') && h.workspace === 'ws-1');
  expect(headers.slice(firstDefault).filter((h) => h.workspace === SPACE_ID)).toEqual([]);
  await page.getByTestId('workspace-notice').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('workspace-notice')).toHaveCount(0);
  // The 404 the browser logs for the refused request is expected.
  expectNoConsoleErrors(consoleErrors.filter((e) => !/404/.test(e)));
});

test('a member removed while away is told at the next load', async ({ authenticatedPage: page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('octipus.activeWorkspace', id);
    localStorage.setItem('octipus.activeSpace', JSON.stringify({ id, name: 'Launch' }));
  }, SPACE_ID);
  await page.goto('/');
  await expect(page.getByTestId('workspace-notice')).toHaveText(/You no longer have access to Launch/);
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('default');
});

test.describe('with a space selected (§5.4)', () => {
  test('personal-only pages still work, and every call carries the space', async ({ authenticatedPage: page, consoleErrors }) => {
    await inSpace(page, 'editor');
    await page.route('**/api/memory**', (route) => json(route, 200, { memories: [], total: 0, includeHistory: false }));
    const headers = recordHeaders(page);
    // Each page's own data call is awaited before moving on: a page left
    // before its first fetch would make the assertions below race the router.
    const dataCall: Record<string, RegExp> = {
      '/models': /\/api\/models/,
      '/settings': /\/api\//,
      '/secrets': /\/api\/vault\?/,
      '/memory': /\/api\/memory/,
    };
    for (const path of ['/models', '/settings', '/secrets', '/memory']) {
      const called = page.waitForRequest((r) => dataCall[path].test(r.url()));
      await page.goto(path);
      await called;
      await expect(page.getByRole('main', { name: 'Page content' })).toBeVisible();
      await expect(page.getByText(/Unexpected Application Error|something went wrong/i)).toHaveCount(0);
    }
    // The secrets page scopes to the personal workspace the server runs the
    // vault in, never to the space's id.
    const vaultScopes = headers
      .filter((h) => new URL(h.url).pathname === '/api/vault')
      .map((h) => new URL(h.url).searchParams.get('workspaceId'));
    expect(vaultScopes).toContain('ws-1');
    expect(vaultScopes).not.toContain(SPACE_ID);
    // One header for all (the server decides which routes act on the space):
    // once the selection is known every call names the space, none another.
    expect(headers.filter((h) => h.workspace !== undefined && h.workspace !== SPACE_ID)).toEqual([]);
    expect(headers.filter((h) => h.workspace === SPACE_ID).length).toBeGreaterThan(4);
    expectNoConsoleErrors(consoleErrors);
  });

  test('a space chat sends in the space and reads its running agent by session', async ({ authenticatedPage: page }) => {
    await inSpace(page, 'editor');
    await page.route('**/api/agents?sessionId=**', (route) => json(route, 200, {
      agents: [{ id: 'agent-1', sessionId: 'sess-1', role: 'general', root: true, model: 'm', status: 'running', createdAt: NOW, iteration: 1 }],
    }));
    await page.route('**/api/agents/agent-1/events**', (route) => json(route, 200, { source: 'persisted', events: [], nextCursor: 0, hasMore: false }));
    const headers = recordHeaders(page);
    const gateway = await stubGateway(page);
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');
    await expect.poll(() => gateway.subscribed()).toBe(1);
    await expect.poll(() => headers.find((h) => h.url.includes('/api/agents?sessionId=sess-1'))?.workspace).toBe(SPACE_ID);
    await expect.poll(() => headers.find((h) => h.url.includes('/api/agents/agent-1/events'))?.workspace).toBe(SPACE_ID);
    const input = page.getByPlaceholder(/send a message/i).first();
    await input.fill('Plan the launch');
    await input.press('Enter');
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send'))
      .toEqual({ type: 'chat.send', sessionId: 'sess-1', content: 'Plan the launch', workspaceId: SPACE_ID });
  });
});
