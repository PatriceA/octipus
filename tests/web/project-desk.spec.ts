import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';
import { stubGateway } from './fixtures/gateway';
import type { WorkspaceDesk, DeskSession } from '../../src/shared/workspace-desk';
const at = '2026-11-09T14:32:00Z';
const row = (id: string, title: string, state: DeskSession['state']): DeskSession => ({ id, title, state, activity: state === 'working' ? 'Running release checks' : 'A request needs your answer', outcome: 'Recorded in plan: Run tests', next: 'Check the connected phone', updatedAt: at, pipelineId: null,
  events: [{ at, text: 'Review finished' }], plan: { title: 'Release plan', revision: 3, updatedAt: at, changes: [{ at, summary: 'Phone acceptance added after review' }] } });
const snapshot: WorkspaceDesk = { observedAt: new Date().toISOString(), total: 3, warnings: [], sessions: [row('sess-1', 'Life2', 'working'), row('sess-2', 'Solar Map', 'needs_you'), row('old', 'Earlier work', 'paused')] };
test.beforeEach(async ({ authenticatedPage: page }) => {
  await page.route('**/api/sessions/desk', route => json(route, 200, snapshot));
  await page.route('**/api/companion/settings', route => json(route, 200, { enabled: true, supervisorSessionId: 'companion-saved', modelName: 'configured' }));
});
test('desk shows state, evidence and plan changes without percentages; drafts survive selection/filtering', async ({ authenticatedPage: page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Selected session' }).getByText('Phone acceptance added after review')).toBeVisible();
  await page.screenshot({ path: '/tmp/octipus-project-desk-desktop.png', fullPage: true });
  await page.getByLabel('Message Companion', { exact: true }).fill('Keep this thought');
  await page.getByRole('button', { name: 'Inspect Solar Map' }).click();
  await expect(page.getByRole('complementary', { name: 'Selected session' }).getByRole('heading', { name: 'Solar Map', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Needs you/ }).click();
  await expect(page.getByRole('button', { name: 'Inspect Life2' })).toHaveCount(0);
  await expect(page.getByLabel('Message Companion', { exact: true })).toHaveValue('Keep this thought');
  await expect(page.getByRole('button', { name: /^Needs you/ })).toBeFocused();
});
test('Companion message uses its saved session and shared gateway', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.goto('/');
  await page.getByLabel('Message Companion', { exact: true }).fill('What needs me?');
  await expect(page.getByRole('button', { name: 'Send to Companion', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send to Companion', exact: true }).click();
  await expect.poll(() => gateway.sent.find(message => message.type === 'chat.send')).toMatchObject({ sessionId: 'companion-saved', content: 'What needs me?' });
  await expect(page).toHaveURL(/session=companion-saved/);
});
test('idea save failure preserves draft and reports the error', async ({ authenticatedPage: page }) => {
  await page.route('**/api/tasks', route => route.request().method() === 'POST' ? json(route, 500, { error: 'Could not save idea' }) : json(route, 200, { tasks: [] }));
  await page.goto('/');
  await page.getByLabel('Message Companion', { exact: true }).fill('Remember this');
  await page.getByRole('button', { name: 'Save idea', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save idea');
  await expect(page.getByLabel('Message Companion', { exact: true })).toHaveValue('Remember this');
});
test('mobile session inspector traps focus and closes back to the selected session', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Inspect Life2' }).click();
  const dialog = page.getByRole('dialog', { name: 'Life2 details' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Phone acceptance added after review')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Inspect Life2' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/octipus-project-desk-mobile.png', fullPage: true });
});
test('settings search finds the canonical CLI destination and back navigation restores overview', async ({ authenticatedPage: page }) => {
  await page.goto('/settings');
  await page.getByRole('searchbox', { name: 'Find a setting' }).fill('gh');
  await page.getByRole('button', { name: 'Environments & Access', exact: true }).click();
  await expect(page).toHaveURL(/tab=environments/);
  await page.goBack();
  await expect(page.getByRole('searchbox', { name: 'Find a setting' })).toBeVisible();
});
test('navigation groups and width stay as the user set them across page changes and reload', async ({ authenticatedPage: page }) => {
  await page.goto('/');
  const library = page.locator('aside summary').filter({ hasText: /^Library$/ });
  await library.click();
  await page.getByRole('link', { name: 'documents', exact: true }).click();
  await expect(library.locator('..')).toHaveAttribute('open', '');
  await page.getByRole('link', { name: 'Workspace', exact: true }).click();
  await expect(library.locator('..')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
});
test('slow idea saving protects the submitted draft from edits', async ({ authenticatedPage: page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/tasks', async route => { if (route.request().method() === 'POST') { await gate; return json(route, 200, { id: 'idea' }); } return json(route, 200, { tasks: [] }); });
  await page.goto('/');
  const input = page.getByLabel('Message Companion', { exact: true });
  await input.fill('Keep my idea');
  await page.getByRole('button', { name: 'Save idea', exact: true }).click();
  await expect(input).toBeDisabled();
  release();
  await expect(page).toHaveURL(/\/tasks$/);
});
test('mobile Settings selection closes the menu overlay', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('aside.app-sidebar')).not.toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Find a setting' })).toBeVisible();
});
test('new work opens the session setup rather than continuing the last conversation', async ({ authenticatedPage: page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'New session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Session', exact: true })).toBeVisible();
});
