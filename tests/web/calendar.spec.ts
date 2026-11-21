import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import type { CalendarEvent, CalendarInfo } from '../../src/shared/calendar';

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const TODAY = dayOf(new Date());
/** An instant today, on the test machine's clock (the browser runs on the same one). */
const at = (time: string) => new Date(`${TODAY}T${time}:00`).toISOString();

const CALENDARS: CalendarInfo[] = [
  { provider: 'google', id: 'me@x.dev', name: 'Mine', color: '#2f7f79', primary: true, readOnly: false, shared: false, visible: true },
  { provider: 'google', id: 'team@group.calendar.google.com', name: 'Team', color: '#b3672b', primary: false, readOnly: false, shared: true, visible: true },
  { provider: 'google', id: 'boss@x.dev', name: 'Boss', color: '#6b5aa6', primary: false, readOnly: true, shared: true, owner: 'boss@x.dev', visible: true },
  { provider: 'microsoft', id: 'cal-default', name: 'Work', color: '#3f76b5', primary: true, readOnly: false, shared: false, visible: true },
  { provider: 'microsoft', id: 'cal-ana', name: 'Ana', color: '#a84f6d', primary: false, readOnly: true, shared: true, owner: 'Ana Ruiz', visible: false },
];
const event = (id: string, title: string, from: string, to: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title, provider: 'google', calendarId: 'me@x.dev', calendarName: 'Mine', color: '#2f7f79', start: at(from), end: at(to), allDay: false, attendees: [], ...extra,
});
const EVENTS: CalendarEvent[] = [
  event('planning', 'Planning', '09:00', '10:00', { description: 'Bring the numbers', location: 'Room 3' }),
  event('standup', 'Standup', '09:30', '10:00', { calendarId: 'team@group.calendar.google.com', calendarName: 'Team', color: '#b3672b', recurring: true }),
  event('review', 'Design review', '11:00', '12:00', {
    meetingUrl: 'https://meet.google.com/abc-defg-hij', responseStatus: 'needsAction', organizer: { email: 'ada@x.dev' },
    attendees: [{ email: 'me@x.dev', response: 'needsAction' }, { name: 'Ada', email: 'ada@x.dev', response: 'accepted' }, { email: 'grace@x.dev', response: 'declined' }],
  }),
  event('skipped', 'Vendor pitch', '13:00', '14:00', { responseStatus: 'declined', attendees: [{ email: 'me@x.dev', response: 'declined' }] }),
  event('boss', 'Board prep', '14:00', '15:00', { calendarId: 'boss@x.dev', calendarName: 'Boss', color: '#6b5aa6', readOnly: true }),
  event('outlook', 'Outlook meeting', '15:00', '16:00', { provider: 'microsoft', calendarId: 'cal-default', calendarName: 'Work', color: '#3f76b5' }),
  { id: 'holiday', title: 'Company day', provider: 'google', calendarId: 'me@x.dev', calendarName: 'Mine', color: '#2f7f79', start: `${TODAY}T00:00:00.000Z`, end: `${dayOf(new Date(Date.parse(`${TODAY}T12:00:00`) + 86_400_000))}T00:00:00.000Z`, allDay: true, attendees: [] },
];

