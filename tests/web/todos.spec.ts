import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';
import { stubGateway } from './fixtures/gateway';

/**
 * The to-do redesign (after Microsoft To Do): capture with parsed chips, the
 * lists rail, My Day, the detail panel's fields, keyboard, drag, search,
 * undo, live updates, the global quick-add and the calendar. One stateful
 * stub answers /api/tasks the way src/api/routes/tasks.ts does.
 */
const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayFromToday = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };
const endOfDay = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(23, 59, 59, 999); return d.toISOString(); };
const TODAY = localDay(new Date());

type Row = Record<string, any>;
let seq = 0;
const T = (id: string, title: string, o: Row = {}): Row => ({
  id, title, status: 'open', priority: 0, source: 'user', blockedBy: [], parentId: null, category: null, notes: null, dueAt: null, remindAt: null,
  important: false, myDayOn: null, repeat: null, repeatNextId: null, sortOrder: (seq += 10), createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...o,
});

interface Server { rows: Row[]; calls: { method: string; path: string; body: any }[]; patches(): { id: string; body: any }[] }

async function serve(page: Page, rows: Row[]): Promise<Server> {
  const calls: Server['calls'] = [];
  let lists: string[] = [];
  await page.route('**/api/roles', (route) => json(route, 200, { roles: [] }));
  await page.route(/\/api\/tasks(\/|\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/tasks/, '') || '/';
    const body = req.postData() ? req.postDataJSON() : undefined;
    calls.push({ method: req.method(), path, body });
    if (path === '/my-day') {
      return json(route, 200, {
        date: TODAY, timezone: 'UTC', tasks: rows.filter((t) => t.myDayOn === TODAY),
        suggestions: rows.filter((t) => t.status === 'open' && t.myDayOn !== TODAY && t.dueAt).map((t) => ({ ...t, bucket: 'overdue', reason: 'was due yesterday' })),
      });
    }
    if (path.endsWith('/comments')) return json(route, 200, { comments: [], truncated: false });
    if (path === '/lists') {
      const names = () => [...new Set([...lists, ...rows.filter((t) => t.category && t.status !== 'archived').map((t) => t.category)])].sort();
      if (req.method() === 'POST') { lists.push(body.name); return json(route, 200, { name: body.name }); }
      if (req.method() === 'PATCH') {
        const moved = rows.filter((t) => t.category === body.name);
        for (const t of moved) t.category = body.newName;
        lists = lists.map((l) => (l === body.name ? body.newName : l));
        return json(route, 200, { name: body.newName, taskIds: moved.map((t) => t.id) });
      }
      if (req.method() === 'DELETE') {
        const name = url.searchParams.get('name');
        const moved = rows.filter((t) => t.category === name);
        for (const t of moved) t.category = null;
        lists = lists.filter((l) => l !== name);
        return json(route, 200, { taskIds: moved.map((t) => t.id) });
      }
      return json(route, 200, { lists: names().map((name) => ({ name, open: rows.filter((t) => t.category === name && t.status === 'open').length })) });
    }
    if (path === '/lists/move') {
      for (const t of rows) if (body.taskIds.includes(t.id)) t.category = body.name;
      return json(route, 200, { taskIds: body.taskIds });
    }
    if (req.method() === 'POST' && path === '/') {
      const { myDay, tz, ...rest } = body;
      const row = T(`new-${rows.length}`, rest.title, { ...rest, myDayOn: myDay ? TODAY : null });
      rows.push(row);
      return json(route, 200, row);
    }
    if (req.method() === 'PATCH') {
      const row = rows.find((t) => t.id === path.slice(1));
      if (!row) return json(route, 404, { error: 'Task not found' });
      const { myDay, tz, ...rest } = body;
      Object.assign(row, rest);
      if (myDay !== undefined) row.myDayOn = myDay ? TODAY : null;
      if (rest.status === 'done') row.completedAt = new Date().toISOString();
      return json(route, 200, row);
    }
    if (url.searchParams.get('status') === 'archived') return json(route, 200, { tasks: rows.filter((t) => t.status === 'archived'), page: { total: 0 } });
    return json(route, 200, { tasks: rows.filter((t) => t.status !== 'archived'), serverNow: new Date().toISOString() });
  });
  return { rows, calls, patches: () => calls.filter((c) => c.method === 'PATCH').map((c) => ({ id: c.path.slice(1), body: c.body })) };
}

