import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

/**
 * Group channels in the web UI, every /api call stubbed:
 *   - Settings → Channels: the owner's enrolments, move to another workspace, remove;
 *   - Admin → Group channels: every enrolment with owner, paused state, revoke.
 *
 * Screenshots go to $GROUP_CHANNEL_SHOTS when set.
 */

const SHOTS = process.env.GROUP_CHANNEL_SHOTS;
const WS_DEFAULT = '33333333-3333-4333-8333-333333333333';
const WS_CLIENT = '44444444-4444-4444-4444-444444444444';

const row = (over: Record<string, unknown>) => ({
  channelType: 'slack', label: null, ownerUserId: 'e2e-user-id', ownerName: 'e2etest', ownerActive: true,
  workspaceId: WS_DEFAULT, workspaceName: 'Default', createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z',
  ...over,
});

test.describe('group channels', () => {
  test('owner moves an enrolment to another workspace and removes one', async ({ authenticatedPage: page }) => {
    let mine = [
      row({ id: 'g-release', channelId: 'C0RELEASE', label: '#release' }),
      row({ id: 'g-ops', channelId: 'C0OPS' }),
    ];
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    await stubAllDefaults(page);
    await page.route('**/api/me/workspaces', (route) => json(route, 200, {
      workspaces: [{ id: WS_DEFAULT, name: 'Default' }, { id: WS_CLIENT, name: 'Client A' }],
    }));
    await page.route(/\/api\/me\/group-channels/, async (route: Route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const body = req.postDataJSON?.() ?? undefined;
      calls.push({ method: req.method(), path, body });
      const id = path.split('/').pop();
      if (req.method() === 'GET') return json(route, 200, { groupChannels: mine });
      if (req.method() === 'PATCH') {
        const ws = (body as { workspaceId: string }).workspaceId;
        mine = mine.map((g) => (g.id === id ? { ...g, workspaceId: ws, workspaceName: ws === WS_CLIENT ? 'Client A' : 'Default' } : g));
        return json(route, 200, mine.find((g) => g.id === id));
      }
      if (req.method() === 'DELETE') {
        mine = mine.filter((g) => g.id !== id);
        return json(route, 200, { deleted: true });
      }
      return json(route, 404, { error: 'unexpected' });
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Channels' }).click();
    await expect(page.getByRole('heading', { name: 'Group channels' })).toBeVisible();
    await expect(page.getByText('#release')).toBeVisible();
    await expect(page.getByText('C0OPS')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-group-channels.png`, fullPage: true });

    await page.getByRole('listitem').filter({ hasText: '#release' }).getByRole('combobox').selectOption(WS_CLIENT);
    await expect.poll(() => calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH', path: '/api/me/group-channels/g-release', body: { workspaceId: WS_CLIENT },
    });

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Remove from C0OPS' }).click();
    await expect(page.getByText('C0OPS')).toHaveCount(0);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/me/group-channels/g-ops')).toBe(true);
  });

  test('empty state explains how to enrol', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/me/workspaces', (route) => json(route, 200, { workspaces: [] }));
    await page.route('**/api/me/group-channels', (route) => json(route, 200, { groupChannels: [] }));
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Channels' }).click();
    await expect(page.getByText('no group channels enrolled')).toBeVisible();
    await expect(page.getByText('@Octipus join')).toBeVisible();
  });

  test('admin sees every enrolment, a paused one, and revokes', async ({ authenticatedPage: page }) => {
    let all = [
      row({ id: 'g-release', channelId: 'C0RELEASE', label: '#release', ownerName: 'anna' }),
      row({ id: 'g-old', channelId: 'C0OLD', label: '#legacy', ownerName: 'carol', ownerActive: false, workspaceName: 'Carol ws' }),
    ];
    await stubAllDefaults(page);
    await page.route(/\/api\/admin\/group-channels/, async (route: Route) => {
      const req = route.request();
      const id = new URL(req.url()).pathname.split('/').pop();
      if (req.method() === 'GET') return json(route, 200, { groupChannels: all });
      if (req.method() === 'DELETE') {
        all = all.filter((g) => g.id !== id);
        return json(route, 200, { deleted: true });
      }
      return json(route, 404, { error: 'unexpected' });
    });

    await page.goto('/admin/group-channels');
    await expect(page.getByRole('link', { name: 'Group channels' })).toBeVisible();
    await expect(page.getByText('anna · Default')).toBeVisible();
    await expect(page.getByText('paused (owner deactivated)')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/admin-group-channels.png`, fullPage: true });

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Revoke #legacy' }).click();
    await expect(page.getByText('#legacy')).toHaveCount(0);
  });

  test('the notification destinations tab loads (it was missing from the router)', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/admin/notification-destinations', (route) => json(route, 200, { destinations: [], channelTypes: ['slack'] }));
    await page.route('**/api/admin/orgs', (route) => json(route, 404, { error: 'not found' }));
    await page.goto('/admin/destinations');
    await expect(page.getByText('no shared destinations approved')).toBeVisible();
  });
});
