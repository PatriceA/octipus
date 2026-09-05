import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

const digest = {
  since: new Date(Date.now() - 86400_000).toISOString(),
  until: new Date().toISOString(),
  agents: {
    completed: [{ id: 'ag-1', role: 'coding', status: 'completed', durationMs: 95000 }],
    failed: [{ id: 'ag-2', role: 'qa', status: 'failed', error: 'exit 1' }],
  },
  pipelines: [{ id: 'p-1', title: 'Bug Fix', status: 'awaiting_approval', waitingOnYou: true }],
  approvals: [{ id: 'r-1', sessionId: 's-1', summary: 'Delete branch', question: 'Proceed?' }],
  jobs: [
    { id: 'j-1', kind: 'research', title: 'Is PGlite production-ready?', status: 'done', resultRef: 'doc-1' },
    { id: 'j-2', kind: 'document', title: 'invoice.pdf', status: 'error', error: 'OCR model unavailable' },
  ],
  tasks: [{ id: 't-1', title: 'Reply to Ada', source: 'email' }],
  unreadNotifications: 2,
  empty: false,
};

test.describe('dashboard — while you were away', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
  });

  test('lists what needs the user first and links each item', async ({ authenticatedPage: page }) => {
    await page.route('**/api/digest/away**', (route) => json(route, 200, digest));
    await page.goto('/');
    const card = page.getByTestId('away-digest');
    await expect(card.getByText('Delete branch')).toBeVisible();
    await expect(card.getByText('Bug Fix')).toBeVisible();
    await expect(card.getByText(/exit 1/)).toBeVisible();
    await expect(card.getByRole('link', { name: 'qa' })).toHaveAttribute('href', '/agents/view?id=ag-2');
    await expect(card.getByRole('link', { name: 'Reply to Ada' })).toHaveAttribute('href', '/tasks');
    await expect(card.getByText(/OCR model unavailable/)).toBeVisible();
    await expect(card.getByRole('link', { name: 'Is PGlite production-ready?' })).toHaveAttribute('href', '/documents?id=doc-1');
    await expect(card.getByRole('link', { name: /2 new unread/ })).toHaveAttribute('href', '/notifications');
    // Sections render in "needs you first" order.
    const titles = await card.locator('p.uppercase').allTextContents();
    expect(titles.map((t) => t.split(' — ')[0])).toEqual(['waiting on you', 'pipelines waiting on you', 'failed', 'background work failed', 'finished', 'background work', 'new to-dos for you']);
  });

  test('"caught up" moves the window start to now and re-asks the server', async ({ authenticatedPage: page }) => {
    let calls = 0;
    await page.route('**/api/digest/away**', (route) => {
      calls += 1;
      const since = new URL(route.request().url()).searchParams.get('since');
      // First call: no remembered `since`. After "caught up": a since of roughly now.
      if (!since) return json(route, 200, digest);
      const ageMs = Date.now() - new Date(since).getTime();
      expect(ageMs).toBeLessThan(60_000);
      return json(route, 200, { ...digest, since, agents: { completed: [], failed: [] }, pipelines: [], approvals: [], jobs: [], tasks: [], unreadNotifications: 0, empty: true });
    });
    await page.goto('/');
    const card = page.getByTestId('away-digest');
    await card.getByRole('button', { name: /caught up/ }).click();
    await expect(card.getByText(/nothing happened/)).toBeVisible();
    expect(calls).toBeGreaterThanOrEqual(2);
    // The window start is remembered across reloads.
    await page.reload();
    await expect(page.getByTestId('away-digest').getByText(/nothing happened/)).toBeVisible();
  });

  test('renders nothing when the digest cannot be fetched', async ({ authenticatedPage: page }) => {
    await page.route('**/api/digest/away**', (route) => json(route, 500, { error: 'boom' }));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('away-digest')).toHaveCount(0);
  });

  test('a failed poll keeps the last good digest on screen', async ({ authenticatedPage: page }) => {
    let calls = 0;
    await page.route('**/api/digest/away**', (route) => {
      calls += 1;
      return calls === 1 ? json(route, 200, digest) : json(route, 502, { error: 'gateway' });
    });
    await page.goto('/');
    const card = page.getByTestId('away-digest');
    await expect(card.getByText('Delete branch')).toBeVisible();
    // Force a refetch (window focus triggers react-query's refetchOnWindowFocus).
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(500);
    await expect(card.getByText('Delete branch')).toBeVisible();
  });
});
