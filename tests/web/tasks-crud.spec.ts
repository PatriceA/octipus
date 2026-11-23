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

test('deleting a todo archives it with undo, and done todos come a page at a time', async ({ authenticatedPage: page }) => {
  const task = (id: string, title: string, status: string) => ({ id, title, status, priority: 0, source: 'user', blockedBy: [], parentId: null, createdAt: '2026-11-01T00:00:00Z' });
  const open = [task('t-open', 'Water the plants', 'open')];
  const done = Array.from({ length: 70 }, (_, i) => task(`t-done-${i}`, `Finished chore ${i}`, 'done'));
  const archived = new Set<string>();
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const lists: string[] = [];
  let deletes = 0;
  await page.route('**/api/tasks**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'DELETE') { deletes++; return json(route, 200, { deleted: true }); }
    if (request.method() === 'PATCH') {
      const id = url.pathname.split('/').pop()!;
      const body = request.postDataJSON();
      patches.push({ id, body });
      if (body.status === 'archived') archived.add(id); else archived.delete(id);
      const t = open.find(x => x.id === id)!;
      t.status = body.status;
      return json(route, 200, t);
    }
    if (url.searchParams.get('view') === 'next') return json(route, 200, { tasks: open.filter(t => !archived.has(t.id)) });
    if (/\/api\/tasks\/?$/.test(url.pathname)) lists.push(url.search);
    // Mirrors GET /tasks without a status: every active task, then a page of done ones.
    const limit = Number(url.searchParams.get('doneLimit') ?? 50);
    const active = open.filter(t => !archived.has(t.id) && t.status === 'open');
    return json(route, 200, { tasks: [...active, ...done.slice(0, limit)], done: { total: done.length, offset: 0, limit, hasMore: limit < done.length } });
  });
  await page.goto('/tasks');
  await expect(page.getByText('Done (70)')).toBeVisible();
  await expect(page.getByText('Finished chore 49', { exact: true })).toBeVisible();
  await expect(page.getByText('Finished chore 50', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show more done (20 more)' }).click();
  await expect(page.getByText('Finished chore 69', { exact: true })).toBeVisible();
  expect(lists.at(-1)).toContain('doneLimit=100');
  await expect(page.getByRole('button', { name: /Show more done/ })).toHaveCount(0);

  // No confirm dialog: the todo is archived at once, and Undo puts it back.
  page.on('dialog', d => { throw new Error(`unexpected dialog: ${d.message()}`); });
  const row = page.getByText('Water the plants', { exact: true });
  await page.getByRole('button', { name: 'Delete task' }).first().click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('undo-toast')).toContainText('Deleted “Water the plants”');
  expect(patches).toEqual([{ id: 't-open', body: { status: 'archived' } }]);
  await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
  await expect(row).toBeVisible();
  expect(patches.at(-1)).toEqual({ id: 't-open', body: { status: 'open' } });
  expect(deletes).toBe(0);
});
