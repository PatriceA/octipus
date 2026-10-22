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
        Object.assign(me, body, body.watchEmail ? { watchEmailSince: '2026-10-22T08:00:00Z' } : {});
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) });
    });
  });

  test('turns the heartbeat on, checks every 15 minutes and watches the inbox', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Heartbeat' }).click();
    const card = page.getByTestId('heartbeat-settings');
    await expect(card).toContainText('without using any AI');
    // Controlled by the server's answer: click, then wait for the saved state.
    await card.getByLabel('Run my heartbeat').click();
    await expect(card.getByLabel('Run my heartbeat')).toBeChecked();
    await card.getByLabel('Check interval').selectOption('15');
    await expect(card.getByLabel('Check interval')).toHaveValue('15');
    await card.getByLabel('Watch my inbox').click();
    await expect(card.getByLabel('Watch my inbox')).toBeChecked();
    expect(puts).toEqual([{ enabled: true }, { intervalMinutes: 15 }, { watchEmail: true }]);
    await expect(card).toContainText('checked every 15 minutes');
    await expect(card).toContainText('Watching mail received since');
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