interface Write { method: string; path: string; body: Record<string, unknown> }
/** The calendar API, with every write recorded. `guests`: how many the server finds on an event being changed. */
async function stubCalendar(page: Page, options: { events?: CalendarEvent[]; calendars?: CalendarInfo[]; guests?: number; list?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  await stubAllDefaults(page);
  const writes: Write[] = [];
  let reads = 0;
  const record = (route: import('@playwright/test').Route): Write => {
    const write = { method: route.request().method(), path: new URL(route.request().url()).pathname.replace('/api/calendar', ''), body: route.request().postDataJSON() ?? {} };
    writes.push(write);
    return write;
  };
  await page.route('**/api/calendar/calendars**', route => json(route, 200, { calendars: options.calendars ?? CALENDARS, providers: ['google', 'microsoft'], partial: false, preferences: {}, microsoftSharedAccess: false, ...options.extra }));
  await page.route('**/api/calendar/preferences', route => { const w = record(route); return json(route, 200, { preferences: w.body }); });
  let events = options.events ?? EVENTS;
  await page.route('**/api/calendar/events?**', route => { reads++; return json(route, 200, { events, providers: ['google', 'microsoft'], partial: false, ...options.list }); });
  await page.route('**/api/calendar/events', route => { record(route); return json(route, 200, { success: true, id: 'new' }); });
  await page.route('**/api/calendar/events/*', route => {
    const write = record(route);
    if ((options.guests ?? 0) > 0 && write.body.notifyAttendees !== true) {
      return json(route, 409, { error: `This event has ${options.guests} guests, who will be notified of the change.`, requiresAttendeeConfirmation: true, attendees: options.guests });
    }
    // A deleted event is gone from the next read.
    if (write.method === 'DELETE') events = events.filter(e => `/events/${e.id}` !== write.path);
    return json(route, 200, { success: true });
  });
  await page.route('**/api/calendar/events/*/respond', route => { record(route); return json(route, 200, { success: true }); });
  return { writes, reads: () => reads };
}

const block = (page: Page, title: string) => page.getByTestId('time-grid').getByRole('button', { name: new RegExp(`^${title},`) });

test('the week grid shows both providers, overlapping events side by side, the all-day lane and now', async ({ authenticatedPage: page }) => {
  await stubCalendar(page);
  await page.goto('/calendar');
  const grid = page.getByTestId('time-grid');
  await expect(grid).toBeVisible();
  await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(block(page, 'Planning')).toBeVisible();
  await expect(block(page, 'Outlook meeting')).toBeVisible();
  await expect(block(page, 'Company day')).toBeVisible();
  await expect(page.getByTestId('now-line')).toHaveCount(1);
  await expect(grid.getByRole('group')).toHaveCount(7);

  // Planning 09:00–10:00 and Standup 09:30–10:00 overlap: next to each other, not on top.
  const planning = (await block(page, 'Planning').boundingBox())!;
  const standup = (await block(page, 'Standup').boundingBox())!;
  const alone = (await block(page, 'Outlook meeting').boundingBox())!;
  expect(standup.x).toBeGreaterThanOrEqual(planning.x + planning.width - 1);
  expect(planning.width).toBeLessThan(alone.width * 0.6);
  // An hour is twice as tall as half an hour, and later is lower.
  expect(planning.height).toBeGreaterThan(standup.height * 1.7);
  expect(alone.y).toBeGreaterThan(planning.y);

  // A declined event is struck through, and can be hidden.
  await expect(block(page, 'Vendor pitch')).toHaveCSS('text-decoration-line', 'line-through');
});

test('calendars are listed by account; ticking one changes what is read and is saved', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page);
  await page.goto('/calendar');
  const side = page.getByRole('complementary', { name: 'Calendars' });
  await expect(side.getByLabel('Mine')).toBeChecked();
  await expect(side.getByLabel('Ana')).not.toBeChecked();
  await expect(side.getByText('To open Microsoft 365 calendars shared with you', { exact: false })).toBeVisible();
  await expect(block(page, 'Planning')).toBeVisible();
  const before = api.reads();
  await side.getByLabel('Team').uncheck();
  await expect.poll(() => api.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/preferences', body: { visible: ['google:me@x.dev', 'google:boss@x.dev', 'microsoft:cal-default'] } });
  await expect.poll(() => api.reads()).toBeGreaterThan(before);
  await side.getByLabel('Hide events I declined').check();
  await expect.poll(() => api.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/preferences', body: { hideDeclined: true } });
  await expect(block(page, 'Vendor pitch')).toHaveCount(0);
  await expect(block(page, 'Planning')).toBeVisible();
});

test('clicking the grid starts an event at that time; it is created without a confirmation tick', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page, { events: [] });
  await page.goto('/calendar');
  const column = page.locator(`[data-day="${TODAY}"]`);
  await expect(column).toBeVisible();
  const box = (await column.boundingBox())!;
  // 48px an hour: 08:00 is 384px down the day column. The grid opens scrolled to 07:00.
  await page.mouse.click(box.x + box.width / 2, box.y + 8 * 48 + 10);
  const form = page.getByRole('form', { name: 'New event' });
  await expect(form.getByLabel('Start time')).toHaveValue('08:00');
  await expect(form.getByLabel('End time')).toHaveValue('09:00');
  await expect(form.getByLabel('Start date')).toHaveValue(TODAY);
  await expect(form.getByLabel('Calendar')).toHaveValue('google:me@x.dev');
  // Read-only calendars cannot be chosen.
  await expect(form.getByLabel('Calendar').locator('option')).toHaveText(['Mine · Google', 'Team · Google', 'Work · Microsoft 365']);
  await form.getByLabel('Title').fill('New appointment');
  await form.getByLabel('Calendar').selectOption('google:team@group.calendar.google.com');
  await form.getByLabel('Guests').fill('ada@x.dev, grace@x.dev');
  await form.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByRole('status')).toContainText('Event created.');
  expect(api.writes).toEqual([{ method: 'POST', path: '/events', body: {
    provider: 'google', calendarId: 'team@group.calendar.google.com', title: 'New appointment', allDay: false,
    start: at('08:00'), end: at('09:00'), location: '', description: '', attendees: ['ada@x.dev', 'grace@x.dev'], confirm: true,
  } }]);
  await expect(form).toHaveCount(0);
});

