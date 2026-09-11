import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import type { WorkPlanState } from '../../src/shared/work-plan';

test('plan stays with the conversation, saves feedback, reloads and exposes evidence', async ({ authenticatedPage: page }) => {
  let state: WorkPlanState = { revision: 1, previous: [], current: {
    id: 'plan-1', revision: 1, title: 'Improve retry handling', goal: 'Keep the API and handle timeouts', updatedAt: new Date().toISOString(),
    steps: [
      { id: 'inspect', title: 'Inspect current behaviour', status: 'done', evidence: 'Read retry.ts; tests have not run.' },
      { id: 'change', title: 'Update retry handling', status: 'working', evidence: '' },
      { id: 'check', title: 'Run focused checks', status: 'pending', evidence: '' },
    ], feedback: [], history: [{ revision: 1, summary: 'Initial approach', at: new Date().toISOString() }],
  } };
  await page.route('**/api/sessions/*/plan', route => json(route, 200, state));
  await page.route('**/api/sessions/*/plan/feedback', async route => {
    const input = route.request().postDataJSON();
    expect(input.revision).toBe(state.revision);
    state = { ...state, revision: 2, current: { ...state.current!, revision: 2, feedback: [{ id: 'feedback-1', text: input.text, status: 'pending', createdAt: new Date().toISOString() }] } };
    await json(route, 200, state);
  });
  await page.goto('/chat');
  await page.getByLabel('Current conversation').selectOption('sess-1');
  const panel = page.getByRole('region', { name: 'Work plan' });
  await expect(panel.getByText('1 of 3 steps done')).toBeVisible();
  await panel.getByText('Inspect current behaviour', { exact: true }).click();
  await expect(panel.getByText('Read retry.ts; tests have not run.')).toBeVisible();
  await panel.getByRole('button', { name: 'Adjust plan' }).click();
  await panel.getByLabel('What should change?').fill('Keep the public API');
  await panel.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(panel.getByText('Pending', { exact: true }).last()).toBeVisible();
  await page.reload();
  await page.getByLabel('Current conversation').selectOption('sess-1');
  await expect(panel.getByText('Keep the public API')).toBeVisible();
  await page.screenshot({ path: '/tmp/deepsea-app-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByLabel('Current conversation').selectOption('sess-1');
  await expect(panel.getByText('1 of 3 steps done')).toBeVisible();
  await panel.getByRole('button', { name: /Open/ }).click();
  await expect(panel.getByText('Improve retry handling')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/deepsea-app-mobile.png' });
});

test('failed feedback keeps the draft and never claims it was saved', async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/*/plan', route => json(route, 200, { revision: 1, previous: [], current: { id: 'p', revision: 1, title: 'Research', goal: 'Find sources', steps: [{ id: 's', title: 'Read sources', status: 'pending', evidence: '' }], feedback: [], history: [], updatedAt: '' } }));
  await page.route('**/api/sessions/*/plan/feedback', route => json(route, 409, { error: 'Plan changed. Refresh and try again.' }));
  await page.goto('/chat');
  await page.getByLabel('Current conversation').selectOption('sess-1');
  await page.getByRole('button', { name: 'Adjust plan' }).click();
  await page.getByLabel('What should change?').fill('Use primary sources');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByLabel('What should change?')).toHaveValue('Use primary sources');
  await expect(page.getByRole('alert')).toContainText('Plan changed');
  await expect(page.getByText('Feedback saved.', { exact: false })).toHaveCount(0);
});

test('malformed plan data is unavailable without breaking the conversation', async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/*/plan', route => json(route, 200, {}));
  await page.goto('/chat');
  await page.getByLabel('Current conversation').selectOption('sess-1');
  await expect(page.getByText('Plan unavailable.', { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder('Send a message or change direction...')).toBeVisible();
});
