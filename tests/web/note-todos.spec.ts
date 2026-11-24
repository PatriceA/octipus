import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';
import { N, serve, sha, T } from './fixtures/todo-notes-server';

/**
 * To-dos linked to notes, on the web: a note's task line (or a selection)
 * made a to-do from the editor and the reading view, the line's chip and
 * the note's to-dos panel, the tick on either side reaching the other, a
 * save refused because a to-do ticked the note meanwhile merged and saved
 * again, and the to-do's detail panel with its linked notes and its notes
 * field in markdown. The API is stubbed in the browser
 * (fixtures/todo-notes-server.ts).
 */

const PLAN = () => N('plan', 'Trip plan', 'Trip plan\n- [ ] Book flights\n- [x] Pack bags\n\nAsk about the visa today.');

test.describe('a note line made a to-do', () => {
  test('⌘⇧Enter on a task line makes a to-do linked to it; the line shows it and the to-dos panel lists it', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, { notes: [PLAN()] });
    await page.goto('/notes?note=plan');
    await page.locator('.cm-line', { hasText: 'Book flights' }).click();
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect.poll(() => s.posts('/tasks/').at(-1)).toMatchObject({ title: 'Book flights', noteId: 'plan', noteAnchor: expect.stringMatching(/^[a-z0-9]{8}$/) });
    const anchor = s.posts('/tasks/').at(-1)?.noteAnchor as string;
    // The marker reaches the note by its own save, over the text it was made from.
    await expect.poll(() => s.notes[0].body).toBe(`Trip plan\n- [ ] Book flights ^todo-${anchor}\n- [x] Pack bags\n\nAsk about the visa today.`);
    expect(s.posts('/notes/').at(-1)).toMatchObject({ ifSha256: sha('Trip plan\n- [ ] Book flights\n- [x] Pack bags\n\nAsk about the visa today.') });
    // The marker is drawn as a chip, never as text.
    await expect(page.locator('.cm-content')).not.toContainText('^todo-');
    await expect(page.locator('.cm-np-todo')).toHaveText('To-do');
    await page.getByRole('button', { name: 'Links and related notes' }).click();
    await expect(page.getByTestId('note-linked-task')).toContainText('Book flights');
    await expect(page.getByTestId('note-linked-task')).toContainText('from a line');
  });

  test('a ticked line makes a done to-do; a plain line becomes a task line; Undo takes it back', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, { notes: [PLAN()] });
    await page.goto('/notes?note=plan');
    await page.locator('.cm-line', { hasText: 'Pack bags' }).click();
    await page.getByRole('button', { name: 'Make a to-do of this line or the selection (⌘⇧Enter)' }).click();
    await expect.poll(() => s.tasks.find((t) => t.title === 'Pack bags')?.status).toBe('done');
    await page.locator('.cm-line', { hasText: 'Ask about the visa' }).click();
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect.poll(() => s.notes[0].body).toMatch(/\n- \[ \] Ask about the visa today\. \^todo-[a-z0-9]{8}$/);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => s.tasks.find((t) => t.title === 'Ask about the visa today.')?.status).toBe('archived');
    await expect.poll(() => s.notes[0].body).toMatch(/\n- \[ \] Ask about the visa today\.$/);
  });

  test('ticking a linked line completes its to-do by the note\'s save; completing the to-do ticks the line', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, {
      notes: [N('plan', 'Trip plan', 'Trip plan\n- [ ] Book flights ^todo-fly12345')],
      tasks: [T('fly', 'Book flights')],
      links: [{ taskId: 'fly', noteId: 'plan', anchor: 'fly12345' }],
    });
    await page.goto('/notes?note=plan');
    await page.getByRole('checkbox', { name: 'Mark task done' }).click();
    await expect.poll(() => s.tasks[0].status).toBe('done');
    await expect(page.locator('.cm-np-todo')).toHaveText('Done');
    // From the note's to-dos panel: reopened, and the server unticks the line.
    await page.getByRole('button', { name: 'Links and related notes' }).click();
    await page.getByTestId('note-linked-task').getByRole('checkbox').click();
    await expect.poll(() => s.tasks[0].status).toBe('open');
    await expect.poll(() => s.notes[0].body).toBe('Trip plan\n- [ ] Book flights ^todo-fly12345');
    await expect(page.getByRole('checkbox', { name: 'Mark task done' })).toBeVisible();
  });

  test('a save refused because a to-do ticked the note meanwhile is merged and saved again, nothing lost', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, {
      notes: [N('plan', 'Trip plan', 'Trip plan\n- [ ] Book flights ^todo-fly12345\n\nNotes:')],
      tasks: [T('fly', 'Book flights')],
      links: [{ taskId: 'fly', noteId: 'plan', anchor: 'fly12345' }],
    });
    await page.goto('/notes?note=plan');
    await expect(page.locator('.cm-content')).toContainText('Notes:');
    // Elsewhere (another device, an agent): the to-do is completed, and the server ticks the line.
    s.tasks[0].status = 'done';
    s.notes[0].body = 'Trip plan\n- [x] Book flights ^todo-fly12345\n\nNotes:';
    await page.locator('.cm-line', { hasText: 'Notes:' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' window seat');
    await expect.poll(() => s.notes[0].body).toBe('Trip plan\n- [x] Book flights ^todo-fly12345\n\nNotes: window seat');
    expect(s.calls.filter((c) => c.method === 'POST' && c.path === '/notes/').length).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('note-save-status')).toContainText('Saved');
    await expect(page.getByText('changed elsewhere')).toHaveCount(0);
  });

  test('the reading view draws the chip, offers "+ To-do" on a line, and makes a to-do of a selection', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, {
      notes: [N('plan', 'Trip plan', 'Trip plan\n- [ ] Book flights ^todo-fly12345\n- [ ] Book the hotel\n\nAsk the embassy about the visa rules.')],
      tasks: [T('fly', 'Book flights')],
      links: [{ taskId: 'fly', noteId: 'plan', anchor: 'fly12345' }],
    });
    await page.goto('/notes?note=plan');
    await page.getByRole('button', { name: 'Reading view' }).click();
    const reader = page.locator('.notes-reading');
    await expect(reader).not.toContainText('^todo-');
    await expect(reader.getByRole('button', { name: /To-do: Book flights/ })).toBeVisible();
    await reader.getByRole('button', { name: 'Make this line a to-do' }).click();
    await expect.poll(() => s.posts('/tasks/').at(-1)).toMatchObject({ title: 'Book the hotel', noteAnchor: expect.any(String) });
    await expect.poll(() => s.notes[0].body).toMatch(/- \[ \] Book the hotel \^todo-[a-z0-9]{8}/);
    // Saved and read again: its chip names the new to-do (the view is drawn anew, so select after that).
    await expect(reader.getByRole('button', { name: /To-do: Book the hotel/ })).toBeVisible();
    await expect(page.getByTestId('note-save-status')).toContainText('Saved');
    // A selection: a to-do titled by it, the note attached.
    await reader.getByText('Ask the embassy about the visa rules.').selectText();
    await page.getByRole('button', { name: 'Make a to-do', exact: true }).click();
    await expect.poll(() => s.posts('/tasks/').at(-1)).toEqual(expect.objectContaining({ title: 'Ask the embassy about the visa rules.', noteId: 'plan' }));
    expect(s.posts('/tasks/').at(-1)?.noteAnchor).toBeUndefined();
    // The chip opens its to-do.
    await reader.getByRole('button', { name: /To-do: Book flights/ }).click();
    await expect(page).toHaveURL(/\/tasks\?list=all&task=fly/);
  });
});

