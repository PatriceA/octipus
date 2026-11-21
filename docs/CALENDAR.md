# Calendar

Open **Calendar** (`/calendar`) to see and manage the calendars of your
connected Google and Microsoft 365 accounts: your own and the ones other people
shared with you. Connect accounts in **Settings → Integrations**; **Add another
account** connects a second Google or Microsoft 365 account next to the first,
and each account's calendars are listed under its address. The Email &
calendar (`inbox`) module must be enabled.

Calendar access is personal: switch out of a shared or remote workspace to use
it. IMAP/SMTP do not provide calendar access, and CalDAV is not supported.

## Views

| View | Shows | Key |
|---|---|---|
| Day | One day on a time grid | `d` |
| Week (default) | Seven days on a time grid | `w` |
| Month | Six weeks; three events a day, then "+n more" opens the day | `m` |
| Agenda | Two weeks as a list | `a` |

On a phone the page opens on Day. The chosen view is remembered in the browser.

Other keys: `t` today, `j` or `→` next, `k` or `←` previous, `c` new event.
Keys typed into a field are text.

The week starts on the first day of the week in your browser's locale (Monday
where the browser does not say). Times are in the browser's timezone. An
all-day event keeps its date for every reader.

On the time grid:

- Events that overlap sit side by side.
- All-day events are bars in the lane above the grid.
- A red line marks the current time.
- Events take their calendar's colour. A declined event is struck through with
  a dashed outline; one you have not answered, or answered "maybe", has a
  dashed edge.

The page draws its frame and grid at once and fills in the events when they
arrive. The range on screen stays visible while the next one loads, and the
ranges either side are fetched ahead.

## Calendars

The sidebar lists every calendar of each account, with a tick to show or hide
it. Your choice is stored with your account, so it follows you across browsers.
**Hide events I declined** is stored the same way.

Until you choose:

- **Google** shows your main calendar and the calendars ticked in Google
  Calendar itself.
- **Microsoft 365** shows your own calendars. A calendar shared with you
  appears in the list unticked.

A lock marks a read-only calendar. Its events can be opened, not changed.

### Microsoft 365 shared calendars

Opening a calendar someone shared with you needs the `Calendars.ReadWrite.Shared`
permission, which Octipus asks for when Microsoft 365 is connected. An account
connected before this was added does not have it: connect Microsoft 365 once
more in **Settings → Integrations**. Until then your own calendars work as
before, and a shared calendar that cannot be opened is named in a warning. It
is never shown as an empty schedule.

In an organisation that does not let users grant permissions themselves, an
administrator has to approve the permission for the Octipus app registration.

## Events

Click an event for its card: time, calendar, location, description, guests and
their answers, a **Join meeting** button when the event has a meeting link, and
a link to the event in Google Calendar or Outlook.

- **Answer an invitation** with Accept, Maybe or Decline. The organiser is told.
- **Create** by clicking an empty slot (one hour), by dragging over a time
  range, by clicking the all-day lane, or with **New event**. Choose the
  calendar (only ones you can write to are offered).
- **Move** by dragging. A timed event snaps to quarter hours and keeps its
  length, also when it runs over midnight (each day shows its part). An
  all-day event moves by whole days along the all-day lane; in the month view
  any event can be dragged to another day, at the same time of day.
- **Change the end** by dragging the bottom edge of a timed event.
- On a **touch screen** an event is picked up by resting a finger on it for a
  moment; a quick swipe scrolls the page as usual.
- **Edit** changes everything the dialog shows: title, time, all-day,
  location, reminder, guests and description. It first reads the event's whole
  description and guest list (the event list only carries a preview), and it
  sends only what you changed: a description you did not touch keeps its
  formatting, a guest list you did not touch is not rewritten. A changed
  description is saved as plain text; the dialog says so when the original has
  formatting.
- **Delete** asks once before removing the event.

### Guests

Add guests by address, remove them with ×. Guests who stay keep their answer,
new guests get an invitation, removed guests are told. An address typed but not
yet added still counts when you save.

With guests on a timed event the dialog shows **Availability** for the chosen
day: your busy time (from the calendars you show) and each guest's, from the
provider of the event's calendar (Google free/busy, Microsoft `getSchedule`).
**Find a time** suggests the next free slots of the event's length for
everyone, within 9:00–17:00 on weekdays this week. A guest whose schedule
cannot be read is marked "schedule unknown" and is left out of the suggestions,
never treated as free.

### Reminders

A reminder at the start, or 5, 10, 15, 30 minutes, 1 hour or 1 day before; or
none; or the calendar's own default (Google's per-calendar setting; Microsoft's
default is used when an event is made without one).

