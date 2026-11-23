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
  await page.goto('/tasks?list=all');
  const capture = page.getByRole('textbox', { name: 'Add a to-do' });
  await capture.fill('Verify mobile synchronization');
  await capture.press('Enter');
  await expect(page.getByTestId('task-row').filter({ hasText: 'Verify mobile synchronization' })).toBeVisible();
  // Enter adds and the line stays ready for the next one.
  await expect(capture).toHaveValue('');
  await expect(capture).toBeFocused();
  await page.getByRole('checkbox', { name: 'Mark done', exact: true }).click();
  await expect.poll(() => tasks[0].status).toBe('done');
  // Completed to-dos sit in a collapsed section.
  await page.getByTestId('todo-completed-toggle').click();
  await page.getByRole('checkbox', { name: 'Mark open', exact: true }).click();
  await expect.poll(() => tasks[0].status).toBe('open');
  await page.reload();
  await expect(page.getByText('Verify mobile synchronization', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Verify mobile synchronization', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the detail panel saves each field as it changes, keeps a failed draft, and opens from the board', async ({ authenticatedPage: page }) => {
  let task = { id: 'edit-task', title: 'Run benchmark', notes: 'Keep evidence', priority: 2, dueAt: null as string | null, status: 'open', source: 'user', category: null as string | null, assigneeKind: 'user', assigneeRef: 'e2e-user-id', createdAt: '2026-11-01T00:00:00Z' };
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
    if (new URL(route.request().url()).pathname.endsWith('/comments')) return json(route, 200, { comments: [], truncated: false });
    return json(route, 200, { tasks: [task] });
  });
  await page.goto('/tasks?list=all');
  await page.getByTestId('task-row').filter({ hasText: 'Run benchmark' }).click();
  await expect(page).toHaveURL(/task=edit-task/);
  const detail = page.getByTestId('todo-detail');
  // Opening and closing sends nothing.
  await detail.getByRole('button', { name: 'Close details' }).click();
  await expect(detail).toHaveCount(0);
  expect(patches).toEqual([]);

  await page.getByTestId('task-row').click();
  const title = detail.getByLabel('Title');
  await title.fill('Benchmark with evidence');
  await title.press('Enter');
  await expect(detail.getByRole('alert')).toContainText('Title not saved');
  await expect(title).toHaveValue('Benchmark with evidence');
  expect(patches).toEqual([{ title: 'Benchmark with evidence' }]);
  fail = false;
  // An unrelated field changes meanwhile: the retry sends the title only.
  task = { ...task, priority: 3 };
  await title.focus();
  await detail.getByLabel('Notes').focus();
  await expect.poll(() => patches.at(-1)).toEqual({ title: 'Benchmark with evidence' });
  await expect(detail.getByRole('alert')).toHaveCount(0);
  expect(task.priority).toBe(3);
  // Notes save themselves a moment after typing stops.
  await detail.getByLabel('Notes').fill('Save measured results');
  await expect.poll(() => patches.at(-1)).toEqual({ notes: 'Save measured results' });
  await page.reload();
  await expect(page.getByTestId('todo-detail').getByLabel('Title')).toHaveValue('Benchmark with evidence');

  // The board's cards open the same panel; status and assignee live there.
  await page.getByTestId('tasks-view-board').click();
  await page.getByTestId('board-card').getByRole('button', { name: 'Open details' }).click();
  await detail.getByRole('button', { name: /Board & agents/ }).click();
  await detail.getByLabel('Status', { exact: true }).selectOption('in_progress');
  await expect.poll(() => patches.at(-1)).toEqual({ status: 'in_progress' });
  await expect(page.getByTestId('board-column-in_progress')).toContainText('Benchmark with evidence');
  await detail.getByLabel('Assignee kind').selectOption('role');
  await expect.poll(() => patches.at(-1)).toEqual({ assigneeKind: 'role', assigneeRef: 'coding' });
  await detail.getByLabel('Assignee role').selectOption('research');
  await expect.poll(() => patches.at(-1)).toEqual({ assigneeKind: 'role', assigneeRef: 'research' });
  await detail.getByRole('button', { name: 'High' }).click();
  await expect.poll(() => patches.at(-1)).toEqual({ priority: 3 });

  // A UTC timestamp shows the owner's local due day.
  task = { ...task, dueAt: '2026-11-11T04:59:59.999Z' };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await page.goto('/tasks?list=all&task=edit-task');
  await page.getByTestId('todo-due').getByRole('button').first().click();
  await expect(page.getByLabel('Due date', { exact: true })).toHaveValue('2026-11-10');
  await expect(page.getByLabel('Due time', { exact: true })).toHaveValue('');
});

