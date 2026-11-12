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

test('task editor keeps failed drafts, cancels without writes, and saves edited fields only', async ({ authenticatedPage: page }) => {
  let task = { id: 'edit-task', title: 'Run benchmark', notes: 'Keep evidence', priority: 2, dueAt: null as string | null, status: 'open', source: 'user', assigneeKind: 'user', assigneeRef: 'e2e-user-id', createdAt: '2026-11-01T00:00:00Z' };
  await page.route('**/api/roles', route => json(route, 200, { roles: [{ role: 'coding' }, { role: 'research' }] }));
  const patches: Record<string, unknown>[] = [];
  let fail = true;
  await page.route('**/api/tasks**', async route => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON();
      patches.push(patch);
      if (fail) return json(route, 500, { error: 'Storage unavailable' });
      task = { ...task, ...patch };
      return json(route, 200, task);
    }
    return json(route, 200, { tasks: [task] });
  });
  await page.goto('/tasks');
  await expect(page.getByTestId('task-assignee')).toHaveText('You');
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Edit task' });
  await editor.getByLabel('Title', { exact: true }).fill('Discard this');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(patches).toEqual([]);
  await expect(page.getByText('Run benchmark', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Edit task' });
  await editor.getByLabel('Title', { exact: true }).fill('Benchmark with evidence');
  await editor.getByLabel('Notes', { exact: true }).fill('Save measured results');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('alert')).toContainText('Storage unavailable');
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Benchmark with evidence');
  fail = false;
  // An unrelated field changes while the editor is open. It must survive Save.
  task = { ...task, priority: 3 };
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);
  expect(patches.at(-1)).toEqual({ title: 'Benchmark with evidence', notes: 'Save measured results' });
  expect(task.priority).toBe(3);
  await page.reload();
  await expect(page.getByText('Benchmark with evidence', { exact: true })).toBeVisible();
  await page.getByTestId('tasks-view-board').click();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Edit task' });
  await editor.getByLabel('Category', { exact: true }).fill('Research');
  await editor.getByLabel('Status', { exact: true }).selectOption('in_progress');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);
  expect(patches.at(-1)).toEqual({ status: 'in_progress', category: 'Research' });
  await expect(page.getByTestId('board-column-in_progress')).toContainText('Benchmark with evidence');
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await editor.getByLabel('Assignee kind').selectOption('role');
  await editor.getByLabel('Assignee role').selectOption('research');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);
  expect(patches.at(-1)).toEqual({ assigneeKind: 'role', assigneeRef: 'research' });
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await editor.getByLabel('Assignee role').selectOption('coding');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);
  expect(patches.at(-1)).toEqual({ assigneeKind: 'role', assigneeRef: 'coding' });
  // A UTC timestamp must display the owner's local due day. Untouched notes
  // retain whitespace and are not sent over a concurrent worker's update.
  task = { ...task, dueAt: '2026-11-11T04:59:59.999Z', notes: 'Original notes\n' };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await page.reload();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await expect(editor.getByLabel('Due date', { exact: true })).toHaveValue('2026-11-10');
  await editor.getByLabel('Title', { exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement === document.body || Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  task = { ...task, notes: 'Fresh worker notes' };
  await editor.getByLabel('Priority', { exact: true }).selectOption('1');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);
  expect(patches.at(-1)).toEqual({ priority: 1 });
  expect(task.notes).toBe('Fresh worker notes');
});