test.describe('a to-do\'s notes', () => {
  test('linked notes show as chips that open them; a note is attached (existing or new) and unlinked', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, {
      notes: [N('plan', 'Trip plan', 'Trip plan'), N('pack', 'Packing list', 'Packing list')],
      tasks: [T('fly', 'Book flights', { myDayOn: null })],
      links: [{ taskId: 'fly', noteId: 'plan', anchor: 'fly12345' }],
    });
    await page.goto('/tasks?list=all&task=fly');
    const notes = page.getByTestId('todo-linked-notes');
    await expect(notes.getByTestId('todo-note-chip')).toHaveText([/Trip plan.*line/]);
    await notes.getByRole('button', { name: 'Attach another note' }).click();
    await notes.getByRole('textbox', { name: 'Find or name a note' }).fill('pack');
    await notes.getByRole('button', { name: 'Packing list' }).click();
    await expect(notes.getByTestId('todo-note-chip')).toHaveCount(2);
    await notes.getByRole('button', { name: 'Attach another note' }).click();
    await notes.getByRole('textbox', { name: 'Find or name a note' }).fill('Visa questions');
    await notes.getByRole('textbox', { name: 'Find or name a note' }).press('Enter');
    await expect.poll(() => s.posts('/tasks/fly/notes').at(-1)).toEqual({ title: 'Visa questions' });
    await expect(notes.getByTestId('todo-note-chip')).toHaveCount(3);
    await notes.getByRole('button', { name: 'Unlink “Packing list”' }).click();
    await expect(notes.getByTestId('todo-note-chip')).toHaveCount(2);
    await notes.getByRole('button', { name: /Trip plan/ }).first().click();
    await expect(page).toHaveURL(/\/notes\?note=plan/);
  });

  test('the notes field shows markdown with its links, and is plain text to edit', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, { tasks: [T('fly', 'Book flights', { notes: 'Use the **aisle**. See [the airline](https://air.example.com)\n\n<script>alert(1)</script>' })] });
    await page.goto('/tasks?list=all&task=fly');
    const rendered = page.getByTestId('todo-notes-rendered');
    await expect(rendered.locator('strong')).toHaveText('aisle');
    await expect(rendered.getByRole('link', { name: 'the airline' })).toHaveAttribute('href', 'https://air.example.com');
    await expect(rendered.getByRole('link', { name: 'the airline' })).toHaveAttribute('rel', /noopener/);
    // Raw HTML is never rendered.
    expect(await rendered.locator('script').count()).toBe(0);
    await rendered.click({ position: { x: 4, y: 4 } });
    const field = page.getByRole('textbox', { name: 'Notes' });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(/\*\*aisle\*\*/);
    await field.fill('Window seat after all');
    await field.blur();
    await expect.poll(() => s.tasks[0].notes).toBe('Window seat after all');
    await expect(page.getByTestId('todo-notes-rendered')).toHaveText('Window seat after all');
  });

  test('a picture in a to-do\'s notes never loads by itself', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const pixel: string[] = [];
    await page.route('https://tracker.example/**', (route) => { pixel.push(route.request().url()); return route.fulfill({ status: 200, body: '' }); });
    await serve(page, { tasks: [T('fly', 'Book flights', { notes: 'See ![x](https://tracker.example/p.png?d=secret)' })] });
    await page.goto('/tasks?list=all&task=fly');
    const rendered = page.getByTestId('todo-notes-rendered');
    await expect(rendered).toContainText('See');
    await expect(rendered.locator('img')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(pixel).toEqual([]);
  });

  test('the note reads again only when one of its own to-dos changes', async ({ authenticatedPage: page }) => {
    const gateway = await stubGateway(page);
    const s = await serve(page, {
      notes: [N('plan', 'Trip plan', 'Trip plan\n- [ ] Book flights ^todo-fly12345')],
      tasks: [T('fly', 'Book flights'), T('other', 'Unrelated')],
      links: [{ taskId: 'fly', noteId: 'plan', anchor: 'fly12345' }],
    });
    await page.goto('/notes?note=plan');
    await expect(page.locator('.cm-np-todo')).toHaveText('To-do');
    const reads = () => s.calls.filter((c) => c.method === 'GET' && c.path === '/notes/plan').length;
    const before = reads();
    gateway.event('tasks.changed', { taskId: 'other' });
    await page.waitForTimeout(900);
    expect(reads()).toBe(before);
    s.tasks[0].status = 'done';
    gateway.event('tasks.changed', { taskId: 'fly' });
    await expect(page.locator('.cm-np-todo')).toHaveText('Done');
    expect(reads()).toBeGreaterThan(before);
  });

  test('a row says which note a to-do is linked to', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    await serve(page, {
      notes: [N('plan', 'Trip plan', 'Trip plan')],
      tasks: [T('fly', 'Book flights')],
      links: [{ taskId: 'fly', noteId: 'plan', anchor: null }],
    });
    await page.goto('/tasks?list=all');
    await expect(page.getByRole('listitem', { name: 'Book flights' }).getByTestId('todo-linked-note')).toContainText('Trip plan');
  });
});

test('Ctrl+K adds a line to today\'s note from anywhere', async ({ authenticatedPage: page }) => {
  await stubGateway(page);
  const s = await serve(page);
  await page.goto('/tasks');
  const search = page.getByPlaceholder(/search, or type a to-do/);
  await search.fill('Idea: a reading lamp');
  await page.getByTestId('search-capture-note').click();
  await expect.poll(() => s.posts('/notes/capture').at(-1)).toMatchObject({ text: 'Idea: a reading lamp', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  await expect(page.getByRole('status').filter({ hasText: 'Added to today’s note' })).toBeVisible();
});
