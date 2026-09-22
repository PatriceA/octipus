import { expect, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

test('personal todo can be created, completed, reopened and survives reload', async ({ authenticatedPage: page }) => {
  let tasks: any[] = [];
  await page.route('**/api/tasks**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const input = request.postDataJSON();
      const task = { ...input, id: 'crud-task', status: 'open', source: 'user', blockedBy: [], parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      tasks.push(task);
      return json(route, 200, task);
    }
    if (request.method() === 'PATCH') {
      tasks[0] = { ...tasks[0], ...request.postDataJSON() };
      return json(route, 200, tasks[0]);
    }
    return json(route, 200, { tasks });
  });
  await page.goto('/tasks');
  await page.getByPlaceholder('Add a task…').fill('Verify mobile synchronization');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Verify mobile synchronization', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect.poll(() => tasks[0].status).toBe('done');
  await page.getByRole('button', { name: 'Mark open', exact: true }).click();
  await expect.poll(() => tasks[0].status).toBe('open');
  await page.reload();
  await expect(page.getByText('Verify mobile synchronization', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Verify mobile synchronization', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
