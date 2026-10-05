import type { Route } from '@playwright/test';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

/**
 * The group-channel bridge and space connectors in the web (coworking §9.4,
 * §9.5), every /api call stubbed as the server answers:
 *   - Settings → Channels: "Bind to space room" lists the spaces the user
 *     owns, needs the acknowledgement before it binds, then shows the
 *     binding and unbinds;
 *   - Space settings → Connectors: owners paste a GitHub token, start an
 *     OAuth connector (its popup URL) and disconnect; others only read.
 */

const NOW = new Date().toISOString();
const SPACE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000002';
const ROOM_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000003';

const channel = (over: Record<string, unknown> = {}) => ({
  id: 'g-release', channelType: 'slack', channelId: 'C0RELEASE', label: '#release', ownerUserId: 'e2e-user-id', ownerName: 'e2etest',
  ownerActive: true, mode: 'mention', quietHoursStart: null, quietHoursEnd: null, timezone: 'UTC', maxUnpromptedPerDay: 8,
  minMinutesBetween: 60, lastUnpromptedAt: null, feedback: { up: 0, down: 0 }, workspaceId: null, spaceName: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});

const space = (role: string, over: Record<string, unknown> = {}) => ({
  id: SPACE_ID, name: 'Launch', slug: 'launch-1', role, memberCount: 3, archivedAt: null, createdBy: 'e2e-user-id', createdAt: NOW, funding: 'own', ...over,
});

test.describe('bind a group channel to a space room', () => {
  test('the owner binds after acknowledging, sees the binding, and unbinds', async ({ authenticatedPage: page }) => {
    let mine = [channel()];
    const binds: unknown[] = [];
    let unbinds = 0;
    await stubAllDefaults(page);
    await page.route('**/api/spaces', (route) => json(route, 200, {
      spaces: [space('owner'), space('editor', { id: 'sp-other', name: 'Not mine' })],
    }));
    await page.route(`**/api/spaces/${SPACE_ID}/rooms`, (route) => json(route, 200, {
      rooms: [
        { id: ROOM_ID, title: 'General', visibility: 'space' },
        { id: 'r-private', title: 'Secret', visibility: 'private' },
      ],
    }));
    await page.route(/\/api\/me\/group-channels/, async (route: Route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'GET') return json(route, 200, { groupChannels: mine });
      if (req.method() === 'POST' && path.endsWith('/bind')) {
        binds.push(req.postDataJSON());
        mine = [channel({ workspaceId: SPACE_ID, spaceName: 'Launch' })];
        return json(route, 200, { groupChannel: mine[0] });
      }
      if (req.method() === 'DELETE' && path.endsWith('/bind')) {
        unbinds++;
        mine = [channel()];
        return json(route, 200, { groupChannel: mine[0] });
      }
      return json(route, 404, { error: 'unexpected' });
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Channels' }).click();
    await page.getByRole('button', { name: 'Bind to space room' }).click();
    const form = page.getByRole('form', { name: 'Bind #release to a space room' });
    const spaceSelect = form.getByRole('combobox').first();
    // Only the spaces the user owns.
    await expect(spaceSelect.locator('option')).toHaveText(['Choose a space…', 'Launch']);
    await spaceSelect.selectOption(SPACE_ID);
    const roomSelect = form.getByRole('combobox').nth(1);
    // Only open rooms: the channel reads what the room shows.
    await expect(roomSelect.locator('option')).toHaveText(['A new room per thread', 'General (main thread)']);
    await roomSelect.selectOption(ROOM_ID);

    const bind = form.getByRole('button', { name: 'Bind' });
    await expect(bind).toBeDisabled();
    await form.getByText('everyone in this channel can read what the room shows').click();
    await expect(bind).toBeEnabled();
    await bind.click();

    await expect.poll(() => binds.length).toBe(1);
    expect(binds[0]).toEqual({ workspaceId: SPACE_ID, acknowledged: true, roomId: ROOM_ID });
    await expect(page.getByTestId('bound-g-release')).toContainText('Launch');

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Unbind' }).click();
    await expect.poll(() => unbinds).toBe(1);
    await expect(page.getByRole('button', { name: 'Bind to space room' })).toBeVisible();
  });
});

test.describe('space connectors', () => {
  async function stubs(page: import('@playwright/test').Page, role: string) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    let connectors = [
      { id: 'github', name: 'GitHub', description: 'A GitHub token', kind: 'token', connected: false, connectedBy: null, connectedAt: null },
      { id: 'linear', name: 'Linear', description: 'Linear issues', kind: 'oauth', connected: true, connectedBy: 'olga', connectedAt: NOW },
    ];
    await stubAllDefaults(page);
    await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space(role)));
    await page.route(`**/api/spaces/${SPACE_ID}/members`, (route) => json(route, 200, { members: [] }));
    await page.route(`**/api/spaces/${SPACE_ID}/invites`, (route) => json(route, 200, { invites: [] }));
    await page.route(`**/api/spaces/${SPACE_ID}/activity**`, (route) => json(route, 200, { activity: [] }));
    await page.route(`**/api/spaces/${SPACE_ID}/connectors**`, (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'GET') return json(route, 200, { connectors });
      const id = path.split('/').pop();
      calls.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });
      if (req.method() === 'DELETE') {
        connectors = connectors.map((c) => (c.id === id ? { ...c, connected: false, connectedBy: null } : c));
        return json(route, 200, { removed: 1 });
      }
      if (id === 'github') {
        connectors = connectors.map((c) => (c.id === 'github' ? { ...c, connected: true, connectedBy: 'e2etest' } : c));
        return json(route, 200, { connected: true });
      }
      return json(route, 200, { url: 'about:blank#oauth' });
    });
    return calls;
  }

  test('an owner connects GitHub with a token and disconnects Linear', async ({ authenticatedPage: page }) => {
    const calls = await stubs(page, 'owner');
    await page.goto(`/spaces/${SPACE_ID}/settings`);
    const section = page.getByRole('region', { name: 'Connectors' });
    await expect(section.getByTestId('space-connector-linear')).toContainText('connected by olga');

    await section.getByTestId('space-connector-github').getByRole('button', { name: 'Connect' }).click();
    await section.getByLabel('GitHub token').fill('ghp_team');
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByTestId('space-connector-github')).toContainText('connected by e2etest');
    expect(calls).toContainEqual({ method: 'POST', path: `/api/spaces/${SPACE_ID}/connectors/github`, body: { token: 'ghp_team' } });

    await section.getByTestId('space-connector-linear').getByRole('button', { name: 'Disconnect' }).click();
    await expect(section.getByTestId('space-connector-linear')).toContainText('not connected');
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/connectors/linear'))).toBe(true);
  });

  test('a member who is not an owner reads the connectors but has no controls', async ({ authenticatedPage: page }) => {
    await stubs(page, 'editor');
    await page.goto(`/spaces/${SPACE_ID}/settings`);
    const section = page.getByRole('region', { name: 'Connectors' });
    await expect(section.getByTestId('space-connector-github')).toContainText('not connected');
    await expect(section.getByRole('button', { name: 'Connect' })).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
  });
});
