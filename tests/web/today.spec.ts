import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';
import { dailyTemplate, dayFromToday, endOfDay, N, serve, sha, T, TODAY } from './fixtures/todo-notes-server';

/**
 * The Today page: the day's to-dos (overdue, due today, My Day, done today,
 * yesterday's unfinished picks offered again) with capture, today's
 * calendar (and what it says without one), and today's daily note written
 * in place — made by the first keystroke, never by opening the page. The
 * API is stubbed in the browser (fixtures/todo-notes-server.ts).
 */

const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

test.describe('Today', () => {
  test('is in the sidebar near the top, and shows overdue, due today and My Day once each', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    await serve(page, {
      tasks: [
        T('late', 'Renew insurance', { dueAt: endOfDay(-2), myDayOn: TODAY }),
        T('due', 'Pay the bill', { dueAt: endOfDay(0) }),
        T('pick', 'Write the report', { myDayOn: TODAY }),
        T('later', 'Plan the trip', { dueAt: endOfDay(5) }),
        T('done', 'Book the dentist', { status: 'done', myDayOn: TODAY, completedAt: new Date().toISOString() }),
      ],
    });
    await page.goto('/');
    const nav = page.getByRole('link', { name: 'Today', exact: true }).first();
    await nav.click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByTestId('today-group-overdue').getByRole('listitem')).toHaveText([/Renew insurance/]);
    await expect(page.getByTestId('today-group-due').getByRole('listitem')).toHaveText([/Pay the bill/]);
    await expect(page.getByTestId('today-group-picked').getByRole('listitem')).toHaveText([/Write the report/]);
    await expect(page.getByTestId('today-todos')).not.toContainText('Plan the trip');
    // Done today is folded until asked for.
    await expect(page.getByTestId('today-todos')).not.toContainText('Book the dentist');
    await page.getByTestId('today-done-toggle').click();
    await expect(page.getByRole('list', { name: 'Done today' })).toContainText('Book the dentist');
  });

  test('capture adds to My Day; ticking one off moves it to Done today; yesterday\'s picks are offered again', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page, { tasks: [T('y', 'Call the bank', { myDayOn: dayFromToday(-1) }), T('y2', 'Water the plants', { myDayOn: dayFromToday(-1) })] });
    await page.goto('/today');
    await expect(page.getByTestId('today-todos-empty')).toBeVisible();
    const capture = page.getByRole('textbox', { name: 'Add a to-do', exact: true });
    await capture.fill('Buy stamps');
    await capture.press('Enter');
    await expect.poll(() => s.posts('/tasks/').at(-1)).toMatchObject({ title: 'Buy stamps', myDay: true });
    const row = page.getByRole('listitem', { name: 'Buy stamps' });
    await expect(row).toBeVisible();
    await row.getByRole('checkbox', { name: 'Mark done' }).click();
    await expect(page.getByTestId('today-done-toggle')).toContainText('1');
    // Yesterday's unfinished picks: one, or all at once.
    const earlier = page.getByTestId('my-day-earlier');
    await expect(earlier).toContainText('Call the bank');
    await earlier.getByRole('button', { name: 'Add all to today' }).click();
    await expect(page.getByTestId('today-group-picked')).toContainText('Call the bank');
    await expect(page.getByTestId('today-group-picked')).toContainText('Water the plants');
    expect(s.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual(expect.arrayContaining([expect.objectContaining({ myDay: true })]));
  });

  test('a row opens the detail panel in place', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    await serve(page, { tasks: [T('pick', 'Write the report', { myDayOn: TODAY })] });
    await page.goto('/today');
    await page.getByRole('listitem', { name: 'Write the report' }).click();
    await expect(page).toHaveURL(/\/today\?task=pick/);
    await expect(page.getByTestId('todo-detail')).toBeVisible();
    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByTestId('todo-detail')).toHaveCount(0);
  });

  test('today\'s events from the connected calendars, and what shows without one', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    await serve(page, {
      events: [
        { id: 'e1', title: 'Standup', provider: 'google', start: at(9, 30), end: at(9, 45), allDay: false, attendees: [], meetingUrl: 'https://meet.example.com/x' },
        { id: 'e2', title: 'Birthday', provider: 'google', start: `${TODAY}T00:00:00.000Z`, end: `${dayFromToday(1)}T00:00:00.000Z`, allDay: true, attendees: [] },
        { id: 'e3', title: 'Declined thing', provider: 'google', start: at(11), end: at(12), allDay: false, attendees: [], responseStatus: 'declined' },
      ],
    });
    await page.goto('/today');
    const events = page.getByTestId('today-event');
    await expect(events).toHaveCount(2);
    await expect(events.first()).toContainText('All day');
    await expect(events.nth(1)).toContainText('Standup');
    await expect(page.getByTestId('today-events')).not.toContainText('Declined thing');
  });

  test('without a connected calendar it says so and links to connecting one', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    await serve(page, { events: null });
    await page.goto('/today');
    await expect(page.getByTestId('today-events-none')).toContainText('No calendar is connected');
    await expect(page.getByTestId('today-events-none').getByRole('link')).toHaveAttribute('href', '/calendar');
  });

  test('today\'s note is not made by opening the page; the first keystroke makes it, with what was typed', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const s = await serve(page);
    await page.goto('/today');
    const editor = page.getByTestId('today-note').locator('.cm-content');
    await expect(editor).toContainText('Notes');
    await page.waitForTimeout(1200);
    expect(s.calls.filter((c) => c.path === '/notes/daily' && c.method === 'POST')).toEqual([]);
    expect(s.notes).toEqual([]);
    // Type at the end of the template.
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Remember the keys');
    await expect.poll(() => s.notes[0]?.body).toBe(`${dailyTemplate(TODAY)}Remember the keys`);
    expect(s.calls.filter((c) => c.path === '/notes/daily' && c.method === 'POST')).toHaveLength(1);
    // Saved over the note it made, naming that text.
    expect(s.posts('/notes/').find((b) => b.id === 'today-note')).toMatchObject({ ifSha256: sha(dailyTemplate(TODAY)) });
    await expect(page.getByTestId('note-save-status')).toContainText('Saved');
  });

  test('a line jotted below the note goes into it; a to-do made from a line of it is one for today', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    const daily = N('today-note', TODAY, `# ${TODAY}\n\n- [ ] Call Anna\n`, { slug: `daily/${TODAY}`, noteKind: 'daily', noteDate: TODAY });
    const s = await serve(page, { notes: [daily] });
    await page.goto('/today');
    await expect(page.getByTestId('today-note').locator('.cm-content')).toContainText('Call Anna');
    const jot = page.getByRole('textbox', { name: 'Jot a line into today’s note' });
    await jot.fill('Parcel arrived');
    await jot.press('Enter');
    await expect.poll(() => s.notes[0].body).toMatch(/- \d\d:\d\d Parcel arrived\n$/);
    await page.locator('.cm-line', { hasText: 'Call Anna' }).hover();
    await page.getByRole('button', { name: 'Make this line a to-do' }).click();
    await expect.poll(() => s.posts('/tasks/').at(-1)).toMatchObject({ title: 'Call Anna', noteId: 'today-note', noteAnchor: expect.stringMatching(/^[a-z0-9]{8}$/), myDay: true });
    await expect(page.getByTestId('today-group-picked')).toContainText('Call Anna');
    await expect.poll(() => s.notes[0].body).toMatch(/- \[ \] Call Anna \^todo-[a-z0-9]{8}\n/);
  });

  test('at phone width the page is one column: to-dos, then the calendar, then the note; nothing scrolls sideways', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubGateway(page);
    await serve(page, { tasks: [T('pick', 'Write the report', { myDayOn: TODAY })], events: [] });
    await page.goto('/today');
    await expect(page.getByTestId('today-note').locator('.cm-content')).toBeVisible();
    const top = async (id: string) => (await page.getByTestId(id).boundingBox())?.y ?? 0;
    expect(await top('today-todos')).toBeLessThan(await top('today-events'));
    expect(await top('today-events')).toBeLessThan(await top('today-note'));
    const box = await page.getByTestId('today-note').boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(await page.locator('.today-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});