### Repeating events

**Repeat** makes a new event daily, weekly on chosen days, monthly (on the
start's day of the month) or yearly, every n days, weeks, months or years, and
ending never, on a date, or after a number of times. The series keeps your time
zone, so a 09:00 meeting stays at 09:00 across a clock change.

A repeating event is listed as its occurrences. Moving, editing or deleting one
asks: **This event** or **All events**.

- *All events* moves every occurrence by as much as you moved this one. It
  cannot move them all to another day: change the repeat days instead. Its
  repeat rule can be changed in the dialog unless it is one the page does not
  make (for example "the second Tuesday"); such a rule is kept as it is.
- *This and following events* is not offered: neither provider has a single
  call for it, and splitting a series by hand is left to the provider's own
  calendar.

### When guests are notified

An event without guests is saved without a further question. When a change or
a deletion would reach guests, the page says how many people get an email and
waits for you to agree. The server checks this itself: without your agreement
it answers 409 with the number of guests and changes nothing.

## Agents

Agents have Google Workspace and Microsoft 365 calendar read, create, update
and delete tools, which take a calendar id. Creation and updates use
`calendar_write` (ASK by default); deletes use the separate dangerous delete
permission. These tools run on the calling user's connected account.

The heartbeat's "starts soon" check and the meeting-notes import read the
calendars you show on the Calendar page; until you choose, each account's
default calendar.

## API

All under `/api/calendar`. Refused with 403 in a shared workspace.

| Method and path | What |
|---|---|
| `GET /calendars` | Your calendars (`provider`, `id`, `name`, `color`, `primary`, `readOnly`, `shared`, `owner`, `visible`), your preferences, and `microsoftSharedAccess` (`false`: reconnect to open shared calendars). `?fresh=true` asks the providers again; the list is otherwise kept for two minutes |
| `PUT /preferences` | `{ visible?: ["google:<id>", …], hideDeclined?: boolean }`. Only the given fields change |
| `GET /events` | `from`, `to` (at most 93 days). Events of the visible calendars, each with `calendarId`, `calendarName`, `color`, `readOnly`, `responseStatus`, `meetingUrl`, `recurring`, `seriesId`, `showAs`, `webUrl`. The providers' pages are followed up to 2500 events per calendar; `truncated` beyond that. `partial` with `failedCalendars` when a calendar could not be read |
| `POST /events` | Create: `provider`, `calendarId?`, `title`, `start`, `end`, `allDay`, `location?`, `description?`, `attendees?`, `reminderMinutes?` (null: none), `recurrence?` (`{ frequency, interval?, byDay?, until? \| count? }`), `timeZone?` (IANA; required with `recurrence`), `confirm: true` |
| `PATCH /events/:id` | Change: the same body. Fields left out are not changed; `attendees` is the complete new guest list. `scope: "all"` changes the whole series of an occurrence (`recurrence` only then); `notifyAttendees: true` once the reader agreed |
| `GET /events/:id/details` | `provider`, `calendarId?`: the whole description as text (`descriptionHasFormatting`), guests with answers, `reminderMinutes`, the series' `recurrence` (`"custom"` when the page cannot show it) and `seriesId` |
| `DELETE /events/:id` | Body `{ provider, calendarId?, confirm: true, notifyAttendees?, scope? }`; `scope: "all"` deletes the whole series |
| `POST /freebusy` | `{ provider, attendees (≤ 20), from, to (≤ 8 days) }`: `busy` per guest, `failed` per guest who could not be read, `own` busy time from the visible calendars, `ownPartial` |
| `POST /events/:id/respond` | `{ provider, calendarId?, response: "accepted" \| "tentative" \| "declined" }` |

An event is addressed by provider, calendar and id; without `calendarId` it is
the account's default calendar. Timed values carry a timezone offset; all-day
values are dates, and the end date is the day after the last day. A write to a
read-only calendar is refused with 403, and to a calendar that is not yours
with 404. Provider endpoints are fixed, credentials stay server-side, and ids
are encoded as one path segment.

## Not yet

- *This and following events* for a repeating event.
- Moving a whole series to another day (change its repeat days instead), or
  switching a whole series between all-day and timed.
- Repeat rules beyond the four simple ones (for example "the second Tuesday").
- Resizing all-day events by dragging, and resizing on a touch screen by the
  edge (the edit dialog changes the end).
- Moving an event to another calendar.
- Rooms and resources as guests; working hours other than 9:00–17:00 for
  **Find a time**.
- Several accounts of the same provider.