test('dragging on the grid draws the new event\'s time; the all-day lane makes an all-day event', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page, { events: [] });
  await page.goto('/calendar');
  const column = page.locator(`[data-day="${TODAY}"]`);
  const box = (await column.boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 9 * 48 + 2);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 10 * 48, { steps: 4 });
  await page.mouse.move(x, box.y + 11 * 48 + 24, { steps: 4 });
  await expect(column.getByText('New event', { exact: false })).toBeVisible();
  await page.mouse.up();
  const form = page.getByRole('form', { name: 'New event' });
  await expect(form.getByLabel('Start time')).toHaveValue('09:00');
  await expect(form.getByLabel('End time')).toHaveValue('11:30');
  await form.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: /^New all-day event on/ }).first().click();
  await expect(form.getByLabel('All day')).toBeChecked();
  await form.getByLabel('Title').fill('Offsite');
  await form.getByRole('button', { name: 'Create event' }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  // The stored end of an all-day event is the day after its last day.
  const body = api.writes[0].body as { start: string; end: string; allDay: boolean };
  expect(body.allDay).toBe(true);
  expect(body.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Date.parse(body.end) - Date.parse(body.start)).toBe(86_400_000);
});

test('an event card shows the details, joins the meeting and answers the invitation', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page);
  await page.goto('/calendar');
  await block(page, 'Design review').click();
  const card = page.getByRole('dialog', { name: 'Design review' });
  await expect(card.getByRole('link', { name: 'Join meeting' })).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
  await expect(card.getByText('3 guests')).toBeVisible();
  await expect(card.getByText('Your answer: Not answered')).toBeVisible();
  await card.getByRole('button', { name: 'Decline' }).click();
  await expect.poll(() => api.writes).toEqual([{ method: 'POST', path: '/events/review/respond', body: { provider: 'google', calendarId: 'me@x.dev', response: 'declined' } }]);
  await expect(page.getByRole('status')).toContainText('Declined.');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // A read-only calendar's event can be looked at, not changed.
  await block(page, 'Board prep').click();
  const readOnly = page.getByRole('dialog', { name: 'Board prep' });
  await expect(readOnly.getByText('read-only')).toBeVisible();
  await expect(readOnly.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(readOnly.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('an event without guests is edited at once; description and guest list are not sent', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page);
  await page.goto('/calendar');
  await block(page, 'Standup').click();
  const card = page.getByRole('dialog', { name: 'Standup' });
  await expect(card.getByText('Changes here apply to this occurrence only', { exact: false })).toBeVisible();
  await card.getByRole('button', { name: 'Edit' }).click();
  const form = page.getByRole('form', { name: 'Edit event' });
  await expect(form.getByText('only this occurrence changes', { exact: false })).toBeVisible();
  await expect(form.getByLabel('Calendar')).toBeDisabled();
  await form.getByLabel('Title').fill('Daily standup');
  await form.getByLabel('End time').fill('10:15');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Event saved.');
  expect(api.writes).toEqual([{ method: 'PATCH', path: '/events/standup', body: {
    provider: 'google', calendarId: 'team@group.calendar.google.com', title: 'Daily standup', allDay: false, start: at('09:30'), end: at('10:15'), location: '', confirm: true,
  } }]);
});

