import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

test('an automation project folder can be set and edited without losing its value', async ({ authenticatedPage: page }) => {
  let hook: Record<string, unknown> | undefined;
  await page.route('**/api/hooks', async route => {
    if (route.request().method() === 'POST') {
      hook = { ...route.request().postDataJSON(), id: 'project-hook', executionCount: 0 };
      return json(route, 200, hook);
    }
    return json(route, 200, { hooks: hook ? [hook] : [] });
  });
  await page.route('**/api/hooks/project-hook', async route => {
    hook = { ...hook, ...route.request().postDataJSON() };
    return json(route, 200, hook);
  });
  await page.goto('/hooks');
  await page.getByRole('button', { name: 'New Automation' }).click();
  await page.getByPlaceholder('e.g., GitHub PR Review').fill('Project review');
  await page.getByPlaceholder('Absolute folder on the selected machine').fill('/work/octipus');
  await page.getByRole('button', { name: 'Create Hook', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New Automation' })).not.toBeVisible();
  expect(hook?.actionConfig).toMatchObject({ projectPath: '/work/octipus' });
  await page.getByTitle('Edit', { exact: true }).first().click();
  await expect(page.getByPlaceholder('Absolute folder on the selected machine')).toHaveValue('/work/octipus');
  await page.getByPlaceholder('Absolute folder on the selected machine').fill('/work/another-project');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit Hook' })).not.toBeVisible();
  expect(hook?.actionConfig).toMatchObject({ projectPath: '/work/another-project' });
});
