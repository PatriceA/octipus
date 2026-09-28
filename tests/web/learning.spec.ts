import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test('learning receipts show real outcomes and manual check stays out of chat', async ({ authenticatedPage: page }) => {
  let requested = false;
  await page.route('**/api/sessions/sess-1/learning', route => {
    if (route.request().method() === 'POST') { requested = true; return json(route, 202, { id: 'job2', status: 'queued' }); }
    return json(route, 200, { checks: [{ id: 'job1', title: 'Learning check: completed plan', status: 'error', stage: 'partial_failure',
      error: 'Indexing unavailable', createdAt: '2026-09-28T10:00:00Z',
      result: { reason: 'Found a reusable fix', outputs: [{ kind: 'skill', status: 'proposed', id: 'proposal1' }, { kind: 'knowledge', status: 'saved_unindexed', id: 'note1' }] } }] });
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toHaveCount(0);
  const panel = page.getByTestId('learning-panel');
  await panel.locator('summary').click();
  await expect(panel).toContainText('Found a reusable fix');
  await expect(panel).toContainText('skill: proposed');
  await expect(panel).toContainText('knowledge: saved unindexed');
  await panel.getByRole('button', { name: 'Check recent work' }).click();
  await expect.poll(() => requested).toBe(true);
  await expect(page.getByPlaceholder('Send a message or change direction...')).toHaveValue('');
});
