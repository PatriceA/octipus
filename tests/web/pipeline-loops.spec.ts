import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

/** A plan-and-loop template: the plan loop and its settings must be visible without reading code. */
const template = {
  id: 'loop-1',
  userId: 'u1',
  name: 'feature-loop',
  description: 'Plan, then build each item',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  steps: [
    { name: 'Plan', topic: 'architecture', producesPlan: true },
    { name: 'Implement', topic: 'coding', loopOverPlan: true, requiresApproval: true, maxPlanItems: 5, skillIds: ['tdd'] },
    { name: 'QA', topic: 'qa', loopOverPlan: true, stageType: 'qa_validation', retryTargetStage: 1, maxRetries: 2, autoSkills: true },
    { name: 'Ship', topic: 'coding' },
  ],
};

test.describe('pipeline plan loops', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/pipelines/templates', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ templates: [template] }) }));
    await page.route('**/api/skills', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skills: [
        { id: 'tdd', name: 'Test-driven development', description: 'Write the failing test first' },
        { id: 'docs', name: 'Docs writer', description: 'Write user docs' },
      ] }) }));
  });

  test('the template card says which steps repeat, and for what', async ({ authenticatedPage: page }) => {
    await page.goto('/pipelines');
    await page.getByRole('button', { name: 'Expand feature-loop' }).click();
    await expect(page.getByText('Steps 2–3 repeat once for each item of the plan written by step 1 (Plan)')).toBeVisible();
    await expect(page.getByText('at most 5 items per run')).toBeVisible();
  });

  test('the editor exposes the loop and skill settings', async ({ authenticatedPage: page }) => {
    await page.goto('/pipelines');
    await page.getByRole('button', { name: 'Edit feature-loop' }).click();
    await page.getByText('Implement', { exact: true }).first().click();
    await expect(page.getByLabel('Repeat for each plan item')).toBeChecked();
    await expect(page.getByLabel('Max items per run')).toHaveValue('5');
    // The declared skill shows by name, not id.
    await expect(page.getByText('Test-driven development')).toBeVisible();
    await page.getByLabel('Search skills to add').fill('docs');
    await page.getByRole('button', { name: /Docs writer/ }).click();
    await expect(page.getByRole('button', { name: 'Remove skill Docs writer' })).toBeVisible();
    await page.getByRole('button', { name: 'How pipelines loop' }).click();
    await expect(page.getByText('QA retry', { exact: true })).toBeVisible();
    if (process.env.PIPELINE_LOOP_SCREENSHOT) await page.screenshot({ path: process.env.PIPELINE_LOOP_SCREENSHOT, fullPage: true });
  });
});