test('changing an event with guests names how many are notified, and waits for a yes', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page, { guests: 3 });
  await page.goto('/calendar');
  await block(page, 'Design review').click();
  await page.getByRole('dialog', { name: 'Design review' }).getByRole('button', { name: 'Edit' }).click();
  const form = page.getByRole('form', { name: 'Edit event' });
  await form.getByLabel('Location').fill('Room 5');
  await form.getByRole('button', { name: 'Save changes' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Guests will be notified' });
  await expect(ask).toContainText('This event has 3 guests');
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0].body).not.toHaveProperty('notifyAttendees');
  // Saying no keeps the dialog and what was typed.
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(form.getByLabel('Location')).toHaveValue('Room 5');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: 'Notify 3 guests' }).click();
  await expect(page.getByRole('status')).toContainText('Event saved.');
  expect(api.writes.at(-1)).toMatchObject({ method: 'PATCH', path: '/events/review', body: { location: 'Room 5', notifyAttendees: true, confirm: true } });
  await expect(form).toHaveCount(0);
});

test('deleting asks first, and says when guests are told', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page, { guests: 3 });
  await page.goto('/calendar');
  await block(page, 'Design review').click();
  const card = page.getByRole('dialog', { name: 'Design review' });
  await card.getByRole('button', { name: 'Delete' }).click();
  const confirm = card.getByRole('alertdialog', { name: 'Delete event' });
  await expect(confirm).toContainText('Its 3 guests will be told it is cancelled.');
  expect(api.writes).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  expect(api.writes).toHaveLength(0);
  await card.getByRole('button', { name: 'Delete' }).click();
  await card.getByRole('button', { name: 'Delete and notify' }).click();
  await expect(page.getByRole('status')).toContainText('Event deleted.');
  expect(api.writes).toEqual([{ method: 'DELETE', path: '/events/review', body: { provider: 'google', calendarId: 'me@x.dev', confirm: true, notifyAttendees: true } }]);
  await expect(block(page, 'Design review')).toHaveCount(0);
});

test('dragging an event moves it by the grid\'s quarter hours', async ({ authenticatedPage: page }) => {
  const api = await stubCalendar(page);
  await page.goto('/calendar');
  const box = (await block(page, 'Outlook meeting').boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 30, { steps: 3 });
  await page.mouse.move(x, box.y + 10 + 72, { steps: 5 });
  await expect(page.getByText('Move here', { exact: false })).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('Event moved.');
  // 72px is an hour and a half: 15:00–16:00 becomes 16:30–17:30. The drag does not open the card.
  expect(api.writes).toEqual([{ method: 'PATCH', path: '/events/outlook', body: { provider: 'microsoft', calendarId: 'cal-default', confirm: true, title: 'Outlook meeting', allDay: false, start: at('16:30'), end: at('17:30') } }]);
  await expect(page.getByRole('dialog', { name: 'Outlook meeting' })).toHaveCount(0);
});