const row = (page: Page, title: string) => page.getByRole('listitem', { name: title, exact: true });

test.describe('to-dos', () => {
  test.beforeEach(() => { seq = 0; });

  test('capture shows what it understood and adds it to the list it was typed in', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('s', 'Seed', { category: 'Personal' })]);
    await page.goto('/tasks?list=my-day');
    const capture = page.getByRole('textbox', { name: 'Add a to-do' });
    await capture.fill('call dentist tomorrow 3pm !high #personal');
    const chips = page.getByTestId('capture-chips').getByRole('listitem');
    await expect(chips).toHaveText(['Tomorrow', '15:00', 'High', 'Personal']);
    await capture.press('Enter');
    await expect.poll(() => server.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      title: 'call dentist', category: 'Personal', priority: 3, myDay: true, tz: expect.any(String),
      dueAt: new Date(`${dayFromToday(1)}T15:00:00`).toISOString(),
    });
    await expect(row(page, 'call dentist')).toBeVisible();
    await expect(capture).toBeFocused();

    // Taking a chip back keeps its words in the title (they are quoted, so read literally).
    await capture.fill('Watch the film tomorrow !high');
    await page.getByRole('button', { name: 'Remove Tomorrow' }).click();
    await expect(capture).toHaveValue('Watch the film "tomorrow" !high');
    await expect(chips).toHaveText(['High']);
    await capture.press('Enter');
    await expect.poll(() => server.calls.filter((c) => c.method === 'POST').at(-1)?.body).toMatchObject({ title: 'Watch the film tomorrow', priority: 3, dueAt: null });

    // In a list, a to-do lands in that list; a bare day is sent as a day.
    await page.getByTestId('todo-list-list:Personal').click();
    await capture.fill('Renew passport friday');
    await capture.press('Enter');
    await expect.poll(() => server.calls.filter((c) => c.method === 'POST').at(-1)?.body).toMatchObject({ title: 'Renew passport', category: 'Personal' });
    expect(server.calls.filter((c) => c.method === 'POST').at(-1)?.body.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(server.calls.filter((c) => c.method === 'POST').at(-1)?.body.myDay).toBeUndefined();
  });

  test('the rail counts open to-dos per list, and its views hold what they say', async ({ authenticatedPage: page }) => {
    await serve(page, [
      T('a', 'Picked today', { myDayOn: TODAY }),
      T('b', 'Picked yesterday', { myDayOn: dayFromToday(-1) }),
      T('c', 'Starred', { important: true, category: 'Work' }),
      T('d', 'Due later', { dueAt: endOfDay(10), category: 'Work' }),
      T('e', 'Overdue', { dueAt: endOfDay(-3) }),
      T('f', 'Done today', { status: 'done', myDayOn: TODAY, completedAt: new Date().toISOString() }),
    ]);
    await page.goto('/tasks?list=my-day');
    await expect(page.getByTestId('todo-list-my-day')).toContainText('1');
    await expect(page.getByTestId('todo-list-important')).toContainText('1');
    await expect(page.getByTestId('todo-list-planned')).toContainText('2');
    await expect(page.getByTestId('todo-list-all')).toContainText('5');
    await expect(page.getByTestId('todo-list-list:Work')).toContainText('2');
    // My Day is today's picks; yesterday's is not in it.
    const list = page.getByTestId('todo-list').getByTestId('task-row');
    await expect(list).toHaveText([/Picked today/]);
    await expect(page.getByTestId('todo-completed-toggle')).toContainText('Completed 1');
    await page.getByTestId('todo-list-important').click();
    await expect(list).toHaveText([/Starred/]);
    // Planned is grouped by day.
    await page.getByTestId('todo-list-planned').click();
    await expect(page.locator('.todo-group-title')).toHaveText(['Earlier', 'Later']);
    await expect(list).toHaveText([/Overdue/, /Due later/]);
    // The list is remembered for the next visit.
    await page.goto('/tasks');
    await expect(page.getByTestId('todo-list-planned')).toHaveAttribute('aria-current', 'page');
  });

  test('My Day suggests to-dos and adds one with +', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'Pay the invoice', { dueAt: endOfDay(-1) })]);
    await page.goto('/tasks?list=my-day');
    await expect(page.getByTestId('todo-empty')).toContainText('Focus on your day');
    const suggestion = page.getByTestId('my-day-suggestion');
    await expect(suggestion).toContainText('Pay the invoice');
    await expect(suggestion).toContainText('was due yesterday');
    await page.getByRole('button', { name: 'Add “Pay the invoice” to My Day' }).click();
    await expect.poll(() => server.patches()).toEqual([{ id: 'a', body: { myDay: true, tz: expect.any(String) } }]);
    await expect(row(page, 'Pay the invoice')).toBeVisible();
  });

  test('the detail panel sets My Day, due date and time, reminder, repeat, steps and priority', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'Water the plants')]);
    await page.goto('/tasks?list=all&task=a');
    const detail = page.getByTestId('todo-detail');
    await detail.getByRole('button', { name: 'Add to My Day' }).click();
    await expect.poll(() => server.patches().at(-1)?.body).toMatchObject({ myDay: true });
    await expect(detail.getByRole('button', { name: 'Added to My Day' })).toBeVisible();

    await detail.getByTestId('todo-due').getByRole('button').first().click();
    await detail.getByRole('button', { name: 'Tomorrow', exact: true }).click();
    await expect.poll(() => server.patches().at(-1)?.body).toEqual({ dueAt: dayFromToday(1), tz: expect.any(String) });
    // The server ends a bare day at 23:59:59.999 local; the panel then reads it as a day without a time.
    server.rows[0].dueAt = endOfDay(1);
    await page.reload();
    await expect(detail.getByTestId('todo-due')).toContainText('Due Tomorrow');
    await detail.getByTestId('todo-due').getByRole('button').first().click();
    await detail.getByLabel('Due time').fill('09:30');
    await expect.poll(() => server.patches().at(-1)?.body.dueAt).toBe(new Date(`${dayFromToday(1)}T09:30:00`).toISOString());

    await detail.getByTestId('todo-remind').getByRole('button').first().click();
    await detail.getByRole('button', { name: 'Tomorrow 9:00' }).click();
    await expect.poll(() => server.patches().at(-1)?.body.remindAt).toBe(new Date(`${dayFromToday(1)}T09:00:00`).toISOString());

    await detail.getByTestId('todo-repeat').getByRole('button').first().click();
    await detail.getByRole('button', { name: 'Weekdays' }).click();
    await expect.poll(() => server.patches().at(-1)?.body).toEqual({ repeat: { unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] } });
    await expect(detail.getByTestId('todo-repeat')).toContainText('Weekdays');
    await detail.getByTestId('todo-repeat').getByRole('button').first().click();
    await detail.getByRole('button', { name: 'Custom' }).click();
    await detail.getByLabel('Repeat every').fill('2');
    await detail.getByLabel('Repeat unit').selectOption('week');
    // Custom starts from the rule in place (weekdays): Tuesday off leaves Mon, Wed, Thu, Fri.
    await detail.getByRole('button', { name: 'Tuesday' }).click();
    await expect.poll(() => server.patches().at(-1)?.body).toEqual({ repeat: { unit: 'week', interval: 2, weekdays: [1, 3, 4, 5] } });
    await expect(detail.getByTestId('todo-repeat')).toContainText('Every 2 weeks on Mon, Wed, Thu, Fri');
    await expect(row(page, 'Water the plants').getByLabel('Repeats')).toBeVisible();

    await detail.getByRole('textbox', { name: 'Add step' }).fill('Fill the can');
    await detail.getByRole('textbox', { name: 'Add step' }).press('Enter');
    await expect.poll(() => server.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ title: 'Fill the can', parentId: 'a' });
    await expect(detail.getByTestId('todo-step')).toHaveCount(1);
    await expect(row(page, 'Water the plants')).toContainText('0 of 1');

    await detail.getByRole('button', { name: 'Medium' }).click();
    await expect.poll(() => server.patches().at(-1)?.body).toEqual({ priority: 2 });
    // A title cannot be emptied: clicking away puts the saved one back, and nothing is sent.
    await detail.getByLabel('Title').fill('');
    await detail.getByRole('textbox', { name: 'Notes' }).focus();
    await expect(detail.getByLabel('Title')).toHaveValue('Water the plants');
    expect(server.patches().some((p) => 'title' in p.body)).toBe(false);
    await page.getByRole('button', { name: 'Mark as important' }).first().click();
    await expect.poll(() => server.patches().at(-1)?.body).toEqual({ important: true });
  });

  test('keyboard: arrows move, Space completes with an undo, Enter opens, Escape closes, N captures', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'First'), T('b', 'Second'), T('c', 'Third')]);
    await page.goto('/tasks?list=all');
    await row(page, 'First').focus();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Second')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('todo-detail').getByLabel('Title')).toHaveValue('Second');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('todo-detail')).toHaveCount(0);
    await expect(row(page, 'Second')).toBeFocused();
    await page.keyboard.press(' ');
    // A beat of the ticked box, then it is done and moves to Completed.
    await expect(row(page, 'Second')).toHaveClass(/is-completing/);
    await expect.poll(() => server.patches()).toEqual([{ id: 'b', body: { status: 'done' } }]);
    await expect(page.getByTestId('todo-list').getByTestId('task-row')).toHaveText([/First/, /Third/]);
    await expect(page.getByTestId('undo-toast')).toContainText('Completed “Second”');
    await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.patches().at(-1)).toEqual({ id: 'b', body: { status: 'open' } });
    await expect(page.getByTestId('todo-list').getByTestId('task-row')).toHaveText([/First/, /Second/, /Third/]);
    await page.locator('body').click();
    await page.keyboard.press('n');
    await expect(page.getByRole('textbox', { name: 'Add a to-do' })).toBeFocused();
  });

  test('drag reorders within a list and moves onto a list in the rail', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'Alpha', { sortOrder: 10, category: 'Home' }), T('b', 'Bravo', { sortOrder: 20 }), T('c', 'Charlie', { sortOrder: 30 })]);
    await page.goto('/tasks?list=all');
    await row(page, 'Charlie').dragTo(row(page, 'Alpha'), { targetPosition: { x: 200, y: 4 } });
    await expect.poll(() => server.patches()).toEqual([{ id: 'c', body: { sortOrder: 9 } }]);
    await expect(page.getByTestId('todo-list').getByTestId('task-row')).toHaveText([/Charlie/, /Alpha/, /Bravo/]);
    await row(page, 'Bravo').dragTo(row(page, 'Alpha'), { targetPosition: { x: 200, y: 4 } });
    await expect.poll(() => server.patches().at(-1)).toEqual({ id: 'b', body: { sortOrder: 9.5 } });

    await row(page, 'Bravo').dragTo(page.getByTestId('todo-list-list:Home'));
    await expect.poll(() => server.patches().at(-1)).toEqual({ id: 'b', body: { category: 'Home' } });
    await expect(page.getByTestId('undo-toast')).toContainText('Moved “Bravo” to Home');
    await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.patches().at(-1)).toEqual({ id: 'b', body: { category: null } });
  });

  test('search finds to-dos across lists by title and notes', async ({ authenticatedPage: page }) => {
    await serve(page, [T('a', 'Book flights', { category: 'Travel' }), T('b', 'Call mum', { notes: 'about the flights refund' }), T('c', 'Buy bread')]);
    await page.goto('/tasks?list=list:Travel');
    await page.getByRole('searchbox', { name: 'Search to-dos' }).fill('flights');
    await expect(page.getByTestId('todo-list').getByTestId('task-row')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search to-dos' }).fill('nothing like it');
    await expect(page.getByTestId('todo-empty')).toContainText('No matches');
  });

  test('deleted to-dos are in Archived and can be restored', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'Old idea', { status: 'archived' })]);
    await page.goto('/tasks?list=archived');
    await row(page, 'Old idea').click();
    await page.getByTestId('todo-detail').getByRole('button', { name: 'Restore' }).click();
    await expect.poll(() => server.patches()).toEqual([{ id: 'a', body: { status: 'open' } }]);
    await expect(row(page, 'Old idea')).toHaveCount(0);
  });

  test('the list refetches when the gateway says a to-do changed', async ({ authenticatedPage: page }) => {
    const gateway = await stubGateway(page);
    const server = await serve(page, [T('a', 'Existing')]);
    await page.goto('/tasks?list=all');
    await expect(row(page, 'Existing')).toBeVisible();
    await expect.poll(() => gateway.sockets.length).toBeGreaterThan(0);
    // An agent adds one; the server tells the owner's connections.
    server.rows.push(T('b', 'Added by an agent'));
    gateway.event('tasks.changed', { taskId: 'b' });
    await expect(row(page, 'Added by an agent')).toBeVisible();
  });

  test('Q adds a to-do from any page, and so does the Ctrl+K menu', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('s', 'Seed', { category: 'Admin' })]);
    await page.goto('/notifications');
    await page.locator('body').click();
    await page.keyboard.press('q');
    const dialog = page.getByTestId('quick-add-todo');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'New to-do' }).fill('renew passport next week !! #admin');
    await expect(dialog.getByTestId('capture-chips').getByRole('listitem')).toHaveText([/./, 'Medium', 'Admin']);
    await dialog.getByLabel('Add to My Day').check();
    await dialog.getByRole('textbox', { name: 'New to-do' }).press('Enter');
    await expect.poll(() => server.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ title: 'renew passport', priority: 2, category: 'Admin', myDay: true });
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('undo-toast')).toContainText('Added “renew passport” to your to-dos');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('buy stamps');
    await page.getByTestId('search-add-todo').click();
    await expect(dialog.getByRole('textbox', { name: 'New to-do' })).toHaveValue('buy stamps');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => server.calls.filter((c) => c.method === 'POST').at(-1)?.body).toMatchObject({ title: 'buy stamps' });
  });

  test('due to-dos show on the calendar and can be ticked off there', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'File the tax return', { dueAt: endOfDay(0) }), T('b', 'Someday', {})]);
    await page.route('**/api/calendar/calendars', (route) => json(route, 200, { calendars: [], providers: [], partial: false, preferences: {} }));
    await page.route('**/api/calendar/events**', (route) => json(route, 200, { events: [], providers: [], partial: false }));
    await page.goto('/calendar');
    const due = page.getByTestId('calendar-due-todos');
    await expect(due.getByTestId('calendar-due-todo')).toHaveCount(1);
    await expect(due).toContainText('File the tax return');
    await expect(due.getByRole('link', { name: 'File the tax return' })).toHaveAttribute('href', '/tasks?list=planned&task=a');
    await due.getByRole('checkbox', { name: 'Mark done' }).click();
    await expect.poll(() => server.patches()).toEqual([{ id: 'a', body: { status: 'done' } }]);
  });

  test('at phone width the lists are a drawer and the detail panel is the whole screen', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serve(page, [T('a', 'Pack the bags', { category: 'Trip' })]);
    await page.goto('/tasks?list=all');
    await expect(page.getByRole('navigation', { name: 'Lists' })).toBeHidden();
    await page.getByRole('button', { name: 'Show lists' }).click();
    await page.getByTestId('todo-list-list:Trip').click();
    await expect(page.getByRole('navigation', { name: 'Lists' })).toBeHidden();
    await row(page, 'Pack the bags').click();
    const detail = page.getByTestId('todo-detail');
    const box = await detail.boundingBox();
    expect(box?.width).toBeCloseTo(390, 0);
    await detail.getByRole('button', { name: 'Back to list' }).click();
    await expect(detail).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('Alt+Up and Alt+Down move a to-do from the keyboard; its row reads its due date and state', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'Alpha', { sortOrder: 10, dueAt: endOfDay(-1) }), T('b', 'Bravo', { sortOrder: 20 }), T('c', 'Charlie', { sortOrder: 30 })]);
    await page.goto('/tasks?list=all');
    // The row is named by its title and described by its metadata.
    const alpha = page.getByRole('listitem', { name: 'Alpha', exact: true });
    await expect(alpha).toHaveAccessibleDescription(/Yesterday.*overdue/);
    await page.getByRole('listitem', { name: 'Charlie', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => server.patches()).toEqual([{ id: 'c', body: { sortOrder: 15 } }]);
    await expect(page.getByTestId('todo-list').getByTestId('task-row')).toHaveText([/Alpha/, /Charlie/, /Bravo/]);
    await expect(page.getByRole('listitem', { name: 'Charlie', exact: true })).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => server.patches().at(-1)).toEqual({ id: 'c', body: { sortOrder: 21 } });
  });

  test('Escape while typing does not close the detail panel; the next Escape does', async ({ authenticatedPage: page }) => {
    await serve(page, [T('a', 'Alpha')]);
    await page.goto('/tasks?list=all&task=a');
    const detail = page.getByTestId('todo-detail');
    await page.getByRole('textbox', { name: 'Add a to-do' }).fill('half typed');
    await page.keyboard.press('Escape');
    await expect(detail).toBeVisible();
    await detail.getByRole('textbox', { name: 'Notes' }).fill('a note');
    await page.keyboard.press('Escape');
    await expect(detail).toBeVisible();
    // The field let go of the focus (and shows its text rendered).
    await expect(detail.getByTestId('todo-notes-rendered')).toHaveText('a note');
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
  });

  test('Q does not open the quick-add over an open dialog or while an editor has focus', async ({ authenticatedPage: page }) => {
    await serve(page, []);
    await page.goto('/notifications');
    await page.evaluate(() => {
      const modal = document.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.id = 'stub-modal';
      document.body.appendChild(modal);
      const editor = document.createElement('div');
      editor.className = 'cm-editor';
      editor.innerHTML = '<div class="cm-content" contenteditable="true" tabindex="0">x</div>';
      document.body.appendChild(editor);
    });
    await page.locator('body').click();
    await page.keyboard.press('q');
    await expect(page.getByTestId('quick-add-todo')).toBeHidden();
    await page.evaluate(() => document.getElementById('stub-modal')?.remove());
    await page.locator('.cm-content').focus();
    await page.keyboard.press('q');
    await expect(page.getByTestId('quick-add-todo')).toBeHidden();
    await page.locator('body').click();
    await page.keyboard.press('q');
    await expect(page.getByTestId('quick-add-todo')).toBeVisible();
  });

  test('a list is made empty, renamed and deleted with an undo, all on the server', async ({ authenticatedPage: page }) => {
    const server = await serve(page, [T('a', 'Mow the lawn', { category: 'Home' })]);
    await page.goto('/tasks?list=all');
    await page.getByRole('button', { name: 'New list' }).click();
    await page.getByLabel('New list name').fill('Garden');
    await page.getByLabel('New list name').press('Enter');
    await expect.poll(() => server.calls.find((c) => c.method === 'POST' && c.path === '/lists')?.body).toEqual({ name: 'Garden' });
    await expect(page).toHaveURL(/list=list%3AGarden/);
    await page.reload();
    await expect(page.getByTestId('todo-list-list:Garden')).toBeVisible();

    await page.getByTestId('todo-list-list:Home').click();
    await page.getByRole('button', { name: 'Rename list' }).click();
    await page.getByLabel('List name').fill('House');
    await page.getByLabel('List name').press('Enter');
    await expect.poll(() => server.calls.find((c) => c.method === 'PATCH' && c.path === '/lists')?.body).toEqual({ name: 'Home', newName: 'House' });
    await expect(page.getByTestId('todo-list-list:House')).toBeVisible();
    await expect(row(page, 'Mow the lawn')).toBeVisible();

    await page.getByRole('button', { name: 'Delete list' }).click();
    await expect.poll(() => server.calls.some((c) => c.method === 'DELETE' && c.path === '/lists')).toBe(true);
    await expect(page.getByTestId('undo-toast')).toContainText('Deleted the list “House”');
    await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.calls.find((c) => c.path === '/lists/move')?.body).toEqual({ taskIds: ['a'], name: 'House' });
    await expect(page.getByTestId('todo-list-list:House')).toBeVisible();
  });

  test('the browser reports its zone, and Settings sets one that devices then leave alone', async ({ authenticatedPage: page }) => {
    const puts: any[] = [];
    let preferences: Record<string, string> = {};
    await page.route('**/api/auth/timezone', async (route) => {
      const body = route.request().postDataJSON();
      puts.push(body);
      if (body.source !== 'device' || !preferences.timezone) preferences = { timezone: body.timezone, timezoneSource: body.source === 'user' ? 'user' : 'device' };
      return json(route, 200, preferences);
    });
    await page.route('**/api/auth/me', (route) => json(route, 200, { id: 'e2e-user-id', username: 'e2etest', isAdmin: true, totpEnabled: false, preferences }));
    await page.goto('/settings?tab=general');
    await expect.poll(() => puts[0]).toEqual({ timezone: expect.any(String), source: 'device' });
    const setting = page.getByTestId('timezone-setting');
    await setting.getByLabel('Time zone').selectOption('Asia/Tokyo');
    await expect.poll(() => puts.at(-1)).toEqual({ timezone: 'Asia/Tokyo', source: 'user' });
    await expect(setting.getByRole('checkbox')).not.toBeChecked();
  });
});
