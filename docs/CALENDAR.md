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
  calendar (only ones you can write to are offered), and optionally add guests,
  who get an invitation by email.
- **Move** a timed event by dragging it to another time or day. It snaps to
  quarter hours. Events that run over midnight, and all-day events, are moved
  in the edit dialog instead. Dragging needs a mouse or pen.
- **Edit** changes title, time, all-day and location. The description and the
  guest list stay as they are.
- **Delete** asks once before removing the event.

A repeating event is listed as its occurrences. Editing, moving or deleting one
changes that occurrence only; the card and the dialog say so. Changing the
whole series is done in the provider's own calendar.

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

The heartbeat's "starts soon" check and the meeting-notes import still read
each account's default calendar only.

## API

All under `/api/calendar`. Refused with 403 in a shared workspace.

| Method and path | What |
|---|---|
| `GET /calendars` | Your calendars (`provider`, `id`, `name`, `color`, `primary`, `readOnly`, `shared`, `owner`, `visible`), your preferences, and `microsoftSharedAccess` (`false`: reconnect to open shared calendars). `?fresh=true` asks the providers again; the list is otherwise kept for two minutes |
| `PUT /preferences` | `{ visible?: ["google:<id>", …], hideDeclined?: boolean }`. Only the given fields change |
| `GET /events` | `from`, `to` (at most 93 days). Events of the visible calendars, each with `calendarId`, `calendarName`, `color`, `readOnly`, `responseStatus`, `meetingUrl`, `recurring`, `showAs`, `webUrl`. `partial` with `failedCalendars` when a calendar could not be read; `truncated` past 250 events per calendar |
| `POST /events` | Create: `provider`, `calendarId?`, `title`, `start`, `end`, `allDay`, `location?`, `description?`, `attendees?`, `confirm: true` |
| `PATCH /events/:id` | Change: the same body without `description` and `attendees`; `notifyAttendees: true` once the reader agreed |
| `DELETE /events/:id` | Body `{ provider, calendarId?, confirm: true, notifyAttendees? }` |
| `POST /events/:id/respond` | `{ provider, calendarId?, response: "accepted" \| "tentative" \| "declined" }` |

An event is addressed by provider, calendar and id; without `calendarId` it is
the account's default calendar. Timed values carry a timezone offset; all-day
values are dates, and the end date is the day after the last day. A write to a
read-only calendar is refused with 403, and to a calendar that is not yours
with 404. Provider endpoints are fixed, credentials stay server-side, and ids
are encoded as one path segment.

## Not yet

- Changing a whole repeating series, and making an event repeat.
- Editing the description or the guest list of an existing event.
- Reminders, and free/busy lookup for finding a time.
- Moving an event to another calendar.
- More than 250 events per calendar in one range.
- Several accounts of the same provider.