test('day, month and agenda views, by button and by key', async ({ authenticatedPage: page }) => {
  await stubCalendar(page);
  await page.goto('/calendar');
  await expect(block(page, 'Planning')).toBeVisible();
  const title = page.getByRole('heading', { level: 2 });
  const week = await title.textContent();

  await page.keyboard.press('m');
  const month = page.getByTestId('month-grid');
  await expect(month).toBeVisible();
  await expect(month.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: /^Company day,/ })).toBeVisible();
  // Seven events today: three are listed, the rest are a step away.
  await month.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: '+4 more' }).click();
  await expect(page.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('time-grid').getByRole('group')).toHaveCount(1);

  await page.keyboard.press('a');
  const agenda = page.getByTestId('agenda');
  await expect(agenda.getByRole('button', { name: /Design review/ })).toBeVisible();
  await expect(agenda.getByText('Today', { exact: false }).first()).toBeVisible();

  await page.keyboard.press('w');
  await expect(title).toHaveText(week!);
  await page.keyboard.press('j');
  await expect(title).not.toHaveText(week!);
  await page.keyboard.press('t');
  await expect(title).toHaveText(week!);
  await page.keyboard.press('ArrowLeft');
  await expect(title).not.toHaveText(week!);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(title).toHaveText(week!);

  // Keys typed into a field are text, not commands.
  await page.keyboard.press('c');
  const form = page.getByRole('form', { name: 'New event' });
  await form.getByLabel('Title').fill('made with a key');
  await expect(form.getByLabel('Title')).toHaveValue('made with a key');
  await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('the page has its shape before any calendar answers', async ({ authenticatedPage: page }) => {
  await stubCalendar(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/calendar/events?**', async route => { await held; return json(route, 200, { events: EVENTS, providers: ['google'], partial: false }); });
  await page.route('**/api/calendar/calendars**', async route => { await held; return json(route, 200, { calendars: CALENDARS, providers: ['google'], partial: false, preferences: {}, microsoftSharedAccess: null }); });
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByTestId('time-grid').getByRole('group')).toHaveCount(7);
  await expect(page.getByRole('complementary', { name: 'Calendars' })).toBeVisible();
  await expect(page.locator('.animate-pulse').first()).toBeVisible();
  release();
  await expect(block(page, 'Planning')).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
});

test('an incomplete schedule is said to be incomplete, with the calendar that failed', async ({ authenticatedPage: page }) => {
  await stubCalendar(page, { events: [], list: { partial: true, truncated: true, failedCalendars: ['Ana'] } });
  await page.goto('/calendar');
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load Ana.' })).toContainText('This schedule may be incomplete.');
  await expect(page.getByText('connect Microsoft 365 once more', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('This range holds more events than could be loaded.', { exact: false })).toBeVisible();
});

test('without a connected calendar the page says where to connect one', async ({ authenticatedPage: page }) => {
  await stubCalendar(page, { events: [], calendars: [], extra: { providers: [], microsoftSharedAccess: null }, list: { providers: [] } });
  await page.goto('/calendar');
  await expect(page.getByText('No calendar connected')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings → Integrations' })).toHaveAttribute('href', '/settings?tab=integrations');
  await expect(page.getByRole('button', { name: 'New event' })).toBeDisabled();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test('the calendar opens on one day, with the calendar list a tap away', async ({ authenticatedPage: page }) => {
    await stubCalendar(page);
    await page.goto('/calendar');
    await expect(page.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('time-grid').getByRole('group')).toHaveCount(1);
    await expect(block(page, 'Planning')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Calendars' })).toBeHidden();
    await page.getByRole('button', { name: 'Calendars', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Calendars' }).getByLabel('Mine')).toBeVisible();
    // Nothing is wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
