import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

/** The caller's own heartbeat, on the settings page: on/off, interval, inbox watch, what it did. */
test.describe('heartbeat settings', () => {
  let me: Record<string, unknown>;
  let puts: unknown[];

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    puts = [];
    me = {
      enabled: false,
      intervalMinutes: null,
      watchEmail: false,
      watchEmailSince: null,
      server: { enabled: true, intervalMinutes: 60, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC', maxRunsPerDay: 24, probeEmail: true },
      mailbox: 'google',
      standingInstructions: false,
      recentEmail: [],
    };
    await page.route('**/api/heartbeat/me', async (route) => {
      const req = route.request();
      if (req.method() === 'PUT') {
        const body = req.postDataJSON() as Record<string, unknown>;
        puts.push(body);
        if (body.enabled === true) (me.server as { enabled: boolean }).enabled = true;
        Object.assign(me, body, body.watchEmail ? { watchEmailSince: '2026-10-22T08:00:00Z' } : {});
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) });
    });
  });

  test('turns the heartbeat on, checks every 15 minutes and watches the inbox', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Heartbeat' }).click();
    const card = page.getByTestId('heartbeat-settings');
    await expect(card).toContainText('without a chat or AI call');
    // Controlled by the server's answer: click, then wait for the saved state.
    await card.getByLabel('Run my heartbeat').click();
    await expect(card.getByLabel('Run my heartbeat')).toBeChecked();
    await card.getByLabel('Check interval').selectOption('15');
    await expect(card.getByLabel('Check interval')).toHaveValue('15');
    await card.getByLabel('Watch my inbox').click();
    await expect(card.getByLabel('Watch my inbox')).toBeChecked();
    expect(puts).toEqual([{ enabled: true }, { intervalMinutes: 15 }, { watchEmail: true }]);
    await expect(card).toContainText('every 15 minutes');
    await expect(card).toContainText('Watching mail received since');
  });

  test('one heartbeat setting activates an admin’s saved preference and its server prerequisite', async ({ authenticatedPage: page }) => {
    Object.assign(me, { enabled: true, server: { ...(me.server as object), enabled: false } });
    await page.goto('/settings?tab=heartbeat');
    const card = page.getByTestId('heartbeat-settings');
    await expect(card.getByLabel('Run my heartbeat')).not.toBeChecked();
    await card.getByLabel('Run my heartbeat').click();
    await expect.poll(() => puts).toEqual([{ enabled: true }]);
    await expect(card.getByLabel('Run my heartbeat')).toBeChecked();
    await expect(card).not.toContainText('switched off on this server');
    await expect(card.getByRole('button', { name: 'Enable heartbeat on this server' })).toHaveCount(0);
  });

  test('a member can revoke a saved personal heartbeat while the server is paused', async ({ authenticatedPage: page }) => {
    Object.assign(me, { enabled: true, server: { ...(me.server as object), enabled: false } });
    await page.route('**/api/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'e2e-user-id', username: 'member', isAdmin: false }) }));
    await page.goto('/settings?tab=heartbeat');
    const card = page.getByTestId('heartbeat-settings');
    await expect(card.getByLabel('Run my heartbeat')).toBeDisabled();
    await card.getByRole('button', { name: 'Turn off saved personal heartbeat' }).click();
    await expect.poll(() => puts).toEqual([{ enabled: false }]);
    await expect(card.getByRole('button', { name: 'Turn off saved personal heartbeat' })).toHaveCount(0);
    expect((me.server as { enabled: boolean }).enabled).toBe(false);
  });

  test('says why nothing runs, and what the agent did with recent mail', async ({ authenticatedPage: page }) => {
    Object.assign(me, {
      server: { ...(me.server as object), enabled: false },
      mailbox: null,
      recentEmail: [{ provider: 'google', messageId: 'm1', outcome: 'drafted', note: 'Answered the invoice question', taskId: null, handledAt: '2026-10-22T09:00:00Z' }],
    });
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Heartbeat' }).click();
    const card = page.getByTestId('heartbeat-settings');
    await expect(card).toContainText('switched off on this server');
    await expect(card.getByLabel('Watch my inbox')).toBeDisabled();
    await expect(card).toContainText('Connect Google or Microsoft 365');
    await expect(card).toContainText('Reply draft saved');
    await expect(card).toContainText('Answered the invoice question');
  });
});

test('an inherited role can be paused in Settings without turning off personal checks', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  const role = { role: 'coding', activeTasks: 1, totalTasks: 1, enabled: true, inherited: true, hookId: null as string | null, known: true, pipelineTemplate: null };
  const changes: unknown[] = [];
  await page.route('**/api/heartbeat/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    enabled: true, intervalMinutes: null, watchEmail: false, watchEmailSince: null,
    server: { enabled: true, intervalMinutes: 60, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC', maxRunsPerDay: 24, probeEmail: true },
    mailbox: 'google', standingInstructions: false, recentEmail: [],
  }) }));
  await page.route('**/api/tasks/role-agents', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      changes.push(body);
      Object.assign(role, { enabled: body.enabled, inherited: false, hookId: 'paused-role-hook' });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ roles: [role], boardWritesAllowed: true, heartbeatEnabled: true }) });
  });
  await page.goto('/settings?tab=heartbeat');
  const panel = page.getByTestId('role-agents');
  await panel.getByRole('button', { name: /Role agents/ }).click();
  await expect(panel).toContainText('follows personal heartbeat');
  const toggle = panel.getByRole('switch', { name: 'coding agent' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(panel).not.toContainText('follows personal heartbeat');
  await expect(page.getByLabel('Run my heartbeat')).toBeChecked();
  expect(changes).toEqual([{ role: 'coding', enabled: false }]);
  await expect(page.getByTestId('heartbeat-settings')).toContainText('without a chat or AI call');
});
