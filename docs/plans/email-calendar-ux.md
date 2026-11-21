# Email and calendar: from a view of agent data to a client people use

> **Status (2026-11-21):** every phase is built, including the local header
> index (decision 1). See [What is built](#what-is-built) and the remaining
> [Limits](#limits). Nothing has run
> against a real Google or Microsoft account yet: see
> [Unverified against the providers](#unverified-against-the-providers).

## Why

The Email and Calendar pages work, but they read as a display of what the
agents see, not as tools someone would use on their own. The owner's review
(2026-11-21):

- The email page shows a full-page spinner for seconds, with no page structure.
- It feels like a stripped-down old mail client, not a modern one.
- "Triage inbox" starts without saying how many mails, which ones, with which
  categories, or what the model is told.
- The calendar is a list of events, and shared calendars are not supported.

One cause runs through most of it. Both pages are live proxies to Google and
Microsoft 365 with no local state. Every visit starts from nothing, and
anything the providers do not store for us (triage results, counts, search
across accounts) does not exist after a reload.

## Findings

Read from the code on 2026-11-21. The app was not run against a live mailbox.

### Email: loading

- `web/app/email/page.tsx` returned only a spinner until the inbox arrived, so
  not even the page header rendered. Before that, `mail-workspace.tsx` shows a
  bare "Loading workspace…".
- The inbox uses `useState` and `useEffect`: no cache, so every visit refetches.
  The calendar page already uses react-query.
- A Gmail inbox load is one list call plus 20 per-message calls, five at a time
  (`getInbox` in `src/core/email/service.ts`).

### Email: bugs

| Bug | State |
|---|---|
| Triage results were lost on reload: `/api/email/inbox` never read them back | Fixed in phase 0 |
| Gmail mail with an attachment showed only its snippet: the decoder looked one MIME level deep | Fixed in phase 0 |
| A sent reply was a new, unthreaded mail (saving a draft threaded correctly) | Fixed in phase 0 |
| Remote images loaded on open, which tells the sender the mail was read | Fixed in phase 0 |
| Auto-archive defaulted to on, so the first triage archived mail unasked | Fixed in phase 0 |
| HTML mail renders into the app's DOM: sender styles clash with the dark theme | Phase 5 (sandboxed frame) |
| Outlook is unreachable when Google is connected: `detectProvider` picks Google, one account per provider | Phase 6 |
| Auto-archive is tied to the category names `spam` and `promotion`; renaming them stops it silently | Phase 2 |
| Editing categories does not invalidate calibration: thresholds are still fitted on labels from the old list | Phase 2 |
| "Label by category" and auto-archive are per-browser `localStorage` settings | Phase 2 |

### Email: missing for a real client

- No search, no folders (inbox only), no conversation view (`threadId` is
  fetched and unused).
- No compose, reply-all, cc or forward on the Google/Microsoft inbox.
- No attachments, delete, mark unread, star, snooze or bulk select.
- No date on list rows, no refresh, no check for new mail, no keyboard
  shortcuts.
- The whole page scrolls instead of separate panes. On a phone the opened
  message appears below the list.
- IMAP mailboxes are a second, different inbox behind a `<select>`: plain text
  only, and no triage, summary or draft help.

### Triage

- The button triages every loaded row, including read mail and mail already
  triaged, whatever filter is active. Nothing says so.
- A run is one synchronous request with no progress and no cancel. At about 7 s
  per mail on the decision model ([EMAIL-TRIAGE.md](../EMAIL-TRIAGE.md)) a large
  run takes minutes.
- The LLM's `reason` per mail was not shown (phase 0 puts it in the priority
  badge's tooltip). Which model decided, and how confident it was, is not
  returned to the page.
- A label can only be corrected in the Review queue, which lists uncertain mail
  only. `PUT /api/email/triage/label/:id` would serve an inline correction.
- The owner cannot give the model any direction. The rubric and the worked
  examples from the same sender are invisible constants.
- Five controls sit in the page header (two checkboxes, Categories, Review,
  Triage), and the Review panel speaks in thresholds.

### Calendar

- Only the default calendar of each provider is read and written
  (`src/core/calendar/events.ts`, `manage.ts`). The heartbeat probe and the
  meeting import have the same limit. The agent calendar tools already take a
  calendar id.
- The page is day headings over bordered cards: no week, day or month grid, no
  overlap, no line for "now".
- The range was seven days from the chosen date, not a week (fixed in phase 0).
- Events carry no calendar, colour, response status, meeting link, recurrence
  or free/busy. A declined event looks like an accepted one.
- Editing has no delete, attendees, recurrence, reminders or RSVP, hides the
  description, and asks for a confirmation checkbox on every save.
- An edit of an event with attendees notifies them, and the page does not say
  so. `calendarEventAttendees` exists to check.
- At most 250 events, without paging.
- **Suspected, not verified:** Microsoft events are requested in UTC and
  all-day events are then placed by the UTC date, which would move them a day
  for readers east of UTC. Needs a test against a real tenant.

## The triage dialog (phase 2)

"Triage inbox" opens a dialog that shows what will happen before it starts.
A "skip this next time" option runs with the saved settings, and a one-line
summary of them stays under the button.

1. **Scope.** "36 mails will be triaged", with a choice: not yet triaged
   (default), unread, all loaded, or the newest N of the inbox. The split is
   shown: "6 already labelled by you, kept as they are".
2. **Categories.** Chips with their descriptions, editable in place. Replaces
   the separate editor.
3. **What the model is told.** The three priority rules. "Sees sender, subject
   and the start of the mail, never the body." "Sees up to five earlier mails
   from the same sender or domain; your own labels outweigh a model's."
4. **Your instructions.** New: saved free text ("anything from my accountant is
   high"), given to both models.
5. **Models.** Which decision model and which fallback LLM run, and whether the
   mail stays on this machine.
6. **After triage.** Label in the mailbox, and auto-archive: saved on the
   server, archive off by default.
7. **Run.** Progress as x of N, with cancel.
8. **Result.** A category by priority summary and the list of mail proposed
   for archiving, confirmed before anything moves.

Backend: a preview endpoint for the dialog; triage as a background job with
progress (the backlog run already works this way); a calibration key that
covers the category list and the owner's instructions, not only the rubric
version; inline label correction and "why" on each inbox row.

## Shared calendars (phase 3)

- **Google:** the `calendar` scope Octipus already asks for covers the
  calendar list. No new consent.
- **Microsoft:** shared calendars need `Calendars.ReadWrite.Shared`. Users
  reconnect once.
- **Event shape:** calendar id and name, colour, read-only, response status,
  meeting link, recurrence. An event is addressed by provider, calendar and id.
- **Writes** name their calendar and respect its access role.
- **Which calendars are shown** is stored per user.
- The heartbeat probe and the meeting import read the same selection.

## Phases

| Phase | What | Size |
|---|---|---|
| 0. Fixes | The bugs marked above, calendar week and end times | built |
| 1. Perceived speed | The page frame renders at once with placeholder rows; the last list stays while the next loads; a short server-side page memory; one Gmail batch request per list; neighbouring calendar ranges fetched ahead | built |
| 2. Triage dialog | The flow above | built |
| 3. Shared calendars | Calendar list, colours, show/hide, Microsoft re-consent | built |
| 4. Calendar grid | Week, day, month and agenda views; event card with Join and RSVP; delete; drag to create, move and resize (touch too); repeating events; reminders; guests and description on edit; find a time; confirmation only when guests are notified | built |
| 5. Email client | Three panes that scroll on their own; conversations; search; folders; compose, reply all, forward; attachments; bulk actions; shortcuts; HTML in a sandboxed frame | built |
| 6. One inbox | Every Google, Microsoft and IMAP/POP3 mailbox in one list ("All inboxes"); several accounts per provider; AI help and triage for IMAP mail; triage over all mailboxes; automatic triage; a local header index | built |

## What is built

### Email (phases 1, 2, 5, 6)

- **The page** (`web/components/mail/email-client.tsx` and its siblings) is a
  mail window: folders, list and reading pane each scroll on their own, and on
  a phone the opened conversation replaces the list. The frame renders at once.
- **Lists** come from `GET /api/email/messages`: inbox, starred, sent, drafts,
  archive and trash, search, an unread filter, paging, the inbox's unread
  count. New mail is checked every minute while the inbox is open.
- **Conversations.** Messages of one thread are one row; the reading pane
  shows the thread, newest open.
- **Actions:** archive, trash, read/unread, star, on one conversation or many,
  with Undo for moves. Nothing is deleted for good. Keyboard: `j`/`k`, `e`,
  `#`, `u`, `s`, `x`, `c`, `/`.
- **Writing:** compose, reply, reply all, forward, cc and bcc. "Send" shows who
  gets the mail; "Send now" delivers it. "Draft with AI" and "Save to drafts"
  remain for replies.
- **Reading:** mail HTML is drawn in a frame that runs no script and is always
  light, so sender styling no longer fights the dark theme. Attachments
  download.
- **Triage** is the dialog described above. Each mail shows its triage, who
  gave it and the reason, and the owner corrects it in place.
- **Several mailboxes.** Every route can name its mailbox, so Outlook is
  reachable with Google connected. "All inboxes" merges both by date and sends
  each action to the mailbox the message lives in.
- **Triage settings** live on the server (`users.preferences.emailTriage`).
  Labelling the mailbox and auto-archive are both off until turned on, and the
  archive categories are chosen, not tied to the names `spam` and `promotion`.
- **Calibration** is keyed by the question wording, the category list and the
  owner's instructions (`rubricKey`). The presets with no instructions keep
  the earlier key, so existing calibration still counts.
- **Writing extras** for Gmail and Outlook: attachments (20 files, 25 MB),
  forwarding keeps the original's files, a formatting toolbar (sent as text
  and HTML built and sanitized on the server), snooze with a Snoozed folder.
- **Several accounts per provider.** Settings → Integrations → Add another
  account. Each account is its own mailbox and has its own calendars; the
  default account is the one agents and the heartbeat use.
- **IMAP/POP3 mailboxes** use the same window (`/mail` shows IMAP only), with
  summaries, reply directions, AI drafts, to-dos and triage. Sending goes
  through a saved draft and sends exactly the saved revision.
- **Triage over All inboxes** in one run, and **automatic triage** (opt-in)
  of newly arrived mail with the saved settings.
- **Local header index** of the default Google/Microsoft account's last 90
  days: lists, search and unread counts are served from it when it is fresh;
  older mail and other accounts are read live. Off switch in the mailbox
  settings; see [MAIL.md](../MAIL.md).

### Calendar (phases 3, 4)

Described for users in [CALENDAR.md](../CALENDAR.md). In short: every calendar
of every connected account can be shown or hidden, the choice is stored per
user, and the page is a grid with week, day, month and agenda views, an event
card (Join, RSVP, Edit, Delete), creation by click or drag, moving and
resizing by drag (long press on touch), repeating events with "This event /
All events", reminders, guests and description on edit, and "Find a time"
from everyone's busy time. The heartbeat and the meeting import follow the
calendars shown on the page.

## Limits

- **Email:** IMAP/POP3 mailboxes send plain text without attachments and
  cannot be snoozed (their backend stores plain-text drafts and changes
  nothing on the server). The local index covers each provider's default
  account; other accounts are read live. Automatic triage covers every
  connected account and personal IMAP mailboxes; a space mailbox is
  triaged by hand, and triage labels on it are per user. One triage run per
  user at a time.
- **Calendar:** "This and following events" is not offered; a series moves as
  a whole by the same shift, not to another weekday. Changing a description
  saves it as plain text.
- **Old routes kept:** `POST /api/email/triage` (one synchronous request) and
  `GET /api/email/inbox` still work for other clients. On Outlook the old
  inbox route still lists every folder; the page no longer uses it.

## Unverified against the providers

Written from the providers' documentation and not yet run against a live
account. Each has a fallback or fails visibly, but check these first when
connecting a real mailbox:

- **Gmail:** the batch endpoint and its response format (a list that cannot be
  parsed falls back to one request per message: slow, not broken); the trash
  and archive list queries; small attachments arriving inline.
- **Microsoft Graph mail:** the well-known folder names as list paths and move
  targets; search paging; listing a conversation by its id; the attachment
  download path; flags for stars; cc and bcc on a reply.
- **Microsoft Graph calendar:** whether all-day events really shift under the
  UTC preference (if not, the fix does nothing); RSVP and writes on a calendar
  in another mailbox; consent for `Calendars.ReadWrite.Shared` in tenants that
  require admin approval.
- **Google Calendar:** how guests are notified on change and delete.
- **Desktop app:** whether its own content policy lets a mail's remote images
  load after "Show images".
- **Accounts:** Google userinfo and Graph `/me` giving the address of an added
  account; `prompt=select_account` letting a person pick another account.
- **Local index:** Gmail `history.list` and Graph per-folder `delta` with a
  `receivedDateTime` filter (if Graph refuses the filter, Outlook lists stay
  live).
- **Sending:** Gmail's upload endpoint for mail over 4 MB; Graph draft,
  attachment, upload-session and send calls; Graph `/move` returning the new
  id that snooze relies on.
- **Calendar extras:** Graph IANA time zone names in recurrences, `getSchedule`,
  series PATCH; Google `freeBusy` errors and series PATCH anchoring.

## Phase 0: fixes (built)

- **Mail bodies.** `gmailToMessage` (`src/core/email/normalize.ts`) finds the
  text and HTML parts at any depth and skips attached files. An HTML-only mail
  is rendered as HTML instead of shown as source.
- **Threaded send.** `POST /api/email/send` takes `replyTo`, the id of the
  message being answered. Gmail gets the thread id with `In-Reply-To` and
  `References`; Outlook uses the message's reply endpoint, which keeps the
  original subject. The message is recorded as replied for the inbox watch.
- **Remote images.** The sanitizer's `blockRemoteImages` option parks an
  image's URL in `data-remote-src`. The read pane says images are held back and
  offers **Show images**. Applies to Gmail, Outlook and stored IMAP mail.
- **Auto-archive** is off until the owner turns it on.
- **Triage survives a reload.** Each run stores the answer shown for a mail
  (`email_triage_labels.triage`, migration `0194_email_triage_result`), with
  the reason and whether the decision model or the LLM gave it.
  `/api/email/inbox` returns it with the list; the owner's own label wins.
- **Calendar.** The page shows the reader's week (its first day follows the
  browser's locale, Monday where that is unknown). A timed event shows
  "09:00 – 10:00", and names the end date only when it runs into another day.
  A new event defaults to today when this week is on screen.

Tests: `src/core/email/normalize.test.ts`, `send-threaded.test.ts`, and the
OAuth inbox test in `tests/web/mail-calendar.spec.ts`.

## Open decisions

All three were taken by building the recommended option: the header index is
built (headers only, with an off switch), the grid is our own, and the phases
ran in the recommended order.

1. **A local index for Google and Microsoft mail.** The rest of phase 6 is much
   better with headers kept locally and synced through the Gmail history and
   Graph delta APIs: instant load, real unread counts, search across accounts.
   The cost is that sender and subject are stored on the server; IMAP mail is
   already stored in full. Recommended: yes, headers only.
2. **Calendar grid: build or adopt a library.** Recommended: build the week
   and day grid on the existing design tokens. A library would fight the
   styling; building costs roughly a week more.
3. **Order.** Recommended: phases 1 and 2 next, since they answer the review
   most directly, then the calendar (3, 4), then the email client (5, 6).
