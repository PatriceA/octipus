# Calendar

Open **Calendar** (`/calendar`) to see a week of events from your connected
Google and Microsoft 365 default calendars. Connect accounts in
**Settings → Integrations**. The Email & calendar (`inbox`) module must be enabled.

The page reads live provider data, with date navigation, provider filtering and
refresh. Times are shown in the browser's timezone. All-day events display the
covered dates; their API end date is exclusive. A failed provider or a bounded
response is shown explicitly so an incomplete schedule is not mistaken for free time.

**New event** and **Edit** save to the selected provider after explicit confirmation.
Editing preserves existing descriptions and attendees. A listed recurring
occurrence is edited individually. Calendar access is personal: switch out of a
shared or remote workspace to use it. IMAP/SMTP do not provide calendar access;
CalDAV and additional calendars within an account are not supported by this page.

Agents already have Google Workspace and Microsoft 365 calendar read, create,
update and delete tools. Creation and updates use `calendar_write` (ASK by default);
deletes use the separate dangerous delete permission. These tools run on the
calling user's connected account.

The page's API is `/api/calendar/events`: GET takes `from` and `to` (up to 93 days);
POST creates and PATCH `/:id` edits. Writes take `provider`, `title`, `start`, `end`,
`allDay`, optional `location`/`description`, and explicit `confirm: true`. Timed
values include a timezone offset; all-day values are dates. Provider endpoints
are fixed, credentials stay server-side, and event IDs are encoded as one segment.
