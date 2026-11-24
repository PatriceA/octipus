# API Reference

This guide describes common routes. The [generated HTTP catalog](architecture/generated/CATALOG.md#http-surface) is the generated mounted-route inventory and links each route to its implementation. Most routes use `/api`; hosted artifacts, the gateway, and `/v1` have separate paths. Authentication can use a session cookie or Bearer token. Public health/authentication routes and signed webhook/SSO flows have their own requirements.

## Getting an API token

For scripts, use an `Authorization: Bearer <token>` header. The browser normally uses an HttpOnly session cookie. Throughout these docs the placeholder is `$OCTIPUS_API_TOKEN`. There are two ways to get a token:

- **Login JWT** — `POST /api/auth/login-mobile` returns a session token in the body for native/script clients. `POST /api/auth/login` sets the browser cookie and does not return the token in JSON. Sessions expire.
- **Personal Access Token** — create a long-lived token under **Settings → API Tokens** in the web UI (or `POST /api/auth/api-tokens`). Best for scripts, cron, and webhooks. Manage them via the [API Tokens](#api-tokens) endpoints; revoke with `DELETE /api/auth/api-tokens/:id`.

Admin-only endpoints (anything marked *admin*, plus system-scoped vault writes) require a token belonging to an admin user. Export it once:

```bash
export OCTIPUS_API_TOKEN="<your-token>"
curl -H "Authorization: Bearer $OCTIPUS_API_TOKEN" http://localhost:3005/api/auth/me
```

## Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | No | Basic health check |
| GET | `/api/health/detailed` | No | Service status with latencies |
| GET | `/api/health/ready` | No | Readiness probe |
| GET | `/api/health/live` | No | Liveness probe |
| GET | `/api/health/storage` | No | Storage provider (cache/queue/pub-sub) health |

## Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Register new user (audited as `user_created`); `security.registration` applies, `inviteToken?` is redeemed with the account (SPACES.md → Registration modes) |
| GET | `/api/auth/registration` | No | `{mode, firstAccount}`: the registration mode |
| POST | `/api/auth/login` | No | Login with credentials; a TOTP account without `totpCode` gets `401 { requiresTOTP: true }` (audited as `login` / `login_failed`) |
| POST | `/api/auth/login-mobile` | No | Login returning bearer token in response body (for native clients) |
| POST | `/api/auth/logout` | Yes | Logout and invalidate session |
| GET | `/api/auth/me` | Yes | Get current user info |
| GET | `/api/auth/ws-ticket` | Yes | Get a short-lived (60 s) token to sign a socket in: the gateway `auth` frame, or the `/voice` URL |
| POST | `/api/auth/passkey/register/options` | Yes | Generate WebAuthn registration options |
| POST | `/api/auth/passkey/register/verify` | Yes | Verify WebAuthn registration response |
| POST | `/api/auth/passkey/auth/options` | No | Generate WebAuthn authentication options |
| POST | `/api/auth/passkey/auth/verify` | No | Verify WebAuthn authentication response |
| POST | `/api/auth/totp/setup` | Yes | Setup TOTP 2FA |
| POST | `/api/auth/totp/enable` | Yes | Enable TOTP after verification |
| POST | `/api/auth/totp/disable` | Yes | Disable TOTP 2FA |
| POST | `/api/auth/link` | Yes | Redeem channel link code |

Login, login-mobile and register take an optional `returnTo`: a same-origin
path (one leading `/`, no `//`, no backslash, no whitespace or control
characters). Anything else is refused with 400; a valid one is echoed back as
`returnTo` in the response (`/` when none was sent).

## Idempotency keys

`POST /api/chat`, `POST /api/agents`, `POST /api/sessions`,
`POST /api/pipelines`, `POST /api/hooks` and
`POST /api/tools/:toolId/tools/:toolName/execute` accept an
`Idempotency-Key` header (or `X-Idempotency-Key`, at most 255 characters).
Keys are per user and per endpoint. Without the header nothing changes.

- First request: runs. A success (status below 400, no `error` field, and for
  tool execution no `result.error` / `result.success: false`) is kept for 24 h;
  a failure frees the key so a retry runs again.
- Retry after it finished: the stored status and body, with
  `Idempotent-Replayed: true` (a chat answer over 16k characters is replayed
  cut, naming the session that holds it). A chat retry does not add the message again or
  start a second turn.
- Retry while it still runs: waits for it up to ~20 s, then answers
  `409 { code: "idempotency_in_progress", status: "in_progress", sessionId? }`
  with `Retry-After: 5`. Retry with the same key later for the result.
- Same key, different request body: `422 { code: "idempotency_key_reused" }`
  (for sessions, `channelId` is ignored when comparing).

The claim lives in the shared kv store (the same mechanism as webhook delivery
ids, in-process only while the store is down) and is renewed while the work
runs; a crashed run frees its key after 15 minutes.

## Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents |
| POST | `/api/agents` | Spawn new agent |
| GET | `/api/agents/:id` | Get agent details |
| DELETE | `/api/agents/:id` | Stop and remove agent |
| POST | `/api/agents/:id/message` | Send message to agent |
| GET | `/api/agents/:id/events` | Get agent events (cursor-based: `?after=<seq>`) |

## Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List sessions |
| GET | `/api/sessions/:id` | Get session details |
| GET | `/api/sessions/:id/messages` | Get session messages |

## Verification

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/verification/:sessionId` | Get verification evidence and status for a session |

## Models

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List all models |
| POST | `/api/models` | Register new model |
| GET | `/api/models/:name` | Get model details |
| PATCH | `/api/models/:name` | Update model config |
| DELETE | `/api/models/:name` | Delete model |
| POST | `/api/models/:name/default` | Set as default model |
| GET | `/api/topics` | Get topic bindings and configuration |
| GET | `/api/models/health` | Check provider health |
| GET | `/api/models/cli/status` | CLI tool availability |
| GET | `/api/models/cli/quota` | CLI quota status |
| GET | `/api/models/providers/ollama/models` | List available Ollama models |
| GET | `/api/models/providers/litellm/models` | List LiteLLM models |
| GET | `/api/models/providers/:provider/known` | Known models for a provider |

### Own models (`/api/me/models`)

A user's own model rows, run with their own key ([SPACES.md → Own
models](SPACES.md#own-models)). Owner-only, admins included; another user's
model answers 404. Bodies are validated against an allowlist (400 otherwise).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/me/models` | My models, with the allowed `providers` and the `topics` I may bind |
| POST | `/api/me/models` | Add a model (201) |
| PATCH | `/api/me/models/:slug` | Update one of my models |
| DELETE | `/api/me/models/:slug` | Delete one of my models |

## Roles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/roles` | List all roles: tools, lane, description, prompt, critical rules, read-only flag |
| POST | `/api/roles` | Create a role (admin). Body: `{ role, systemPromptTemplate, toolIds, description?, coreToolIds?, criticalRules?, defaultTopic?, readOnly? }` |
| PATCH | `/api/roles/:role` | Update a role (admin). Every field optional; absent = unchanged |
| DELETE | `/api/roles/:role` | Delete a user-created role (admin). A role that ships with Octipus returns 400 |

A role's LANE is its `defaultTopic` resolved through `canonicalTopic` — the
model binding it runs on. Nothing selects a role out of a lane; a role is chosen
by an agent naming it in `spawn_child`, off its one-line `description`.



## Topics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/topics` | List all topics with current model bindings and config |
| PATCH | `/api/topics/:topic/config` | Update topic config (executorModel, temperature, maxTokens) (admin) |
| PUT | `/api/topics/:topic/binding` | Set topic's primary/backup model binding (admin) |
| POST | `/api/topics/assign-all` | Bind one model as primary for all text topics (admin) |

## Hooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/hooks` | List all hooks |
| POST | `/api/hooks` | Create hook |
| GET | `/api/hooks/:id` | Get hook details |
| PATCH | `/api/hooks/:id` | Update hook |
| DELETE | `/api/hooks/:id` | Delete hook |
| POST | `/api/hooks/:id/toggle` | Toggle hook enabled state |

## Vault

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/vault` | List credentials |
| POST | `/api/vault` | Store credential |
| PATCH | `/api/vault/:id` | Update credential |
| DELETE | `/api/vault/:id` | Delete credential |
| POST | `/api/vault/:id/rotate` | Rotate credential |

## Pipelines

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/pipelines` | Create and start a pipeline from a template. Returns `202` with `{ pipelineId, sessionId }` as soon as the run has an id — the run itself continues in the background. |
| GET | `/api/pipelines` | List user's pipeline runs |
| GET | `/api/pipelines/:id` | Get pipeline detail with nodes |
| POST | `/api/pipelines/:id/stop` | Stop a running pipeline |
| GET | `/api/pipelines/:id/plan` | List the plan a `foreach` node iterates |
| POST | `/api/pipelines/:id/plan` | Append plan items (editable while running) |
| PATCH | `/api/pipelines/:id/plan/:itemId` | Edit or reorder a plan item |
| DELETE | `/api/pipelines/:id/plan/:itemId` | Drop a still-pending plan item |
| POST | `/api/pipelines/:id/pause` | Pause at the next node boundary |
| POST | `/api/pipelines/:id/resume` | Resume from the newest checkpoint, or from `fromSeq` (rewind) |
| GET | `/api/pipelines/:id/checkpoints` | List checkpoints (node-boundary snapshots) |
| PATCH | `/api/pipelines/:id/checkpoints/:seq` | Edit what the next node will read |
| GET | `/api/pipelines/templates` | List pipeline templates |
| POST | `/api/pipelines/templates` | Create pipeline template |
| PUT | `/api/pipelines/templates/:id` | Update pipeline template |
| DELETE | `/api/pipelines/templates/:id` | Delete pipeline template |

## Runs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/runs/:sessionId/events` | The run log — one ordered stream of node, plan and tool events |
| GET | `/api/runs/:sessionId/trace` | The same log folded into spans, with per-span duration and cost |

## Skills

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills` | List domain knowledge skills |
| GET | `/api/skills/:id` | Get skill details |
| POST | `/api/skills` | Create custom skill |
| PATCH | `/api/skills/:id` | Update skill |
| DELETE | `/api/skills/:id` | Delete custom skill |
| GET | `/api/skills/exchange/export?ids=a,b` | Export skills as one versioned JSON bundle with a content hash (unsigned: sign it offline with `octi plugin sign-skill-bundle`). See [Exchanging skills](SKILL-EXCHANGE.md#api). |
| POST | `/api/skills/exchange/preview` | Read a bundle or the JSON of `GET /api/skills/export` (`{ bundle }`), a SKILL.md or that export's markdown (`{ skillMd }`) or, for admins, an https bundle (`{ url }`): its skills in full, signature, trust verdict and name collisions. Writes nothing. |
| POST | `/api/skills/exchange/install` | Install a previewed source: `contentHash` from the preview and a decision (`skip`, `rename`, `replace`) for every collision; audited. `409` on an undecided collision or a changed source. |

## Persona

Per-user root agent persona — name, tone, narration volume, free-form self-facts — plus the per-arm voices that shadow it. Same controls as the `/persona` slash command (see [CHAT-COMMANDS.md](CHAT-COMMANDS.md#persona)) and the web `/persona` page. Writes delegate to `handlePersonaCommand` so validation matches across all three surfaces.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/persona` | Resolved persona for the current user (name, pronouns, tone, narration, presetId, signaturePhrases, userFacts) |
| GET | `/api/persona/presets` | List shipped persona presets (`personas/*.yaml`) — no auth |
| PATCH | `/api/persona` | Update one or more of `{ name, tone, narration, presetId }` |
| POST | `/api/persona/facts` | Append a free-form self-fact (`{ fact }`, 4–280 chars) |
| DELETE | `/api/persona/facts/:idx` | Remove the N-th free-form fact (0-indexed across `extra:*`) |
| POST | `/api/persona/reset` | Restore Octipus default — drops custom name and facts |
| GET | `/api/persona/arms` | Per-arm persona bindings (`{ arms: { review: "terse-engineer" } }`); `{}` when no arm has its own voice |
| PUT | `/api/persona/arms/:role` | Shadow one arm's voice with `{ presetId }`. 400 with the reason for an unknown role/preset; for the root identity use `PATCH /api/persona` |
| DELETE | `/api/persona/arms/:role` | Clear it — that arm runs with no persona, as before |

## Tools

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tools` | List registered tools |
| GET | `/api/tools/:id` | Get tool details |
| GET | `/api/tools/all` | All built-in and expanded MCP tool definitions |
| GET | `/api/tools/permissions` | User permission overrides |
| PUT | `/api/tools/permissions` | Set an override, optionally scoped with expiry |
| DELETE | `/api/tools/permissions/:toolId/:action` | Reset permission |
| POST | `/api/tools/:toolId/tools/:toolName/execute` | Execute a tool function |

An override body contains `toolId`, `action`, `level` (`ALLOW`, `ASK`, `DENY`),
optional `reason`, and optional `scope`. A scope requires a future `expiresAt`
and at least one of `sessionId`, `workspaceId`, `pathPattern`, `commandPattern`.
Scope conditions are combined; unavailable/mismatched scope evidence blocks.
A scoped ALLOW cannot overwrite an existing DENY (`409`); review that denial
first. Removing an override restores the manifest default, which may be ALLOW;
set ASK explicitly when the intent is to require approval.

Direct execution accepts `{ "args": { ... } }` and runs unattended. ASK returns
HTTP `409` with `code: "approval_required"`; other execution failures return
`400` with `code: "tool_execution_failed"`. An attended agent's descendants can
use the session's approval surface. MCP permissions use tool ID `mcp`, action
`<serverId>.<remoteToolName>`. Argument patterns constrain authorization, not
filesystem or shell isolation.

## Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications` | List notifications (paginated) |
| POST | `/api/notifications/:id/read` | Mark notification as read |
| POST | `/api/notifications/read-all` | Mark all notifications read |

## Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send a chat message. Without a `channel` that can show an approval prompt, the turn is unattended: actions at ASK are refused, not asked. Interactive answers are replaced unless the body declares `renders: ["inline_ui"]` — a view by its text, an HTML block by a plain line; `toolsUsed: true` adds the tool names the turn called (the eval runner) |
| POST | `/api/chat/approve` | Respond to an approval request |

## Documents

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/documents/upload` | Upload one or more documents |
| GET | `/api/documents` | List documents (with optional filtering by category/status) |
| GET | `/api/documents/:id` | Get document details |
| GET | `/api/documents/:id/raw` | Stream original file (with `?download=1` for attachment mode) |
| DELETE | `/api/documents/:id` | Delete document |
| POST | `/api/documents/:id/cancel` | Cancel document processing |

## Research

The core research endpoints (`/api/research`) are removed: deep research is
the example plugin `plugins/research`, which a page and agents call as plugin
tools, and which runs through the plugin host API scopes `agent:run` and
`documents:write` ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#host-api)).

## Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List user's tasks (`?status=`, `?due=today`, `?category=`, `?assigneeKind=`/`?assigneeRef=`, `?view=next` for next-action order with a `bucket` and `reason` each). Without `status`: every active task, then a page of done ones (see below) |
| GET | `/api/tasks/:id` | Get one task |
| POST | `/api/tasks` | Create a task (`parentId`, `blockedBy[]`, `estimate` optional; the to-do fields below; `quick` instead of `title` for a capture line) |
| PATCH | `/api/tasks/:id` | Update task; status is `open` / `in_progress` / `done` / `archived`; `parentId: null` and `blockedBy: []` clear the links; the to-do fields below |
| GET | `/api/tasks/my-day` | Today's My Day (`?tz=`): `{timezone, date, tasks, suggestions}` (see below) |
| POST | `/api/tasks/parse` | Preview a capture line without creating anything: `{text, tz?}` → the parse (see below) |
| DELETE | `/api/tasks/:id` | Delete task (its sub-tasks become top-level) |
| POST | `/api/tasks/:id/notes` | Link a note to the to-do: `{noteId}` (an existing note) or `{title}` (a new note made for it, that title as its first line) → `{note}` (a `linkedNotes` entry). Idempotent. See [Note ↔ to-do links](#note--to-do-links) |
| DELETE | `/api/tasks/:id/notes/:noteId` | Unlink a note from the to-do (the note and its line stay) → `{unlinked: true}`; `404` when there is no such link in reach |
| GET | `/api/tasks/role-agents` | The caller's role agents: task counts, on/off, `pipelineTemplate` (the template each task runs through, or null) |
| PUT | `/api/tasks/role-agents` | Turn a role agent on or off (`{role, enabled}`); with `enabled: true`, `pipelineTemplate` (an id or name) makes it run each task through that pipeline and `null` makes it work tasks itself. A template with a required parameter is refused |

**The unfiltered list.** `GET /api/tasks` with no `status` (and no `view`)
returns `{serverNow, tasks, done}`: `tasks` holds every active task (in
progress, then open; each by priority, due date, newest) followed by one page
of done tasks, most recently completed first. Finished tasks never push an
active one out of the list. `?doneLimit=` sets the page size (default 50,
0–500; `0` returns only the active tasks) and `?doneOffset=` where it starts.
`done` is `{total, offset, limit, hasMore}`: load more by asking again with
`doneOffset` advanced by `limit` while `hasMore` is true. Archived tasks are not
in this list; ask for them with `?status=archived`. `?status=X` returns one
page of that status (done and archived most recently finished first):
`?limit=` (default 200, at most 500) and `?offset=`, with
`page: {total, offset, limit, hasMore}` instead of `done`. That is how an
archived or completed view pages. Other filters (`due`, `category`, assignee) apply to both
parts. Clients that call it without parameters (the mobile app) keep working:
`tasks` is the same array shape as before.

To show a to-do list, use the unfiltered call, not one call per status:
`GET /api/tasks` gives **all** active to-dos (never cut at a page, unlike
`?status=open`) plus the 50 most recently done, and `?doneLimit=0` gives only
the active ones. For a "Completed" view, page the done ones with
`?doneLimit=50&doneOffset=50` and so on (each response repeats the active
tasks; take the ones with `status: "done"`), or ask for a larger first page
(`doneLimit` up to 500). `done.total` is the count for a "Completed (n)"
label.

A parent or blocker the caller cannot see, a self-link, or a parent loop is a
`400`. Only an active (open or in-progress) blocker blocks; a done one is
inert and stays in the array.

### To-do fields (star, order, My Day, repeat, due time, steps)

Every task row carries these (all present on every row; older clients may
ignore them). `important`, `myDayOn` and `sortOrder` are **the caller's own**
(per user, also in a space: each member has their own star, My Day and
order); the other fields belong to the task.

| Field | Type | Meaning |
|---|---|---|
| `important` | boolean | The caller's star (the Important list). Default `false` |
| `sortOrder` | number | The caller's manual order within a list, **ascending**; until they reorder, the task's default (minus its creation time in ms, so the newest is first). To move a task between two neighbours, PATCH the midpoint of their `sortOrder`s; to the top, the first one's minus 1. Any finite number |
| `myDayOn` | `YYYY-MM-DD` \| null | The day (in the caller's zone) they put it in My Day. It **is** in My Day only while that equals today's date there, so My Day empties itself at midnight; no write happens |
| `repeat` | object \| null | `{unit: "day"\|"week"\|"month"\|"year", interval: 1..365, weekdays?: [0..6], tz, anchorDay?}` (0 = Sunday, `weekdays` only with `"week"`). The server stamps `tz` (the IANA zone the series runs in) and, for month and year rules, `anchorDay` (the day of the month the series keeps: the 31st comes back on the 31st whenever a month has one). Read-only for clients: send a rule without them (or echoed back unchanged) |
| `repeatNextId` | uuid \| null | On a finished (done, or skipped = archived) repeating task: the occurrence that made |
| `dueAt` | ISO \| null | As before. **Due time:** a due *day* is stored as the last millisecond of that day in the user's zone (seconds `59`, ms `999`); any other value is a due *time*. Send a bare `YYYY-MM-DD` for a day, a full ISO instant for a time |
| `remindAt` | ISO \| null | As before: when the reminder fires (notification); a changed value re-arms it |
| `parentId` | uuid \| null | As before. A to-do's **steps** are its children (`parentId` = the to-do); create one with `POST /api/tasks {title, parentId}` and tick it with `PATCH {status: "done"}` |

Writing them (`POST` and `PATCH /api/tasks`, JSON):

- `important: boolean`, `sortOrder: number`, `myDay: true|false` (`null` on
  PATCH = false) set the **caller's own** layer. Any reader of the task may
  send them, a space viewer too; a PATCH with only these fields needs no
  write access and changes nothing anyone else sees. Clients send `myDay`,
  never `myDayOn`.
- `repeat`: a preset name (`"daily"`, `"weekdays"`, `"weekly"`, `"monthly"`,
  `"yearly"`), a rule object, or `null` to stop repeating. A bad rule is a
  `400` naming the problem. Writing `repeat` or `dueAt` re-stamps the anchor.
- `tz`: the client's zone, for `myDay` and a bare `dueAt` day in this request.

**Time zones.** "Today" in one request (My Day, a bare due day, capture) uses
the request's `tz` as given. Anything long-lived uses the user's stored zone
(`preferences.timezone`): a repeat series' `tz`, agent work, `/todo`,
reminders. Every `tz` a client sends on these routes is offered to the stored
zone by these rules (also `PUT /api/auth/timezone {timezone, source: "device"}`):

- never over a zone the user chose in Settings (`source: "user"`);
- **a fixed-offset zone (`Etc/GMT-1`, `Etc/UTC`, `UTC`, `GMT`) never replaces a
  named zone** (`Europe/Berlin` stays when a phone reports `Etc/GMT-1`); a
  named zone does replace a fixed one;
- otherwise a different zone replaces the stored one.

A series is stamped with the stored named zone first, then a named request
zone, and only then a fixed offset (which ignores DST). `PUT /api/auth/timezone`
with `source: "user"` fixes the zone (devices stop changing it); `"follow"` sets
it and lets devices update it again. The answer is `{timezone, timezoneSource}`.
The mobile app, which can only send an offset, should send `tz` as it does and
read the stored zone from `GET /api/auth/me` `preferences.timezone`.

**Repeating to-dos.** When an occurrence of a series leaves the active set —
completed (`PATCH {status: "done"}`, an agent's `complete_task`/`update_task`)
or **skipped** (archived, or deleted: deleting an occurrence does not end the
series; to end it, set `repeat: null`) — the next occurrence is created
**exactly once**: a new open task with the same title, notes, list, priority,
assignee and rule, its steps copied open (deleted steps are not), each user's
star and order copied (not My Day), due one step on in the series' zone at the
same local time (repeated until it is today or later), `remindAt` moved by the
same amount. The finished row's `repeatNextId` names it. Completing again, or
two completions at once, never makes a second one; if the server fails to make
it at once, a sweep makes it within minutes. Setting the finished task back to
`open` (an Undo) deletes the next occurrence only while it is provably
untouched — still open, unclaimed, never edited, no comment, no step added or
ticked, nobody's star or order changed, and made less than 10 minutes ago —
and then clears `repeatNextId`; otherwise it stays.

**Agents and future occurrences.** An occurrence is not work before the start
of its due day in the series' zone: `POST /api/tasks/:id/checkout` answers
`409 {reason: "not_due", dueAt}`, the role heartbeat skips it and the tasks
tool's next view leaves it out. The user can still edit or complete it.

**Lists.** A list is the `category` of its to-dos, plus lists made empty.
`GET /api/tasks/lists` → `{lists: [{name, open}]}` (`open`: open top-level
to-dos). `POST /api/tasks/lists {name}` makes an empty list (`409` if one of
that name exists in any case). `PATCH /api/tasks/lists {name, newName}` renames
it (every to-do in it moves; onto an existing name the lists merge) →
`{name, taskIds}`. `DELETE /api/tasks/lists?name=…` deletes it; its to-dos stay,
in no list → `{taskIds}`. `POST /api/tasks/lists/move {taskIds, name|null}`
puts to-dos in a list (the Undo of a delete). In a space these are the space's
lists, written by editors.

**Capture.** `POST /api/tasks` with `quick: "call dentist tomorrow 3pm !high
#personal"` (and `tz`) parses the line on the server and creates "call
dentist", due tomorrow 15:00 in `tz`, priority 3, list `personal`; any field
sent explicitly wins (`title` too). `POST /api/tasks/parse {text, tz?}` returns
the same parse without creating anything — `{title, due: {date, time} | null,
dueAt, priority, important, category, repeat, tokens: [{kind, text, start, end,
label}], timezone}` (`kind`: `due` `time` `repeat` `priority` `important`
`list`; `start`/`end` index the text) — for showing chips. The web, these two
routes and `/todo` share one parser (`src/core/tasks/quick-add.ts`).

**Capture grammar** (English; conservative, so ordinary words stay words):

- **Marks**, read anywhere as whole words: `#list` (a letter first; matched to
  an existing list ignoring case and `-`/`_`), `!high` `!medium` `!low` `!1`–`!3`,
  `!!` (medium), `!!!` (high), `*` or `!important` (star). A lone `!` is text.
- **Dates**: today, tonight (20:00 unless a time is given), tomorrow (tmrw),
  day after tomorrow, a weekday name (the next one; today excluded), on/by/due
  + weekday (also short: fri), next + weekday (that day of next week), next
  week (Monday), (this) weekend, next month (the 1st), in 3 days / 2 weeks /
  a month, 2026-12-01, dec 5, 5th december (a past day this year means next
  year).
- **Times**: 3pm, 3:30 pm, 15:00, optionally after "at"; at noon, at midday,
  in the morning (09:00) / afternoon (14:00) / evening (18:00). A bare number
  ("at 7", "3 options") is never a time. A time alone is today while it is
  still ahead, else tomorrow.
- **Repeats** only with "every": every day / weekday / week / month / year,
  every 2 weeks, every other day, every mon and wed (first due on the next of
  those days still ahead, counting today until its time has passed). "Daily",
  "weekly" and the like are words.
- Dates, times and repeats are read only as a **clause at the end or the start
  of the line** (only spaces, commas, semicolons, colons or dashes between its
  parts and the edge): "Buy Sunday paper" and "Plan next week with Anna" stay
  titles. Nothing is read inside a URL, an e-mail address, a domain or a word
  ("Monday.com", "Today's").
- **Literal text**: "double quotes" or a backslash before a word keep it as
  text; the quotes or backslash leave the title. Clients take a chip back by
  quoting its text. A line that would leave no title is taken literally.

**My Day.** `GET /api/tasks/my-day?tz=Europe/Berlin` →
`{timezone, date, tasks, suggestions}`: `tasks` are those picked today, active
and done; `suggestions` are active top-level tasks not picked today, each a
task row plus `bucket` and `reason` — first those left in My Day on an earlier
day (`bucket: "earlier"`, reason "in My Day yesterday"), then the next-action
ranking's pressing ones (`doing`, `overdue`, `today`, `high`, `inbound`,
`upcoming`), at most 12.

### Note ↔ to-do links

A to-do can be linked to notes: notes **attached** to it, or the note **line**
it was made from. Every task row (`GET /api/tasks` in every form, `GET
/api/tasks/:id`, `GET /api/tasks/my-day`'s `tasks`, and the answers of `POST`
and `PATCH`) carries

| Field | Type | Meaning |
|---|---|---|
| `linkedNotes` | array | The notes it is linked to **that the caller can open**, oldest link first: `{id, title, slug, noteKind, noteDate, archived, anchor}`. `anchor` is set when the to-do was made from a line of that note (see below), null for an attached note. An archived note is listed with `archived: true`; a deleted one is gone. Empty when none |

and `GET /api/notes/:id` carries `linkedTasks`: the to-dos linked to the note
that the caller can open, `{id, title, status, dueAt, completedAt, repeating,
anchor}`.

**Making links.** `POST /api/tasks` takes `noteId` (link the new to-do to that
note) and, with it, `noteAnchor` (it was made from the line of that note that
carries this anchor). `POST /api/tasks/:id/notes {noteId | title}` attaches a
note to an existing to-do (`title`: a new note made for it). `POST
/api/notes/:id/todos {lines?}` makes to-dos of a note's task lines on the
server: every unticked `- [ ]` line that is not a to-do yet, or the 0-based
`lines` given (a ticked one then becomes a done to-do); each line gets its
marker and its link → `{tasks, marked}` (`marked: false` with a `reason` when
the note could not take the markers: the to-dos are then attached instead).

**Line markers.** A task line made a to-do ends in ` ^todo-<anchor>` (the
anchor: 6–16 lowercase letters and digits, random):

    - [ ] Call the dentist ^todo-k3x9qa2b

The marker names the link, never the to-do, so a note says nothing about a
to-do to a reader who cannot open it. A client that makes a to-do from a line
picks a new anchor, creates the to-do with `noteId` and `noteAnchor`, then
writes the marker into the line as an ordinary edit of the note (the web does
this; `409 {code: "anchor_taken"}` when that line is already another to-do).
Clients draw the marker as a chip and leave it out of titles and previews;
the pure helpers are in `src/shared/note-todos.ts`.

**Ticks follow each other**, change for change, never state for state:

- A to-do moved between done and not done (by anyone: the web, the mobile app,
  an agent) ticks or unticks its line on the server: a personal note is written
  only over the text the server read (read again on a race), a space note is
  merged into its live text. A client editing that note sees the new text on
  its next read; a save made from the older text is refused as `stale` (the web
  merges it with the change and saves again when the two do not touch the same
  text). The tick is the to-do's state, not anyone's text: it is written
  directly also when an agent completed the to-do in a space that takes the
  agent's note changes as proposals.
- A note save that ticks or unticks a marked line completes or reopens its
  to-do. Only a line whose tick **changed** in that save counts: a marker that
  only appears (a line just made a to-do) or only disappears (a line deleted)
  changes nothing, and an unrelated edit of a note whose line is out of step
  does not flip the to-do. A live space note's typed ticks reach their to-dos
  when the note is next saved (on last leave, and every few minutes); the web
  completes the to-do at once when a linked box is clicked there.
- A **deleted** (archived) to-do is never brought back by a tick, and deleting
  one leaves its line as it is.
- **Repeating** to-dos: the line stays with the occurrence it was made from
  (ticked when that is done); the next occurrence has the note attached, not
  the line.
- **Deleting the line** leaves the to-do and its link (an undo brings the
  line's link back); **editing** the line keeps the link (the to-do keeps its
  own title). A marker copied into another note means nothing there.
- A **stale or offline** client: a save refused as stale writes nothing (the
  to-do's change stands); the web merges it and saves again, and a real clash
  asks the user. A tick that cannot reach its line (the note gone, out of
  reach) is logged and the to-do's change stands.

**Who sees what.** Both ends of a link are always in one scope: a user's
personal to-dos and notes, or one space's (a personal note can never be linked
to a space to-do, nor a space note to a personal one). A link is made only by
someone who can write the to-do and reach the note there, and is shown only
through the reader's own access on each side: a space guest sees the linked
notes of their folders only and, from a note, the to-dos of their rooms only.
A remote member of a federated space reads the host's task rows without links.

**Live updates.** Every write to one of your personal tasks (yours, an agent's,
a repeat's), and every change to your own star / My Day / order (in a space
too), sends the gateway event `tasks.changed` with payload `{taskId}` to your
connections (subscribe to the pattern `tasks.changed`); refetch on it
(debounced) instead of polling. Space tasks send `task.changed` to the space's
subscribers as before.

## Recurring Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/recurring-tasks` | List recurring tasks |
| POST | `/api/recurring-tasks` | Create recurring task |
| PATCH | `/api/recurring-tasks/:id` | Update recurring task |
| DELETE | `/api/recurring-tasks/:id` | Delete recurring task |

## Email

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/email/send` | Send (gated). `to`/`cc`/`bcc` comma-separated, ≤ 50 recipients; `replyTo` threads it; `provider`/`account` pick the mailbox; `format: plain\|rich`; `originalAt` (where the quoted or forwarded original starts: only what is above it is formatted); `attachments: [{upload}\|{forward:{messageId, attachmentId}}]`, ≤ 20 files / 25 MB |
| POST | `/api/email/uploads` | Hold one file (`file`, multipart) for a mail being written; ≤ 25 MB; held 1 h, for its uploader only |
| DELETE | `/api/email/uploads/:id` | Let go of a held file |
| POST | `/api/email/snooze` | `{ids, wakeAt, provider?, threadId?, from, subject, snippet}`: archive now, back in the inbox unread at `wakeAt` |
| GET | `/api/email/snoozed` | Snoozed conversations, soonest first; `error`/`retryAt` when a wake failed |
| POST | `/api/email/snoozed/:id/unsnooze` | Bring it back now |
| POST | `/api/email/snoozed/:id/dismiss` | Let a snooze go: nothing is moved, the mail stays in the archive |
| GET/PUT | `/api/email/index` | The local header index: on/off (`{enabled}`; off deletes it) and per-mailbox status |
| POST | `/api/email/imap/message/:id/summarize` · `/reply-options` · `/draft` · `/task` | AI help for IMAP mail; 403 at protection level 3–4 unless the models are local |
| PUT | `/api/email/imap/triage/label/:id` | The caller's own label on an IMAP mail they can read |
| GET | `/api/mail/client/messages` | IMAP/POP3 list in the Email page's shape (`account`, `folder`, `q`, `unread`, `pageToken`, `limit`) |
| GET | `/api/mail/client/messages/:id` | One IMAP/POP3 message in the Email page's shape |
| POST | `/api/mail/client/messages/batch` | `{ids ≤ 100, action: read \| unread}` |
| GET | `/api/email/accounts` | Connected Google / Microsoft 365 mailboxes |
| GET | `/api/email/messages` | One folder page (`folder`, `q`, `unread`, `pageToken`, `limit` ≤ 50, `provider`, `refresh`) with stored triage and the inbox unread count |
| GET | `/api/email/thread/:threadId` | A conversation, oldest first, with cc and attachments |
| GET | `/api/email/message/:id/attachment/:attachmentId` | One attachment, always as a download (max 25 MB) |
| POST | `/api/email/messages/batch` | `{ids ≤ 100, action}`: archive, unarchive, trash, untrash, read, unread, star, unstar. Nothing is deleted for good |
| GET/PUT | `/api/email/triage/settings` | How "Triage inbox" runs: `scope`, `applyLabels`, `autoArchive`, `archiveCategories`, `instructions`, `skipDialog`, `auto` (automatic triage); GET adds `lastAuto` |
| POST | `/api/email/triage/preview` | `{items: [{id, unread}]}`: what a run would do and what the models are told. Asks no model |
| POST | `/api/email/triage/run` | Rows may carry `mailbox` (`google`, `google:<address>`, `imap:<id>`); `mailboxes` with `newest` runs over several. Start a background run over `items` or the `newest` N (202; 409 while one runs) |
| GET | `/api/email/triage/run` | The current or last run: progress, then the result |
| POST | `/api/email/triage/run/cancel` | Stop the current run |
| PUT | `/api/email/triage/label/:id` | The owner's label `{priority, category, item?}`; with `item` any mail can be labelled |
| GET | `/api/calendar/calendars` | The caller's calendars (own and shared), visibility preferences, `microsoftSharedAccess`; `?fresh=true` re-reads the providers |
| PUT | `/api/calendar/preferences` | `{ visible?: ["google:<id>"], hideDeclined? }`; only the given fields change |
| GET | `/api/calendar/events` | `from`, `to` (≤ 93 days): events of the visible calendars; `partial`, `failedCalendars`, `truncated` |
| POST | `/api/calendar/events` | Create (`provider`, `account?`, `calendarId?`, `reminderMinutes?`, `recurrence?`, `timeZone?`, `title`, `start`, `end`, `allDay`, `location?`, `description?`, `attendees?`, `confirm: true`) |
| PATCH | `/api/calendar/events/:id` | Change; fields left out are unchanged; `attendees` is the complete new guest list; `scope: "all"` changes the whole series; `account?`; 409 with `attendees` unless `notifyAttendees: true` when the event has guests |
| DELETE | `/api/calendar/events/:id` | Body `{ provider, account?, calendarId?, confirm: true, notifyAttendees?, scope? }` |
| GET | `/api/calendar/events/:id/details` | `provider`, `account?`, `calendarId?`: whole description, guests with answers, reminder, the series' recurrence |
| POST | `/api/calendar/freebusy` | `{provider, account?, attendees ≤ 20, from, to ≤ 8 days}`: busy and failed per guest, and the caller's own busy time |
| POST | `/api/calendar/events/:id/respond` | `{ provider, account?, calendarId?, response: accepted \| tentative \| declined }` |
| POST | `/api/email/triage` | Run email triage (`items`, `autoArchive`, `applyLabels` → Gmail label / Outlook category `Octipus/<category>`) |
| GET | `/api/email/categories` | The user's triage categories and the presets |
| PUT | `/api/email/categories` | Save the user's categories (`{categories: {name: description}}`, `null` resets) |
| POST | `/api/email/message/:id/save-draft` | Save a reply (`{body}`) as a draft in the mailbox, threaded under the message; nothing is sent |

## Onboarding

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/onboarding` | What is already set up, for the setup guide (models, CLI tools, areas, mailbox, chats, heartbeat, permissions, role agents, templates, saved progress). Install-wide details for admins only |
| PUT | `/api/onboarding/progress` | Save the guide's progress (`dismissed`, `useCases`, `answers` without secrets, `completed`) |
| PUT | `/api/onboarding/standing-instructions` | Write (or append to) the pinned user-level `heartbeat` note (`{body}`) |

## Heartbeat

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/heartbeat/me` | The caller's heartbeat: `enabled`, `intervalMinutes` (null = the server's), `watchEmail`, `watchEmailSince`, the server settings, the connected mailbox, whether standing instructions exist, and the last 10 outcomes of the inbox watch |
| PUT | `/api/heartbeat/me` | Change them: `enabled`, `intervalMinutes` (5–1440, `null` resets), `watchEmail` |

## Capabilities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/capabilities` | List available capabilities and status |

## SAML & SSO

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/saml/:orgSlug/metadata` | Retrieve organization SAML metadata |
| POST | `/api/saml/:orgSlug/acs` | Organization SAML assertion consumer service |

## SCIM (System for Cross-domain Identity Management)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/scim/v2/Users` | List users |
| POST | `/api/scim/v2/Users` | Create user in the token's org (a member with that `userName` is returned as-is; one held outside the org is 409 `uniqueness`) |
| GET | `/api/scim/v2/Users/:id` | Get user |
| PATCH | `/api/scim/v2/Users/:id` | Apply supported SCIM user updates; `userName`/`emails` only on an account the org alone holds (no other org, not an install admin, no own password), else 403 |
| DELETE | `/api/scim/v2/Users/:id` | Remove the user from the token's org; deactivate when no other org holds them |
| GET | `/api/scim/v2/Groups` | List groups |

## Organizations & Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/orgs` | List organizations (admin) |
| POST | `/api/admin/orgs` | Create organization (admin) |
| GET | `/api/admin/users` | List all users (admin) |
| POST | `/api/admin/users` | Create user (admin) |
| PATCH | `/api/admin/users/:id` | Update user (admin) |
| GET | `/api/admin/quotas` | List usage quotas (admin) |
| GET | `/api/admin/quotas/:userId` | Get user quota details (admin) |
| PATCH | `/api/admin/quotas/:userId` | Update user quota overrides (admin) |
| DELETE | `/api/admin/quotas/:userId` | Clear user quota overrides (admin) |
| POST | `/api/admin/impersonate/:userId` | Start impersonation session (admin) |
| POST | `/api/admin/impersonate/stop` | Stop impersonation session |
| GET | `/api/admin/impersonate` | List recent impersonation sessions (admin) |
| GET | `/api/admin/audit` | Audit log (admin) |
| GET | `/api/admin/permission-requests` | Pending tool permission requests of every user (admin); a space's requests only for its members |
| POST | `/api/admin/permission-requests/:id/resolve` | Answer someone else's permission request: `{approved, reason}` (reason required, audited) |
| GET | `/api/admin/approvals` | Pending root-agent approvals of every user (admin); a space's only for its members |
| POST | `/api/admin/approvals/:id/resolve` | Answer someone else's approval: `{approved, reason, response?}` (reason required, audited) |
| GET | `/api/admin/group-channels` | Every group-channel enrolment (admin) |
| PATCH | `/api/admin/group-channels/:id` | Change an enrolment's mode, quiet hours or rate limit (admin, audited) |
| DELETE | `/api/admin/group-channels/:id` | Remove an enrolment (admin, audited) |

Requests and approvals are answered by their requester on every other path
(REST and the gateway); these two routes are the admin's only way to answer
for someone else.

### My workspaces and organizations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/me/workspaces` | My personal workspaces (the default one is created on first access); spaces are listed under `/api/spaces` |
| POST | `/api/me/workspaces` | Create one: `{slug, name, isDefault?}` (201) |
| PATCH | `/api/me/workspaces/:id` | Rename: `{name}` |
| POST | `/api/me/workspaces/:id/default` | Make it my default workspace |
| DELETE | `/api/me/workspaces/:id` | Delete one of my workspaces |
| POST | `/api/me/workspaces/:id/transfer` | Give it to another user: `{recipientUserId}` or `{recipientUsername}`; its content moves with it |
| GET | `/api/me/orgs` | My organization memberships |

## Spaces

Shared workspaces ([SPACES.md](SPACES.md)). A caller who is not a member gets
404 for every space id; a member whose role lacks the action gets 403
(`forbidden_role`); `last_owner`, `space_full`, `archived`,
`not_purgeable` and `funding_off` answer 409. Bodies reject unknown fields (422).

| Method | Endpoint | Who | Description |
|--------|----------|-----|-------------|
| GET | `/api/spaces` | any user | My spaces with my role |
| POST | `/api/spaces` | per `spaces.creation` | Create a space `{name}`; the caller becomes its owner |
| GET | `/api/spaces/:id` | member | Name, my role, member count, archived, `funding`, `sponsorUserId`, `sponsorModels` |
| PUT | `/api/spaces/:id/funding` | owner | `{mode?: "own" \| "unattended" \| "sponsored", sponsor?: "me" \| null, sponsorModels?}`; only the sponsor sets `sponsorModels` (their own model rows) |
| GET | `/api/spaces/:id/budget` | member | The space's budgets with this period's spend; the member cap with my own share |
| PUT | `/api/spaces/:id/budget` | owner | `{kind: "space" \| "space_member", period: "day" \| "month", limitUsd: number \| null, warnRatio?}`; `null` removes it |
| PATCH | `/api/spaces/:id` | owner | Rename `{name}` |
| POST | `/api/spaces/:id/archive` | owner | Make read-only and stop its agents |
| POST | `/api/spaces/:id/unarchive` | owner | Undo archive |
| DELETE | `/api/spaces/:id` | owner | Delete for good; only archived for `spaces.purgeAfterArchiveDays` |
| GET | `/api/spaces/:id/members` | member | `{userId, username, role, joinedAt}` |
| PATCH | `/api/spaces/:id/members/:userId` | owner | Change role `{role, scope?}`; `scope` = `{rooms, folders}` for guests (SPACES.md → Guests) |
| DELETE | `/api/spaces/:id/members/:userId` | owner, or self | Remove a member, or leave |
| GET | `/api/spaces/:id/invites` | owner | Invites (never the token) |
| POST | `/api/spaces/:id/invites` | owner | `{role, scope?, expiresInHours?, maxUses?}` → `{id, token, role, expiresAt, maxUses}`; the token is shown once |
| DELETE | `/api/spaces/:id/invites/:inviteId` | owner | Revoke an invite of this space |
| GET | `/api/spaces/:id/activity` | member | Audit rows of the space, newest first; `?limit=&before=` |
| PUT | `/api/spaces/:id/agent-edit-mode` | owner | `{mode: "suggest" \| "direct"}`: whether the agent's note writes become edit proposals |
| GET | `/api/spaces/:id/file-leases` | member | Live file leases ("Ben is editing"): `{path, holderUserId, holderName, holderKind, expiresAt}` |
| POST | `/api/spaces/:id/file-leases` | editor, owner | `{path, renew?}` take (or renew) the lease on a space file; 409 `lease_held` with `heldBy` when someone else has it (or a directory above it, or a file under it) |
| DELETE | `/api/spaces/:id/file-leases?path=` | member | Release your lease |
| GET | `/api/spaces/:id/github` | member | Whether the space has a GitHub token: `{connected, connectedBy, connectedAt}`; never the value |
| PUT | `/api/spaces/:id/github` | owner | `{token}`: store the space's GitHub token (replaces the previous one) |
| DELETE | `/api/spaces/:id/github` | owner | Remove it → `{removed}` |
| GET | `/api/spaces/:id/rooms` | member | Rooms I can enter, with `unreadCount` and `muted` |
| POST | `/api/spaces/:id/rooms` | editor, owner | `{title, visibility: "space" \| "private", memberIds?}` |
| GET | `/api/spaces/:id/rooms/:roomId/messages` | room access | `?before=&after=&limit=` (message ids); posts and replies with `authorUserId`, `authorName` |
| POST | `/api/spaces/:id/rooms/:roomId/messages` | commenter+ | `{content, addressed?, clientId?, inlineUi?: {action}}` (`action` answers a view of the room: `{blockId, name, componentId, context, data?}`, checked against it, 400 when it fails; the post is addressed): REST fallback of `room.post` → `{messageId, queuedPosition?, notQueued?}`; `/…` → `{commandResult}` |
| PATCH | `/api/spaces/:id/rooms/:roomId` | room creator, owner | `{title?, visibility?}` |
| GET | `/api/spaces/:id/rooms/:roomId/members` | room access | A private room's members, or the space's for an open one |
| GET | `/api/spaces/:id/rooms/:roomId/mode` | room access | `{mode, quietHoursStart, quietHoursEnd, timezone, maxUnpromptedPerDay, minMinutesBetween, feedback: {up, down}}` |
| PUT | `/api/spaces/:id/rooms/:roomId/mode` | room creator, owner | `{mode?: "mention" \| "listen" \| "proactive", quietHoursStart?, quietHoursEnd?, timezone?, maxUnpromptedPerDay?, minMinutesBetween?}` |
| PUT | `/api/spaces/:id/rooms/:roomId/messages/:messageId/feedback` | room access | `{value: 1 \| -1 \| null}` on the agent's unprompted post |
| POST/DELETE | `/api/spaces/:id/rooms/:roomId/members/:userId` | room creator, owner | Private rooms only; removal ends the member's subscriptions and turns there |
| PATCH | `/api/spaces/:id/rooms/:roomId/me` | room access | `{muted?, lastReadMessageId?}` |
| GET | `/api/spaces/:id/memory` | member | Space memory entries, newest first |
| POST | `/api/spaces/:id/memory` | editor, owner | `{body}` (≤ 500 characters) |
| DELETE | `/api/spaces/:id/memory/:entryId` | editor, owner | Retract an entry |
| GET | `/api/me/work` | signed in | My open tasks assigned to me, across my spaces and personal workspaces: `{groups: [{workspaceId, name, kind, tasks}]}` |
| GET | `/api/invites/:token` | public | Preview `{spaceName, inviterName, role, expiresAt}`; rate-limited per IP |
| POST | `/api/invites/:token/accept` | signed in | Join → `{workspaceId, role, alreadyMember}`; rate-limited per IP |

### Live space notes

In a space, `POST /api/notes` takes `baseSha256` (the sha of the body the
edit was made from — `GET /api/notes/:id` returns the live text and its sha
as `bodySha256` while the note is open in an editor). The edit is merged with
what others wrote since, or refused with 409 `{code: "stale",
currentSha256}`; a note over `spaces.noteMaxBytes` is a 413. A body write
to an existing space note without `baseSha256` is a 400 `{code:
"base_required"}`: read the note first. Omitting `body` on an existing space
note saves only its title, tags and kind. Line endings are stored as `\n`.

| Method | Endpoint | Who | Description |
|--------|----------|-----|-------------|
| GET | `/api/notes/:id/revisions` | member | Revisions, newest first: `{id, createdAt, origin, size, authors[], onBehalfOf}` |
| GET | `/api/notes/:id/revisions/:revisionId` | member | One revision with its body |
| POST | `/api/notes/:id/revisions/:revisionId/restore` | editor, owner | Write that revision's text as a new revision |
| POST | `/api/notes/:id/merge` | editor, owner | `{base, text}`: merge a live editor's text the server never got (typed offline, or unsent when the document was rebuilt) from `base`, the last server text it synced, as the member's typing → `{changed, merged, sha256, revisionId}`; 409 `stale` on a clash (nothing applied) |
| GET | `/api/notes/proposals?noteId=&status=` | member | The agent's edit proposals |
| POST | `/api/notes/proposals/:proposalId/accept` | editor, owner | Apply it (merged through the live document); 409 `{status: "stale", base, current, proposed}` when it collides with a newer edit |
| POST | `/api/notes/proposals/:proposalId/reject` | editor, owner | Close it |

In a personal workspace these routes answer 404.

## Swarm

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/swarm/nodes?rootSessionId=<id>` | List swarm nodes in a session (tree rehydration after WS replay ages out). Session owner or admin. |
| GET | `/api/swarm/nodes/:id` | Full node detail including `result` jsonb. |
| POST | `/api/swarm/nodes/:id/cancel` | Cancel a node and all descendants. Runs `AgentManager.stop` on each plus a DB walk; returns `{ cancelled, nodeId, descendantIds, stoppedLive }`. |

## Trajectories

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trajectories?outcome=&from=&to=&limit=` | List trajectory runs (one per `handleMessage`). Filters by outcome (`success` / `failure` / `partial` / `cancelled`) and date range, capped at 1000. |
| GET | `/api/trajectories/:id` | Single trajectory record. |

## Skill Proposals

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills/proposals?include=candidates` | `{ proposals, candidateCount }`. `proposals`: the caller's pending proposals (every user's for an admin), most `exemplarCount` first, then oldest; with `include=candidates`, the candidates follow in the same order (`status: "candidate"`). Each row adds `sourceRefs`, `sessionCount`, `signal`, `previousDraft`, `surfacedAt`, `mergedIntoId` and `similarSkill: {id, name, similarity} \| null`; patch rows (`kind: "patch"`: `targetSkillId`, `patchOldText`, `patchNewText`, `baseContentHash`) add `currentContent` and `stale`. The embedding is never returned. `candidateCount`: candidates not shown yet, in the same scope. See [Session learning](SESSION-LEARNING.md#the-life-of-a-skill-proposal). |
| POST | `/api/skills/proposals/:id/approve` | Promote a pending proposal or a candidate to a skill, or apply a patch. The skill is embedded right after the approval and is then found by skill discovery for every role of the caller ([skill discovery](LANE-ROLE-SKILL-ROUTING.md#skill-discovery)). Body: `{ name?, systemPrompt? }` (not for patches: `400 override`). `404` when it is not an open proposal of the caller. `409 {code: "stale" \| "locked" \| "missing" \| "invalid"}` when it cannot be applied as it stands; it stays pending. See [Session learning](SESSION-LEARNING.md#repairing-a-learned-skill). |
| POST | `/api/skills/proposals/:id/reject` | Reject a pending proposal or a candidate and suppress it for 90 days; returns `{ rejected: true, suppressedUntil }`. The proposals merged into it are rejected with it. `404` when it is not open (a `merged` proposal cannot be rejected). |
| POST | `/api/skills/proposals/bulk-reject` | Body `{ ids: string[] }` (1-100, else `422`); returns `{ rejected: string[], notFound: string[] }`; an id that is not an open proposal of the caller is listed in `notFound`. |
| POST | `/api/skills/proposals/:id/merge` | Body `{ intoId }`: merge `:id` into `intoId` with the background model (count-only when it is unavailable); `:id` becomes `merged`; returns `{ merged: true, verdict: "merged" \| "unchanged", mergeDegraded, proposal }` (the target). `404 not_found` (either is not the caller's), `409 not_open`, `400 same \| patch \| owner`. |
| POST | `/api/skills/proposals/:id/surface` | Show a candidate now, without the recurrence gate or the caps; returns `{ surfaced: true, proposal }`. `404` when it is not a candidate of the caller. |
| POST | `/api/skills/proposals/consolidate` | Consolidate the caller's own proposals and lesson notes (admins included); returns `{ merged, expired, promoted, embedded, degraded, notesMerged, notesArchived }`. `notesMerged`: lesson notes absorbed into another lesson note (and archived); `notesArchived`: lesson notes archived as unused past `learning.lessonTtlDays`. See [Session learning](SESSION-LEARNING.md#lesson-notes). `401` without a user. |
| GET | `/api/sessions/:id/distill-nudge` | The session's open offer to distil a finished run into a skill: `{ nudge: { messageId, offeredAt } \| null }`. Only the session's owner sees one (an admin reading another user's chat, or acting as them, gets `null`); it lapses once another answer follows it. See [Session learning](SESSION-LEARNING.md#offer-to-distil-a-finished-task). |
| POST | `/api/sessions/:id/distill-nudge/:messageId` | Decide the offer on that answer. Body `{ decision: "accept" \| "dismiss" \| "never" }`; needs chat scope; refused (`403`) while acting as another user. `accept` dispatches `distill_skill` through the tool middleware and files a pending proposal: `{ state: "accepted", distilled, proposalId?, status?, message }`. `dismiss`: `{ state: "dismissed", message }`; `never` also turns the offers off (`optedOut: true`). Errors carry `code`: `404 not_found` (not the caller's offer), `409 decided` (already decided), `409 lapsed` (another answer followed it), `403 refused` (a policy, a plugin, or an ASK the click cannot answer), `502 failed` (with `final: true` when the offer is now closed). |
| PUT | `/api/auth/distill-nudge` | Body `{ enabled: boolean }`: turn the caller's distil offers on or off (`preferences.distillNudge`, audited as `settings_changed`); returns `{ distillNudge }`. Refused (`403`) while acting as another user. |

## Knowledge

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge/readiness` | Run the KB self-check (DB + embedding model + vector write probe). Returns 503 with `{ kb: { ready: false, reasons: [...] } }` if the KB is not ready. |
| GET | `/api/knowledge` | Browse entries (lightweight, no vectors). |
| GET | `/api/knowledge/stats` | Counts per source type. |
| POST | `/api/knowledge/search` | Search (`mode`: `hybrid` / `semantic` / `keyword`). An archived note's chunks are never returned; the rows returned are counted as read (`last_accessed_at`). 503 if KB not ready. |
| GET | `/api/knowledge/:id` | Full entry. |
| DELETE | `/api/knowledge/:id` | Delete entry. |
| POST | `/api/knowledge/cleanup` | Orphan / stale / short / duplicate cleanup with optional `dryRun`. |
| GET | `/api/knowledge/cleanup-history` | Recent cleanup runs. |
| POST | `/api/knowledge/index` | Index a file or directory. 503 if KB not ready. |

Every knowledge route works on the caller's own entries plus the product docs
(another user's entry is a 404). An admin adds `?scope=install` to list, read,
search, delete, clean up or count across the whole install, or to see every
cleanup run; each such request writes a `knowledge_install_access` audit row.
`?scope=install` from a non-admin is a 403.

`mode='graph'` is available to agents through the `knowledge` tool, not on
this route — see [KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md).

## Notes

Authored markdown notes — the knowledge graph's Tier 2 surface. Full model in
[KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md). Every route works in the request's
workspace (`X-Octipus-Workspace`): it sees that workspace's notes plus
user-level ones, and creates new notes in it. No route takes a `workspaceId`
in its body.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notes` | List notes. Query: `kind`, `tag`, `includeArchived`, `limit` (default 100, max 500), `q`, `archived=only`. `q` searches on the server: a note matches when every word of `q` (up to 8, case-insensitive, `%`/`_` literal) appears in its title, slug, tags or body; title matches come first, then pinned, then most recently updated. Archived notes never match unless `archived=only`. `preview=true`: each note carries `preview` (at most 140 characters of its text as plain text, without its title line) instead of `body` — for lists; without it the full `body` is returned as before. `archived=only` lists only archived notes (each with `archivedAt`), most recently archived first: the archive view. |
| POST | `/api/notes` | Create or update a note (re-links `[[wikilinks]]`/`#tags` and re-indexes). With `id` it updates that note. Without `id`, a note already at the slug (given, or derived from the title; archived notes included) is **updated**; send `createOnly: true` to create only, which answers `409 {code: "exists", id, slug}` and writes nothing when the slug is taken. The web app sends it for every new note. Personal notes: `ifSha256` (the `bodySha256` the edit was made from) saves only while the stored body still has it, else `409 {code: "stale", currentSha256}` and nothing is written (space notes merge through `baseSha256` instead). Re-indexing for search is deferred: the answer says `indexed: false, indexQueued: true`, and the note is re-embedded once it has had no save for 5 seconds (in the server process: a restart inside that window keeps the earlier chunks until the next save). |
| POST | `/api/notes/query` | Property query: `{ kind?, tag?, frontmatter?, sort?, order?, limit? }`. |
| GET | `/api/notes/index` | Lightweight `{id,title,slug,noteKind}` list — the source for `[[` autocomplete. A note that was moved also carries `movedFrom` (the slugs it was moved away from), so a client resolves an old `[[link]]` as the server does. |
| GET | `/api/notes/tags` | Tag → count across active notes. |
| POST | `/api/notes/capture` | Append `{ text, date? }` to the day's daily note (the workspace's, else an existing user-level one). The web app sends its own calendar day as `date` (`YYYY-MM-DD`); without it the server's UTC day is used. |
| GET | `/api/notes/daily?date=YYYY-MM-DD` | `{ note, template }`: the day's daily note if it exists (`note: null` otherwise; nothing is created) and the text a new one starts from. The Today page shows the day with it and creates the note on the first keystroke. |
| POST | `/api/notes/daily` | `{ date: "YYYY-MM-DD" }` (the caller's calendar day) → `{ note }`: the day's daily note (`daily/<date>`, kind `daily`), created from the daily template only while the day has none (a note created meanwhile is returned, never replaced). An archived one is restored and answered with `restored: true`. `400` for a day that does not exist (`2026-02-31`). |
| POST | `/api/notes/:id/move` | `{ slug }` → `{ note }`: give the note another slug — another folder (`projects/plan`) or name. The id, text and title stay. The old slug is added to `frontmatter.movedFrom` (and taken out of any other note's: one note holds a moved slug), and a `[[link]]` to a slug resolves to the note at that slug, else to the active note that was moved away from it (the exact slug always wins): links to the old slug keep working, before and after the move. `movedFrom` is written by this route alone: `POST /api/notes` ignores it in `frontmatter` and keeps the note's own. `409 {code: "exists", id, slug}` when another note (an archived one included) has the slug, `400 {code: "invalid_slug"}` for a slug that is empty once normalized, `404` when the caller cannot reach the note; in a space, editors and owners only. Renaming a note (a new `title` on `POST /api/notes` with its `id`) never changes its slug. |
| GET | `/api/notes/:id` | Read a note with its backlinks and `linkedTasks` (the to-dos linked to it that the caller can open; see [Note ↔ to-do links](#note--to-do-links)). |
| POST | `/api/notes/:id/todos` | `{ lines?: number[] }` → `{ tasks, marked, reason? }`: make to-dos of the note's task lines that are not to-dos yet (every unticked one, or the 0-based `lines`), each marked and linked. `404` when the caller cannot reach the note. |
| GET | `/api/notes/:id/suggestions` | Semantically related, not-yet-linked entities (computed, not persisted). |
| PATCH | `/api/notes/:id/pin` | `{ pinned: boolean }`. |
| POST | `/api/notes/:id/restore` | Undo an archive: the note is back in lists, search and recall → `{ restored: true }` (also for a note that is not archived, which is left untouched). `404` when the caller cannot reach the note; in a space, editors and owners only (`403` otherwise). |
| DELETE | `/api/notes/:id` | Archive (soft): the note's chunks stay but no search or recall returns them. On a lesson note this is your own archive: a later learning review that finds the same lesson drops it instead of reviving the note. `?hard=true` also deletes the note's chunks and edges. |

## Graph

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/graph` | Global mode: active notes + resolved edges (max 2000 nodes / 5000 edges). With `entryType` + `entryId`: local neighbourhood, `hops` clamped 1–5. Ghost (unresolved) edges are never returned. |
| GET | `/api/graph/canvas` | [JSON Canvas](https://jsoncanvas.org/) projection of a neighbourhood. Query: `entryType`, `entryId`, `hops` (1–5). |

## MCP

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mcp/servers` | List MCP servers with connection status (admin). |
| POST | `/api/mcp/servers` | Add a server (admin). |
| POST | `/api/mcp/servers/:id/toggle` | Enable/disable. |
| PUT | `/api/mcp/servers/:id/exposure` | Set `exposure` and/or the whole `toolExposure` map ([Tool exposure](MCP-INTEGRATION.md#tool-exposure)). |
| PUT | `/api/mcp/servers/:id/description` | Set the one-line description agents see in the `MCP SERVERS` prompt section; `""` clears it. |
| PUT | `/api/mcp/servers/:id/tools/:tool/exposure` | Set one tool's exposure override; `{ "exposure": null }` removes it. |
| POST | `/api/mcp/servers/:id/connect` | Connect manually. |
| POST | `/api/mcp/servers/:id/disconnect` | Disconnect. |
| DELETE | `/api/mcp/servers/:id` | Remove. |
| GET | `/api/mcp/tools` | All tools across connected servers. |
| GET | `/api/mcp/servers/:id/tools` | Tools for one server. |
| GET | `/api/mcp/circuit` | Circuit-breaker state for every server (admin). |
| POST | `/api/mcp/circuit/:serverId/reset` | Force-close a server's breaker (admin). |

## Voice

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/voice/transcribe` | Transcribe audio (base64) to text |
| POST | `/api/voice/speak` | Speak text (`{ text, voice_id?, format? }`); the audio bytes |

## Media

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/media/images` | Draw with the Image generation lane: `{ prompt, aspect_ratio?, n? }` → `{ images: [{ mimeType, base64 }], model, revisedPrompt? }`. 409 when `draw` is off |
| POST | `/api/media/describe` | The Vision lane describes an image: `{ image (base64, ≤ 10 MB), mimeType?, question? }` → `{ description, model }`. 409 when nothing can see |

## Skill Topic Assignments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills/topics` | List skill-topic bindings |
| POST | `/api/skills/topics` | Create assignment |
| DELETE | `/api/skills/topics/:id` | Delete assignment |

## Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/metrics` | System metrics (uptime, requests, etc.) |

## Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/logs/recent` | Get recent logs |

## Memory

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/memory` | Get memory state |
| DELETE | `/api/memory/:id` | Delete memory entry |

## Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search` | Global search: the caller's own sessions and hooks, models, skills, tools, and the caller's knowledge |

## Workspace

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workspace` | Get workspace info |
| PUT | `/api/workspace` | Update workspace |

## Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | All settings, grouped by category (secrets masked) |
| GET | `/api/settings/registry` | Registry metadata for UI rendering |
| GET | `/api/settings/:key` | One setting by key (secrets masked) |
| PUT | `/api/settings/:key` | Update one setting |
| PUT | `/api/settings/batch` | Update several settings |
| POST | `/api/settings/:key/reset` | Reset one setting to its default |

## Group Channels

Group chats enrolled from inside the channel ([CHANNELS.md](CHANNELS.md)).
Owner-only, admins included (the admin routes above are the audited
override); another user's enrolment answers 404.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/me/group-channels` | My enrolled group channels |
| PATCH | `/api/me/group-channels/:id` | Set mode (`mention`/`listen`/`proactive`), quiet hours, timezone and rate limits |
| DELETE | `/api/me/group-channels/:id` | Remove the enrolment |
| POST | `/api/me/group-channels/:id/bind` | Bind the channel to a space I own: `{workspaceId, acknowledged: true, roomId?}`. `roomId` becomes the main thread; other threads get a room on first use. Audited ([SPACES.md → Group channels bound to a space](SPACES.md#group-channels-bound-to-a-space)) |
| DELETE | `/api/me/group-channels/:id/bind` | Unbind it (the channel's owner, or an owner of the space) |

## Channel Bindings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/channel-bindings` | List channel bindings |
| POST | `/api/auth/channel-bindings/redeem` | Redeem a channel binding code |
| DELETE | `/api/auth/channel-bindings/:channelType/:externalId` | Remove channel binding |

## Devices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/devices` | List devices |
| POST | `/api/devices/pair/generate` | Generate device pairing code (valid 5 minutes; stored only as its SHA-256) |
| POST | `/api/devices/pair/redeem` | Redeem a pairing code for a mobile session (unauthenticated; each code redeems once) |
| DELETE | `/api/devices/:sessionId` | Revoke device session |

## API Tokens

Tokens are shown once at creation; revoke and create a replacement to rotate.
An empty scope list is full access. Restrict automation tokens to the scopes
required by their routes; see `src/security/scopes.ts` for supported names.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/api-tokens` | List API tokens |
| POST | `/api/auth/api-tokens` | Create token |
| DELETE | `/api/auth/api-tokens/:id` | Revoke token |

## OAuth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/oauth/:provider/status` | Get provider connection status |
| GET | `/api/auth/oauth/:provider/authorize` | Initiate OAuth flow |
| GET | `/api/auth/oauth/:provider/callback` | OAuth callback |
| POST | `/api/auth/oauth/:provider/disconnect` | Disconnect OAuth provider; optional `{ account }` disconnects that account only |
| GET | `/api/auth/oauth/:provider/authorize?addAccount=true` | Connect a further account of the provider |
| GET | `/api/auth/oauth/:provider/accounts` | The caller's connected accounts of the provider, default first |
| POST | `/api/auth/oauth/:provider/accounts/default` | `{ account }`: make it the default (agents and the heartbeat use it) |

## Code index

The optional CocoIndex Code index (Knowledge page →
[MCP-INTEGRATION.md](MCP-INTEGRATION.md#optional-code-search-with-cocoindex-code)): a managed MCP
server that finds code by meaning.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/code-index/cocoindex` | Status; a member gets it without paths or diagnostics |
| POST | `/api/code-index/cocoindex/install` | Admin: `{workspacePath, embeddingSource?: "local" \| "octipus", embeddingModel?}` → `202` and the status; installs or reconfigures in the background |
| DELETE | `/api/code-index/cocoindex` | Admin: disconnect and remove the managed server (the package and index files stay) |
| POST | `/api/code-index/cocoindex/:side/embeddings` | Admin token only: the OpenAI-compatible endpoint the managed daemon embeds through with the embedding topic's model (`side`: `document` or `query`) |

The built-in OAuth connector framework (`/api/connectors`, the space
connectors, `connector_list_tools` / `connector_call_tool`) was removed; a
[plugin package](PLUGIN-PACKAGES.md) brings its own tools, network hosts and
secrets instead.

## Plugin host API

Called only by a plugin package's own tool calls, through its egress proxy,
with the per-call token (`Bearer ocph_…`); a session or API token gives
nothing here ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#host-api)).

| Method | Endpoint | Scope |
|--------|----------|-------|
| GET | `/api/plugin-host/whoami` | — |
| GET / POST | `/api/plugin-host/notes` | `notes:read` / `notes:write` |
| GET / POST | `/api/plugin-host/tasks` | `tasks:read` / `tasks:write` |
| GET | `/api/plugin-host/documents/:id` | `documents:read` |
| POST | `/api/plugin-host/documents` | `documents:write` (create a text document) |
| PUT | `/api/plugin-host/documents/:id` | `documents:write` (update one the package created) |
| POST | `/api/plugin-host/notify` | `notify` |
| POST | `/api/plugin-host/web/read` | `web:read` |
| POST | `/api/plugin-host/model/complete` | `model:complete` |
| POST | `/api/plugin-host/agent/runs` | `agent:run` (start a background run; `202 { id }`) |
| GET | `/api/plugin-host/agent/runs/:id` | `agent:run` (a run's status and result) |

## Plugins

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/plugins` | List plugins |
| POST | `/api/plugins/:name/reload` | Reload installed plugin from disk |
| GET | `/api/plugins/:name` | Get loaded plugin details |

## Webhooks

Outgoing webhook delivery is configured as a hook action; there is no separate
outgoing-webhook CRUD API. See [Hooks](HOOKS.md) and [Webhooks](WEBHOOKS.md).
`POST /api/webhooks/:path` receives configured webhook triggers.

## Webhook Incoming

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/hooks/incoming/:hookId` | Receive inbound webhook (hook-configured authentication/signature checks) |

## Teams Webhook (Channel Integration)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/channels/teams/webhook` | Teams webhook receiver |

## WhatsApp Webhook (Channel Integration)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/channels/whatsapp/webhook` | WhatsApp webhook receiver |

## Evaluations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/evaluations/eval/runs` | List evaluator runs |
| POST | `/api/evaluations/eval/run` | Start evaluator run |
| GET | `/api/evaluations/eval/runs/:id` | Get evaluator run results |

## Eval

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/eval/run` | Run YAML eval scenarios |

## Artifacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/artifacts/_meta` | Get artifact host mode (subdomain or DNS-less) |
| GET | `/api/artifacts` | List artifacts in workspace |
| POST | `/api/artifacts` | Create new artifact |
| GET | `/api/artifacts/spec/:slugOrId` | Get full artifact spec for validation |
| GET | `/api/artifacts/:id` | Get artifact details |
| PUT | `/api/artifacts/:id` | Update artifact |
| DELETE | `/api/artifacts/:id` | Delete artifact |
| GET | `/api/artifacts/:id/versions` | List artifact versions |
| POST | `/api/artifacts/:id/versions/:versionId/restore` | Restore artifact to previous version |
| GET | `/api/artifacts/:id/data-sources` | List artifact data sources |
| POST | `/api/artifacts/:id/data-sources` | Add data source |
| DELETE | `/api/artifacts/:id/data-sources/:sourceId` | Remove data source |
| POST | `/api/artifacts/:id/refresh` | Refresh artifact data |
| GET | `/api/artifacts/:id/data/:sourceName` | Get data from source |
| POST | `/api/artifacts/:id/share-links` | Create share link |
| GET | `/api/artifacts/:id/share-links` | List share links |
| DELETE | `/api/artifacts/:id/share-links/:linkId` | Delete share link |
| GET | `/api/artifacts/:id/feed.rss` | Get RSS feed |

## Artifact Pages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/a/:slug` | Serve hosted artifact page; DNS-less deployments also expose /__artifacts__/a/:slug |

## Gateway WebSocket

Connect to `/gateway` for real-time communication. All messages are JSON, Zod-validated.

### Authentication

First message must be `auth` within 5 seconds:
```json
{
  "type": "auth",
  "method": "session_token",
  "credentials": { "token": "<jwt>" },
  "clientType": "webchat"
}
```

Auth methods:

- `session_token` — `credentials.token`: a login session token (web, TUI after
  `/login`).
- `api_key` — `credentials.key`: a personal API token (`octi_…`, Settings →
  API Tokens).
- `artifact_token` — `credentials.artifactId` and `credentials.token`: the
  short-lived token an artifact embed page is served with. The connection is a
  viewer of that one artifact, not a user: it may only `ping` and
  (un)subscribe `artifact:<id>`. At most 50 viewer connections per artifact;
  each closes when its token expires (code 4001), and all close when the
  artifact is deleted or its visibility changes (code 4003; reload the page
  for a new token).

A user holds at most `gateway.maxConnectionsPerUser` (default 20) signed-in
connections; the one over the cap gets `auth_error` `Too many connections`.
A client frame larger than `gateway.maxFrameBytes` (default 262144 bytes,
echoed in `auth_ok.maxFrameBytes`) closes the socket with code 1009.

Every authenticated connection has `user` trust; there is no `local` trust and
no loopback exemption. Admin rights come from the user's `isAdmin` flag in the
database. A connection whose user is deactivated or whose admin flag changes is
closed (codes 4001 and 4004) and must re-authenticate.

### Client → Gateway Messages

| Type | Description |
|------|-------------|
| `auth` | Authentication handshake |
| `chat.send` | Send chat message (requires `sessionId`, `content`; optional `workspaceId` — one of yours — for a session the server has not seen yet, `fileRefs`, `outputMode`, `attachments`, `mode`, `turnId` — echoed on the turn's `chat.response` / `chat.error` payloads, its `chat.delivery` and the `error` frames that answer it, with `sessionId`). `mode`: `auto` (default — a text message sent while a turn of that session runs steers it, `chat.message` with `injected: true`, when the running agent takes input mid-turn; otherwise it queues), `queue`, `steer` (refused when nothing running takes it) or `restart` (stop the running turn, run this next). Answered with `chat.delivery` `{ outcome: steered \| queued \| restarted \| refused, ahead?, reason? }` |
| `chat.steer` | Inject a message into the running turn of one of your sessions (with `mode` `auto`, a normal `chat.send` when nothing running takes it; `mode: 'steer'` refuses instead) |
| `chat.interject` | A side question answered alongside a running turn |
| `command` | Execute gateway command (`name`, optional `args`) |
| `subscribe` | `patterns`: event-type patterns over the connection's own events (e.g., `["agent.*"]`); `resources`: resources to receive events of (e.g., `["artifact:<id>"]`), each access-checked and answered with `subscribed` or a `FORBIDDEN` error |
| `unsubscribe` | Remove event patterns and/or resources |
| `permission.respond` | Approve/deny permission request |
| `approval.respond` | Approve/deny pipeline approval |
| `agent.stop` | Stop one of the connection's own user's running agents (an admin included; another user's agent is `AGENT_NOT_FOUND`). Stopping the session's running root drops your messages queued behind it (`agent.stopped` payload `droppedQueued`; envelope `sessionId`, payload `root`) |
| `session.stop` | `{ sessionId }` — stop your turn in one of your sessions only: your queued messages in it, then your running agents in it. Another user's session is `SESSION_NOT_FOUND`. Answered with `session.stopped` `{ stopped, droppedQueued, rootAgentId? }` |
| `voice.set` | `{ sessionId, on }` — voice mode for one of your sessions on this connection: lifecycle narration arrives as `voice.speak` events; cleared when the connection closes. Another user's session is `SESSION_NOT_FOUND` |
| `replay` | `{ sessionId, afterEventId? }` — the buffered events of one of your existing sessions after `afterEventId`. Another user's or an unknown session is `SESSION_NOT_FOUND` |
| `ping` | Heartbeat |

### Gateway → Client Messages

| Type | Description |
|------|-------------|
| `auth_ok` | Auth success (includes `connectionId`, `capabilities`, `serverTime`, `maxFrameBytes`) |
| `auth_error` | Auth failure |
| `event` | Gateway event (agent lifecycle, chat response, etc.); only the connection's own user's events, plus those of subscribed resources |
| `subscribed` | Resources of a `subscribe` that passed the access check |
| `command.result` | Result of a command |
| `error` | Error with `code` and `message` |
| `pong` | Heartbeat response with server time |
| `permission.pending` | `{ requests, approvals }`: your open permission requests and root-agent approvals, after every `subscribe` with patterns (events raised while it is read follow it) and after a `permission.respond` that found the request already answered |
| `replay` | `{ sessionId, events, gap }`: answer to `replay`; `gap` means the events cannot bridge what was missed — reload from REST |
| `chat.delivery` | `{ sessionId, mode, outcome, ahead?, reason? }`: what became of a `chat.send` / `chat.steer` — `steered`, `queued` (`ahead` turns first), `restarted` or `refused`. A queued message `/stop` drops ends with `error` `CHAT_CANCELLED` and a `chat.error` with `cancelled: true` |

Events of note for clients (`event.type`): `chat.response`, `chat.delta`,
`chat.error` (a failed turn, to every connection of the user),
`chat.message` (`injected` steer, `sideChannel` answer, or `proactive` in-app
delivery to `webchat:<your id>`), `permission.request` / `permission.resolved`,
`agent.approval_required` / `approval.resolved`, `document.*`,
`model.install_progress`, `voice.speak`, `swarm.*`, `agent.*`,
`tasks.changed` (one of your personal to-dos changed: `{taskId}`). A refused
`approval.respond` answers `error` `APPROVAL_NOT_FOUND` (unknown, someone
else's, or already answered) or `APPROVAL_EXPIRED`.

### Gateway Commands

Available via `{ "type": "command", "name": "<cmd>" }`:

| Command | Description |
|---------|-------------|
| `/help` | List available commands |
| `/status` | Session status and running agents |
| `/abort` | Cancel all running agents |
| `/clear` | Clear conversation |
| `/compact` | Compact session context |
| `/think [level]` | Set thinking depth (off/low/medium/high) |
| `/verbose [on\|off]` | Toggle verbose output |
| `/usage [mode]` | Usage display (off/tokens/full) |

### Gateway over stdio

The same protocol, framed as JSON lines over the process's own stdin and
stdout, for an IDE or a parent process that embeds Octipus as a subprocess:

```
octipus --stdio        # or GATEWAY_STDIO=1
```

One line in is one client message (the `auth` line first, within 5 seconds),
one line out is one gateway message; lines end in `\n` only. Logs go to
stderr in this mode so the pipe carries nothing but protocol. Lines are
handled strictly in order. The WebSocket endpoint stays up alongside; the
stdio connection is one more client of the same hub, with the same rate
limits, budgets and event-visibility rule. When stdin ends, the process
shuts down.

### Gateway REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/gateway/status` | Hub status (connections, events) |
| GET | `/api/gateway/connections` | Active connections (admin) |
| GET | `/api/gateway/events/stats` | Event bus metrics |
| GET | `/api/gateway/adapters` | Channel adapter status |
| GET | `/api/health/time` | Server time and timezone |

### Retired sockets

`/ws` and `/ws/permissions` were removed (coworking S0d); the web app uses
`/gateway`. The browser extension's `/ws/browser-bridge` and the voice
sockets (`/voice`, `/voice/media/:provider`) remain.

## OpenAI-compatible API (`/v1`)

Octipus exposes an OpenAI-compatible surface at `/v1` so off-the-shelf OpenAI
SDKs can talk to it. Authenticate with a personal access token
(`Authorization: Bearer octi_…`) exactly like `/api`. The `api:chat` scope is
enforced on completions (unscoped tokens are full-access — see
[token scopes](#api-tokens)).

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/models` | List available models: `octipus/agent` + every registry model. |
| POST | `/v1/chat/completions` | Chat completion (streaming and non-streaming). |

### Model modes

- **`octipus/agent`** (default when `model` is omitted) runs the latest
  user message through the full agent turn — the root agent with its tools,
  delegating to specialists when it needs one. The older `octipus/orchestrator` ID remains accepted as a compatibility alias. This
  mode is **session-stateful**: pass a stable `user` field (or an
  `X-Octipus-Session` header) to keep a conversation sticky; otherwise each
  call runs in a fresh ephemeral session.
- **A registry model id** (e.g. `gpt-4o`, `llama3.2`, from `GET /v1/models`) is
  a single-turn **passthrough** to that provider — no tools, no session — and
  forwards the supplied text `messages` array. Provider-reported token usage
  is returned. This is a limited text chat-completions surface, not full
  OpenAI API compatibility (no multimodal content arrays or client tool schemas).

### Example — Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="https://your-host/v1", api_key="octi_…")

# Root agent pipeline
resp = client.chat.completions.create(
    model="octipus/agent",
    messages=[{"role": "user", "content": "Summarize today's open PRs"}],
    user="my-session-id",  # optional: keep the conversation sticky
)
print(resp.choices[0].message.content)

# Passthrough to a specific model, streaming
for chunk in client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Write a haiku about octopuses"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

### Example — curl

```bash
curl https://your-host/v1/chat/completions \
  -H "Authorization: Bearer octi_…" \
  -H "Content-Type: application/json" \
  -d '{"model":"octipus/agent","messages":[{"role":"user","content":"hello"}]}'
```

### Notes & limits

- Agent-mode usage has no prompt/completion split: the observed total is
  reported in `completion_tokens` and `total_tokens`, with `prompt_tokens: 0`.
- **Streaming** (`stream: true`) is OpenAI-style SSE: a role chunk, content
  chunks, a chunk with `finish_reason: "stop"`, then `data: [DONE]`, every
  chunk with the request's one `chatcmpl-…` id. For a stream that completes,
  the content chunks concatenate to exactly the `message.content` the same
  model reply is returned as without `stream`.
  - **Passthrough** (a registry model id) streams **token-true** on the
    providers whose streamed text is their completed text, unaltered on both
    paths: OpenAI, OpenRouter, Mistral, Grok, Moonshot, Meta, z.ai, Vertex and
    custom OpenAI-compatible providers. Their content chunks leave as the
    provider produces them, verbatim; tool-call deltas are never sent as text.
    Every other provider (the LiteLLM proxy, Anthropic, Gemini, DeepSeek,
    Ollama, custom Anthropic- and Gemini-compatible providers, CLI providers)
    normalises its streamed and its completed text differently (thinking tags,
    trimming, a leaked JSON thinking wrapper, DeepSeek template recovery), so
    its reply is completed and the finished text chunked, as before: streaming
    it would show text the non-streamed answer filters.
  - An error before the first chunk is answered from that one attempt, as the
    non-streamed path answers it: 429 `rate_limit_exceeded` for a budget or
    quota refusal, 400 `model_not_found` for an unknown model, 500
    `server_error` for anything else (an open circuit, an upstream error); it
    is not retried without streaming. A client that is already gone when the
    provider would be called gets 499 `client_closed` and no call is made. A
    provider that fails midway ends the stream with an OpenAI error frame
    (`data: {"error": …}`) and `[DONE]`, not a finish chunk.
  - A client that disconnects mid-reply aborts the provider call. One that
    disconnects after the reply's text is complete lets the provider's usage
    chunk be read (up to 2 s) so the call is accounted for; a stream cut off
    before its usage is recorded with an estimate (prompt plus output so far,
    `usageEstimated` in `cost_log` metadata; see
    [SPEND-BUDGETS.md](SPEND-BUDGETS.md) for its limits). A client that stays connected
    but stops reading is dropped after `api.streamStallTimeoutMs` (default
    60 s): the provider call and its rate-limit slot are freed and the stream
    ends without `[DONE]`.
  - `agent.streaming: false` turns token-true streaming off (the finished
    reply is chunked). Chunks carry the requested model id; usage is not
    streamed (`stream_options` is not supported).
  - **Agent mode** (`octipus/agent`) chunks the turn's **final** answer once
    the turn ends. The answer is not final while the model writes it: the
    output guard decides on the whole text and may replace it, inline-UI blocks
    become markers, child results are relayed into it, swarm scaffolding is
    stripped, and an empty reply becomes the last status update. SSE cannot
    take sent text back, so nothing is sent before those passes have run.
    Text written before a tool call and sub-agent output are never part of the
    stream. The web chat and the TUI still receive the root agent's live text
    (`chat.delta`) over the gateway, where the final message replaces it.
- `octipus/<role>` model ids (forced single-role) are **not yet wired** and
  return `400 model_not_found`; use `octipus/agent` or a registry model.
- Errors use the OpenAI error envelope (`invalid_request_error`,
  `authentication_error`, `server_error`) so SDK error handling works.