test('deleting a todo sends nothing until its undo closes, and done todos page past the server cap', async ({ authenticatedPage: page }) => {
  const task = (id: string, title: string, status: string) => ({ id, title, status, priority: 0, source: 'user', blockedBy: [], parentId: null, createdAt: '2026-11-01T00:00:00Z', completedAt: status === 'done' ? `2026-11-0${1 + (Number(id.split('-').pop()) % 9)}T00:00:00Z` : null });
  const open = [task('t-open', 'Water the plants', 'open'), task('t-other', 'Call the plumber', 'open')];
  const DONE = 560;
  const done = Array.from({ length: DONE }, (_, i) => ({ ...task(`t-done-${i}`, `Finished chore ${i}`, 'done'), completedAt: new Date(Date.UTC(2026, 9, 1) + (DONE - i) * 60_000).toISOString() }));
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
      const t = open.find(x => x.id === id)!;
      t.status = body.status;
      return json(route, 200, t);
    }
    const active = open.filter(t => t.status === 'open');
    if (/\/api\/tasks\/?$/.test(url.pathname)) lists.push(url.search);
    // Mirrors GET /tasks without a status: every active task, then a page of
    // done ones, the page capped at 500 as the server does.
    const limit = Math.min(500, Number(url.searchParams.get('doneLimit') ?? 50));
    const offset = Number(url.searchParams.get('doneOffset') ?? 0);
    return json(route, 200, { tasks: [...active, ...done.slice(offset, offset + limit)], done: { total: DONE, offset, limit, hasMore: offset + limit < DONE } });
  });
  await page.goto('/tasks?list=completed');
  await expect(page.getByTestId('todo-list-completed')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Finished chore 49', { exact: true })).toBeVisible();
  await expect(page.getByText('Finished chore 50', { exact: true })).toHaveCount(0);
  const more = page.getByRole('button', { name: /Show more done/ });
  for (let shown = 50; shown < DONE; shown += 50) await more.click();
  await expect(page.getByText(`Finished chore ${DONE - 1}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Finished chore 500', { exact: true })).toBeVisible();
  expect(lists).toContain('?doneLimit=500');
  expect(lists).toContain('?doneLimit=100&doneOffset=500');
  await expect(more).toHaveCount(0);
  // The full list says how many are done in all.
  await page.getByTestId('todo-list-all').click();
  await expect(page.getByTestId('todo-completed-toggle')).toContainText(`Completed ${DONE}`);

  // No confirm dialog, and no request yet: the todo is only hidden.
  page.on('dialog', d => { throw new Error(`unexpected dialog: ${d.message()}`); });
  const row = page.getByTestId('task-row').filter({ hasText: 'Water the plants' });
  await row.click();
  await page.getByTestId('todo-detail').getByRole('button', { name: 'Delete task' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('undo-toast')).toContainText('Deleted “Water the plants”');
  // Undo: back, and nothing was ever sent for it.
  await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
  await expect(row).toBeVisible();
  expect(patches).toEqual([]);

  // The keyboard deletes too (Delete on a focused row); another write re-reads the list and the hidden todo stays hidden.
  await row.focus();
  await page.keyboard.press('Delete');
  await expect(row).toHaveCount(0);
  await page.getByTestId('task-row').filter({ hasText: 'Call the plumber' }).getByRole('checkbox', { name: 'Mark done' }).click();
  await expect.poll(() => patches.some((p) => p.id === 't-other')).toBe(true);
  await expect(row).toHaveCount(0);
  // The completion's own offer replaced the deletion's, which was made then: archived, once.
  await expect.poll(() => patches.length).toBe(2);
  expect([...patches].sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: 't-open', body: { status: 'archived' } }, { id: 't-other', body: { status: 'done' } }]);
  expect(deletes).toBe(0);
});

test('a deletion still on offer is made when the page is left', async ({ authenticatedPage: page }) => {
  const t = { id: 't-1', title: 'Renew the parking permit', status: 'open', priority: 0, source: 'user', blockedBy: [], parentId: null, createdAt: '2026-11-01T00:00:00Z' };
  const patches: Record<string, unknown>[] = [];
  await page.route('**/api/tasks**', async route => {
    if (route.request().method() === 'PATCH') { patches.push(route.request().postDataJSON()); return json(route, 200, t); }
    return json(route, 200, { tasks: [t] });
  });
  await page.goto('/tasks?list=all');
  await page.getByTestId('task-row').focus();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('undo-toast')).toBeVisible();
  expect(patches).toEqual([]);
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect.poll(() => patches).toEqual([{ status: 'archived' }]);
});
