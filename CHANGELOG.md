# Changelog

Notable changes worth calling out for operators and integrators.
The format draws from [Keep a Changelog](https://keepachangelog.com)
without forcing strict semver — Octipus is pre-1.0; "minor" / "major"
labels reflect blast radius, not contract guarantees.

## Unreleased

- **Agent refresh for Live Artifacts** (BETA,
  [docs](docs/ARTIFACTS.md#agent-refresh)). An artifact can now stay current
  by having an agent regenerate it. The agent that creates a page may store a
  refresh instruction (`create_live_artifact` → `refresh_instruction`), shown
  as "set by agent — review before enabling"; the artifact's owner edits it,
  clicks **Refresh with agent**, and may set a schedule (hourly at most often;
  off by default). The run is the owner's: an unattended `research` worker
  on the owner's spend budget and quotas, given only the stored instruction,
  with exactly two tools, web search and page fetch — never the owner's
  knowledge, files or other tools; a server that would give it anything else
  refuses the run. The new version replaces the page only when the run returns
  exactly one valid page and nobody edited it meanwhile; otherwise the current
  version stays and the failure is shown. Identical pages write no version,
  and only the 5 newest refresh versions are kept. One refresh per artifact at
  a time (`409`), 3 per server process (`429`), 10 minutes per run even if it
  hangs; a schedule that fails or is refused 5 times in a row turns itself off
  and notifies the owner, and one nobody opens pauses after the retention
  window (30 days without one). A refresh does not extend retention. Only the
  owner can trigger it: workspace members get `403`, viewers and embed tokens
  have no route to it. Not available in shared spaces; refreshing from the
  knowledge base is not built. Migration `0207_artifact_agent_refresh` adds
  the `artifact_agent_refresh` table.
- **Email channel.** Talk to Octipus by mail: mail to a dedicated IMAP mailbox (an admin's personal one) from an allow-listed, linked sender becomes a conversation, answered by a threaded reply (`Re:`, `In-Reply-To`/`References`) that is saved as a **draft for a person to send** by default (`emailChannel.replyMode: draft`) or sent at once with `Auto-Submitted: auto-replied` (`send`); replying continues the session. A mail counts only when the topmost `Authentication-Results` under an operator-trusted authserv-id reports `dmarc=pass` for the From domain (no DKIM/SPF fallback; the receiving server must strip forged headers carrying its id — see the hard requirements in the docs). Anything else, auto replies, lists, bounces, repeats, late mail and senders over the hourly limit are dropped and recorded, never answered. Email turns are restricted: web search and the bundled help only, no stored grants, no commands or plan `go`, no memory, context hooks or plugin context, attachments not read (never filed into documents or the knowledge index), unattended (approvals refused), and no egress once the session holds private data. The mailbox owner can read every email-channel conversation; their agent cannot, and automatic triage skips the mailbox. Off by default (`emailChannel.*` under Settings → Channels). New table `email_channel_messages` (migration `0206_email_channel`). See docs/CHANNELS.md#email.
- **Terminal chat: older turns, a model picker and `@` mentions**
  ([guide](docs/guides/tui.md#reading-a-conversation)). Scrolling up past
  the 50 messages a resumed session replays now loads earlier ones from the
  server, 100 at a time, with a notice while there are more, while loading
  or when a load failed. `/model` alone opens a picker of the models you
  may use and sets this session's root agent model (`/model <name>` and
  `/model clear` work as text; the gateway gained a `/model` command).
  `@` completes agents, skills and recent sessions above project files, as
  text tokens the agent reads. Fixed: on the alternate screen, scrolling
  up in an idle session stopped under "N earlier messages above"; `/history`
  replayed a companion's internal check-ins; the editor's Up/Down skipped
  the rows of a soft-wrapped line.
- **Browse skill registries**
  ([docs](docs/SKILL-EXCHANGE.md#registries)). Skills → Import → **Browse
  registries** lists and searches the skills of static JSON indexes an
  administrator lists in `skills.registries` (`[{ name, url, publishers }]`,
  **empty by default: no registry is contacted until one is added**), with
  the newest version, the signature status for that registry's publishers,
  and an "update available" mark against the version you installed. A
  listing installs only through the existing preview and install: the bundle
  is downloaded through the SSRF-guarded fetch (https, public addresses,
  1 MiB, 15 s), must hash to the index digest, match the listing, and carry a
  valid signature by a key of one of the registry's `publishers` in
  `plugins.trustedPublishers` (unsigned or other-key bundles are shown, not
  installable). Nothing is ever updated automatically. New:
  `GET /api/skills/exchange/registry`, a `registry` source on
  `/api/skills/exchange/preview` and `/install`,
  `octi plugin build-skill-index <dir> --base-url <https://…/>` to build an
  index (`octipus-skill-index` v1) from a folder of signed bundles, and
  migration `0205_skill_registry_installs` (which listing version each person
  installed, keyed by registry URL hash, with the history of content hashes
  so a relabelled old bundle is flagged as a possible rollback and never
  shown as an update). Index URLs, which may carry a token, are never shown
  to callers; registry and URL previews need `api:write`, and registry
  previews and installs are limited to 30 a minute per person.
- **Fix:** an https download (plugin package, skill bundle, registry index)
  now has one deadline for every redirect hop and the body together; each
  hop used to get a fresh timeout, so the stated limits could be exceeded
  several times over.
- **OpenTelemetry tracing**
  ([docs](docs/OBSERVABILITY.md#tracing-opentelemetry)). Off by default;
  set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
  or `OTEL_TRACES_EXPORTER=otlp`) to export spans over OTLP/HTTP to a
  collector. Spans: inbound HTTP request (health and metrics excluded),
  `agent.run` per turn, `agent.child` per spawn,
  `pipeline.run` and `pipeline.stage`, `chat <model>` per model call with
  provider, model, token counts and streaming, `execute_tool <name>` per tool
  call, `channel.deliver`, and `webhook.deliver`. An inbound `traceparent`
  is continued only with `OCTIPUS_TRACE_TRUST_INBOUND=true` (otherwise linked
  from a new trace), and webhooks send `traceparent` only with
  `OCTIPUS_TRACE_PROPAGATE_OUTBOUND=true`; `tracestate` is never forwarded.
  Spans carry ids, names, counts, status and the error class only, never
  prompts, completions, tool arguments, message text or the error message.
  The standard `OTEL_*` variables set headers, service name, resource,
  sampler and batching. An `OTEL_TRACES_EXPORTER` without `otlp`, or the
  `grpc` protocol, is logged and leaves tracing off; boot is unaffected. The
  shutdown flush is capped at 1.5 s. New dependencies:
  `@opentelemetry/api`, `sdk-trace-base`, `context-async-hooks`, `core`,
  `resources` and `exporter-trace-otlp-http`; the SDK is loaded only when
  tracing is on.
- **An orchestrated hook refused at the agent cap is no longer lost**
  ([docs](docs/WEBHOOKS.md#idempotency-duplicate-deliveries)). When a
  `spawn_agent` hook with `orchestrated: true` fired while the server was at
  `maxConcurrentAgents`, its root agent never started and nothing reached its
  session, yet the webhook delivery was marked done, so a redelivery was
  ignored. It is now handled like the direct spawn already was: the delivery
  id is released for a redelivery, the cooldown / `maxExecutions` reservation
  is handed back, and the failure is logged as an `error` row. A quota or
  spend-budget refusal is unchanged: it is answered in the hook's session and
  the delivery counts as done. Limits: a turn whose message was already
  stored (a room post, a plan's "go") is not released. An `onlyOnChange` hook
  ([docs](docs/WEBHOOKS.md#only-when-a-check-turns-failing-onlyonchange))
  refused at the cap no longer stores the failures it carried as seen: with no
  merge window a redelivery runs; with a merge window the merged turn is lost
  (logged as an `error` row, not retried), but the check's next red result
  counts as a change again instead of being swallowed.
- **A scheduled run refused before it started tells you, and no longer
  silences later failures** ([docs](docs/HOOKS.md#a-failed-run-tells-you)).
  A scheduled hook refused at the agent cap (or, for a direct spawn, by a
  quota or paused budget) set `lastError` to `Not started: …` and sent
  nothing; as the `schedule_failed` notification only fires when `lastError`
  is empty, the next real failure was silent too. A `Not started` marker no
  longer counts as a failure streak, so a later failure notifies. A recurring
  schedule's first refusal of a streak now notifies (`Scheduled task "<name>"
  did not start`; that run is skipped), and a one-shot notifies when it gives
  up retrying after 24 hours. Orchestrated schedules refused at the cap are
  now retried and reported this way too, instead of as a failed run.
- **Clean up host-command and CLI temporary data automatically.** Each local
  host command, background job and CLI invocation receives an owned temporary
  directory through `TMPDIR`, `TEMP` and `TMP`. Test databases and other scratch
  files are removed after its processes exit, including failed and cancelled
  commands. Live background processes retain their files. Startup and periodic
  sweeps recover confirmed abandoned directories without sweeping arbitrary
  `/tmp` contents. See [temporary storage](docs/TEMPORARY-STORAGE.md).

- **Offer to distil a finished task into a skill** (A1-M3,
  [docs](docs/SESSION-LEARNING.md#offer-to-distil-a-finished-task)). After a
  complex, successful turn the web chat offers, once and above the composer,
  to distil it into a skill proposal: **Distil into a skill**, **Not now**,
  **Don't ask again**. It is decided after the answer is delivered, from
  what the run recorded, without a model call: a person asked (no hook,
  cron, heartbeat, monitor, webhook, voice, room or space turn), it answered
  without a refusal and its checks passed, it used at least 3 different
  tools and either 8 tool calls or a delegation, no skill was used, and no
  open or suppressed proposal came from the session. At most one offer per
  user per 24 hours; the new gateway event `session.skill_nudge` announces
  one. Accepting dispatches `distill_skill` through the tool middleware
  (`tool:before` hooks, the permission check, the `permission_granted`
  audit row; the click answers only a plain ASK) on the run's own messages
  and tools, bounded to 30 messages and 40,000 characters, and files a
  pending proposal, still approved on Skills → Proposals; nothing is
  distilled otherwise. A cut-off reply, or three failed attempts, closes the
  offer. Each decision is stored on the answer. Operators:
  `learning.distillNudge` (on), `learning.distillNudgeMinToolCalls` (8),
  `learning.distillNudgeMinDistinctTools` (3),
  `learning.distillNudgeCooldownHours` (24). Users: Settings → Profile, or
  `PUT /api/auth/distill-nudge`. New routes
  `GET /api/sessions/:id/distill-nudge` and
  `POST /api/sessions/:id/distill-nudge/:messageId`; `chat.send` `renders`
  accepts `skill_nudge`. Other clients and channels get no offer. No
  migration: the offer lives in `messages.metadata`, the opt-out in
  `users.preferences`, the cool-down in `kv_store`.
- **Live artifacts (BETA): hosting hardening, scoped viewer tokens, retention, slug conflicts**
  ([docs](docs/ARTIFACTS.md#sandboxing), [hosting](docs/CONFIGURATION.md#artifacts-hosting)).
  - With `ARTIFACTS_HOST` set, the artifact host serves only the hosted pages
    and the SDK (`GET`/`HEAD`): `/api`, `/v1`, sign-in and the
    `/__artifacts__` mount answer 404 there, credentials sent to it are
    ignored, no response from it sets a cookie, and of its WebSocket
    endpoints only the gateway upgrades, admitting artifact viewer tokens
    only (voice, browser-bridge and federation sockets are refused there). The root `/a/<slug>` pages are no longer
    served on the app's own host in that mode. **Operators:** the reverse
    proxy must pass the original `Host` header (matched exactly), and
    `ARTIFACTS_HOST` is honoured only with `PUBLIC_URL` set to a different
    host (otherwise it is ignored with an error and the `/__artifacts__`
    fallback serves). Settings refuses to save the app's own address as the
    artifact host.
  - The outer page gets a no-script CSP and `Cross-Origin-Opener-Policy`;
    embeds, exports and data reads send no referrer and are not cached;
    exports are inert (`sandbox` CSP) if opened.
  - **Behaviour change:** the outer page (`/a/<slug>`) can now be framed only
    by the app itself and the artifact's `allowedEmbedOrigins` (before, it
    sent no framing policy). A site that frames the outer page rather than
    `/embed` must be added to the artifact's allowed embed origins.
  - **Behaviour change for API clients (all routes, not only artifacts):** a
    request whose *path* percent-encodes an unreserved character (a letter,
    digit, `-`, `.`, `_` or `~`, e.g. `%61` for `a` or `%7E` for `~`), or
    holds a malformed `%` escape, is refused with `400`
    `{"code": "non_canonical_path"}` (with the usual CORS and security
    headers). Clients must send unreserved characters unencoded, as
    `encodeURIComponent` does. Other escapes (`%20`, `%2F`, …) and query
    strings are unaffected. This keeps request checks and routing on the same
    path.
  - Fixed: response headers are keyed case-insensitively, and a header a
    handler set (on `set.headers` or on a `Response` it returns) is never
    replaced or duplicated by a default; an embed always carries only its own
    sandboxing policy.
  - The debug request log no longer records share-link, viewer-token or
    OAuth-code query values, nor the token segment of public media, invite
    and form links; the bundled web server's error log omits the query and
    those tokens too.
  - Fixed: templates are sanitized again after `{{…}}` expansion, and the
    built artifact script is no longer served as a separate file
    (`/a/<slug>/bundle.js` is removed; embeds already inline it under a hash).
  - Template values (`{{…}}`) are encoded so that they are always plain text
    or a single attribute value: besides `& < > " '` they encode whitespace,
    `/`, `=`, backtick and braces as character references, which the browser
    decodes back to the same text. Data can no longer add attributes, be
    altered by the sanitizer, or be expanded as a template; widget output is
    inserted after the template pass. An event-handler attribute right after a
    closing quote is stripped too.
  - Fixed: `allowedEmbedOrigins` was spliced into the embed CSP unchecked, so
    an entry could add a `sandbox … allow-same-origin` directive. It now takes
    web origins only (400 otherwise).
  - Fixed: live refresh in embeds never loaded new data — the SDK read a
    session-only `/api` route the sandboxed page cannot authenticate to. It
    reads the embed's own `…/data/<source>` route with its viewer token,
    which is read-only, for one artifact, expires after 5 minutes, and is
    refused once the artifact is deleted, its visibility changes, or the
    share link it came from is revoked. No `/api` route accepts it.
  - Fixed: the embed CSP kept pinning the SDK hash stored by an earlier
    release, so after an SDK change browsers refused the new client.
  - **Retention:** `artifacts.retentionDays` (`ARTIFACTS_RETENTION_DAYS`)
    moves artifacts with no edit, no view and no data refresh for that many
    days to the trash (views are recorded in a new `last_viewed_at` column,
    migration `0204`, at most hourly per artifact); `artifacts.trashDays` (`ARTIFACTS_TRASH_DAYS`) sets how long
    the trash keeps them before they are removed with their versions, data
    and bundle files. Defaults: `0` (never expire) and `30` (unchanged), so
    no existing artifact is deleted by upgrading.
  - **Slug collisions:** a taken slug is a `409` with `code: "slug_taken"`
    and a free `suggestedSlug`, from the API, the agent tool and the chat's
    save dialog; the web forms offer the suggestion. Concurrent creates are
    decided by the unique index (one `201`, the rest `409`). A deleted
    artifact frees its slug at once (migration `0203` makes the index cover
    live artifacts only). Publishing a slug another workspace already has
    public is a `409` `public_slug_taken`; an ambiguous public slug now
    resolves to the oldest artifact instead of an arbitrary one.
- **Approved skills now reach your agents, and learning notes became lessons
  that merge and expire** ([plan](docs/plans/learning-notes-and-skill-discovery.md),
  [reference](docs/SESSION-LEARNING.md#where-a-lesson-goes)). A skill you
  approve from a proposal is found for every role and for the root turn, with
  no assignment. A learning review writes at most two lesson notes, each a
  decision, constraint or fact, merged into the one that already says it; the
  Notes page shows how often a review saw it (`×N`), recall labels it
  `Lesson`, and the notes index no longer lists it.

  **Behaviour changes:**
  - **Lessons replace learning notes.** A note a learning review writes has
    `note_kind = 'lesson'`, is indexed under the purpose `lesson` and keeps its
    evidence in the frontmatter, not the body. The review is told to put a
    lesson in exactly one of memory, lesson note, skill or patch, and is shown
    up to 5 nearby lesson notes (`existing.notes`) to extend. A lesson that
    matches one is merged into it (`extends`, the same text, or by meaning at
    `learning.duplicateSimilarity` as a note; in the related band only if the
    background model agrees). A match the user archived drops the lesson; one
    expiry archived is revived; one consolidation merged away counts on the
    note it went into.
  - **Lessons are consolidated and expire.** The daily consolidation and
    **Consolidate now** merge near-duplicate lesson notes (a pinned one is
    never absorbed; at most 20 merge-model calls per run for lessons, and 20
    for proposals) and archive lessons that are not pinned and were neither
    updated nor shown to an agent for `learning.lessonTtlDays` (90). The first
    daily run after upgrading can archive old learning notes this way.
  - **Archived notes are no longer recalled or found by search.** Every
    knowledge search (`search_notes`, `search_knowledge`, the knowledge
    search API, link suggestions, recall) and the Recall page's has-rows check
    leave out an archived note's chunks; unarchiving needs no re-index.
    Browsing the knowledge base and reading an entry by id still show them.
  - **What counts as a read.** Re-indexing identical content no longer stamps
    `last_accessed_at`; the semantic-only search honours `skipAccess`; link
    suggestions and ghost-link resolution no longer count their candidates
    as read.
  - **Learned skills reach agents, including the root.** A user's own,
    non-system, non-archived skill with no `skill_topic_assignments` row is a
    candidate for every role of that user's specialists and swarm children:
    by trigger, or among the 5 nearest by meaning (cosine 0.35 or more),
    shared with assigned skills; never always-injected; not in a shared space.
    Without a query embedding the 10 most recently used are listed. The root
    turn gets a `# Learned Skills` index by the same rule. Approval embeds the
    skill at once. The query embedding is waited for at most 4.5 s.
  - **Discovery fixes for assigned skills.** Archived skills are no longer
    discovered; an assignment stored under a lane name (`build`) now matches
    by trigger, meaning and always-inject too; the result is ranked best
    first (triggers, then similarity), which changes the 8 candidates the
    decision model judges.
  - **Recall:** `lesson` is a recall purpose with a **lessons** checkbox on the
    Recall page, in the default. The notes index lists and counts only your
    own notes.
  - **Migrations.** `0200_lesson_notes` turns the notes learning reviews wrote
    (tag, `learning-` slug and `learningJobId`, personal or user level) into
    lessons and moves their embedding rows to `lesson`; bodies are not
    rewritten. `0201_archived_note_sources` adds a partial index over archived
    notes for the search filter. `0202_recall_lesson_purpose` adds `lesson` to
    every stored recall-hook `purposes` list that has `note`.

  **New settings:** `learning.lessonTtlDays` (90; 0 never archives) and
  `learning.maxLessonsPerReview` (2; 0 to 2). **API:**
  `POST /api/skills/proposals/consolidate` returns `notesMerged` and
  `notesArchived` as well; a learning receipt's `knowledge` output can have
  the status `merged`. The thresholds are not calibrated against real data,
  and the learning evals, which need a live model, were not run.
- **Provider failures are classified by what the provider said.**
  - A 429's `Retry-After` now reaches the retry backoff for providers on the
    OpenAI SDK (the proxy, custom OpenAI-compatible endpoints and others); it
    was dropped, so retries came sooner than the provider asked.
  - A reset connection, including one that drops mid-reply, is a network
    failure: retried with backoff and counted by the circuit breaker, no
    longer an unclassified abort. A transient DNS failure (`EAI_AGAIN`) is
    treated the same way.
  - A refused connection or an unknown host (`ECONNREFUSED`, `ENOTFOUND`) is
    a new `endpoint_unreachable` failure: the agent stops at once with a
    message to check that the model server is running and its endpoint URL
    is right, instead of retrying for about 14 s. It no longer counts
    against the circuit breaker its provider's other models share. This
    also applies to the plain-code errors that used to be retried as
    network timeouts.
  - A LiteLLM proxy stream that fails after its first chunk raises a
    classified error, and one the caller aborts ends as a cancellation
    instead of passing its partial text off as a finished answer. A
    cancellation is never counted against the proxy's circuit breaker.
  - Proxy embeddings are placed by `index`. A reply with the wrong number of
    vectors, or with repeated or out-of-range indices, fails as an invalid
    response instead of misaligning vectors with their texts.
  - A custom-provider model whose API key resolves nowhere fails once, as
    an auth failure that says where to put the key; it is not retried. A
    401 from the endpoint is unchanged.
  - OpenAI's `insufficient_quota` (sent as HTTP 429) is an exhausted quota,
    no longer a rate limit to wait out.
- **`/v1/chat/completions` passthrough streams token by token**
  ([API](docs/API.md#notes--limits)). With a registry model id on OpenAI,
  OpenRouter, Mistral, Grok, Moonshot, Meta, z.ai, Vertex or a custom
  OpenAI-compatible provider and `stream: true`, content chunks now leave as
  the provider produces them, verbatim, and concatenate to exactly the
  non-streamed `message.content`. Other providers (LiteLLM, Anthropic,
  Gemini, DeepSeek, Ollama, CLI, custom Anthropic/Gemini-compatible) filter
  their streamed and completed text differently, so they still answer with
  the finished text in chunks. An error before the first chunk is answered
  as the non-streamed path answers it (429 for a budget refusal, 400 for an
  unknown model, 500 otherwise) and is not retried; a client gone before the
  provider call gets 499 and no call is made; a disconnecting client aborts the provider
  call, except after the text is complete, when the usage chunk is still read
  (up to 2 s). A client that stops reading is dropped after the new
  `api.streamStallTimeoutMs` (default 60 s). `agent.streaming: false` turns
  it off. Agent mode (`octipus/agent`) still chunks the turn's final answer:
  the output guard and the other answer passes decide on the whole text, and
  SSE cannot take sent text back. Any streamed `/v1` response whose client
  goes away now releases what it held.
- **Streams cut off before their usage are accounted.** A provider stream
  that ended after it had started answering but before its usage chunk (its
  reader went away, it failed midway) recorded 0 tokens and unknown cost; it
  now records an estimate (prompt plus output so far, chars/4), marked
  `usageEstimated` in `cost_log` metadata ([limits](docs/SPEND-BUDGETS.md)).
  Routed streams also record their tokens in the provider's TPM window, as
  completions did; nothing enforces that window yet, and it is now pruned on
  every write so it no longer grows without bound.
- **PDF text: columns in reading order, tables as Markdown tables**
  ([docs](docs/DOCUMENTS.md#pdf--text-layer)).
  - A two- or three-column page is read column by column instead of line by
    line across the columns. A title, abstract, figure caption or footer that
    crosses the gutter is read in its place and splits the columns into bands
    above and below it. A gutter has to hold over at least three lines with
    text on both sides, and both sides have to read as prose, so a wide word
    gap on one justified line is not a gutter.
  - A table (three or more rows whose short cells line up per column on a
    left, right or centre edge) comes out as a Markdown table: header row,
    `---:` for a right-aligned column, empty cells kept, `|` escaped, a
    wrapped cell joined to its row when rows are spaced wider than lines.
  - A table with no header row is a table too, under an empty header row
    (`| | |`), when its grid is unmistakable: four or more rows, each with two
    or more cells, 80% of every column on one edge, and a column of numbers
    all the way down (both columns, for a two-column grid). Numbered lists,
    label/value lines (`Total  415.00`), contents pages and grids that only
    roughly line up keep their lines.
  - A table that runs onto the next page stays one table: rows at the head of
    the next page whose columns sit where the table's did continue it, with no
    header of their own (a single row only when it has a number in the
    table's column of numbers); a repeated header is dropped, and so is one
    page number at the foot and one at the head, recognised by position (set
    apart from the table and on none of its column edges). A number in a
    column, such as a total, is kept, and anything else between the halves
    (a running title) still splits the table in two; no other text is dropped.
  - A page where neither reading holds comes out exactly as before. Label/value
    forms, bullet lists and tables of contents keep their lines; a gutter
    under three glyphs wide needs six lines, not three; a page of over 10,000
    fragments (or a line of over 500) skips detection. Not handled: merged or
    spanning cells, tables whose columns do not line up or whose cells are
    long text, wrapped cells in tables without row spacing, columns that
    never share a baseline, rotated and right-to-left text.
  - Fixed: the gap between two runs of text on a line was lost on real PDFs,
    because pdfjs reports it as a whitespace item as wide as the gap; column
    and cell gaps came out as one space. Whitespace-only items no longer count
    as text, but still mark a space, so words either side of a font change
    (bold, italic, inline code) stay apart.
  - A Markdown table longer than one knowledge-base chunk (from a PDF or an
    `.xlsx` sheet) is split between rows, and each piece repeats the header
    row. It used to be cut as prose, which could split a row at a `. ` inside
    a cell and left every piece after the first without column names. The
    chunk size still holds: a row that does not fit under the header is cut
    like prose, and a header over a quarter of a chunk is not repeated (that
    table is cut like prose, as before). `.docx` tables are not affected:
    mammoth's Markdown output has no tables, so they arrive one paragraph per
    cell. Documents indexed before this keep their old text and chunks until
    they are uploaded again.
- **Skill export and import as signed JSON bundles** ([reference](docs/SKILL-EXCHANGE.md)).
  - Skills → **Export** downloads the chosen skills as one versioned bundle
    (`GET /api/skills/exchange/export`): content and metadata, a content hash,
    and no ids, owners, flags, triggers or usage data. A server export is
    unsigned and says so; `octi plugin sign-skill-bundle <file> --key <key>`
    signs it offline with a plugin publisher key.
  - Skills → **Import** takes an uploaded or pasted bundle, an agentskills.io
    `SKILL.md`, or (administrators) an https URL through the SSRF-guarded
    plugin download. `POST /api/skills/exchange/preview` shows every skill in
    full, the signature and each name collision and writes nothing;
    `POST /api/skills/exchange/install` writes only the previewed content
    hash, with an explicit skip, rename or replace for each collision, in one
    transaction, audited per skill.
  - Imports follow the plugin package trust settings: a revoked key or an
    invalid signature is always refused; with `plugins.requireSignature`, an
    unsigned bundle (or SKILL.md) or an unknown key is refused; a URL import
    needs a trusted signature. A bundle naming a privileged field
    (`isSystem`, `userId`, `alwaysInject`, `triggers`, …) is refused.
  - **Breaking — removed `POST /api/skills/import`.** It wrote unsigned skills
    without a preview, a trust check or an audit row, and overwrote by name on
    `overwrite: true`. Replaced by `POST /api/skills/exchange/preview` and
    `/install`, which also read what the unchanged `GET /api/skills/export` and
    `GET /api/skills/:id/export` write: their JSON (as `bundle`; unsigned,
    fields other than a skill's content dropped and named) and their
    multi-skill markdown (as `skillMd`). What changed: a name collision needs
    an explicit skip, rename or replace instead of `overwrite`; collisions
    follow the caller's own visibility, so an administrator can no longer
    overwrite another user's private skill by name; with
    `plugins.requireSignature` these unsigned files are refused.
  - Text fields refuse control characters other than tab and line breaks
    (NUL used to pass and fail at the database). Frontmatter values that are
    lists or mappings are no longer turned into strings when a SKILL.md is
    mounted or imported (nested YAML aliases made that exponential).
  - Not built: a hosted registry, browsing community skills, ratings,
    automatic updates.
- **Pipelines: a missing QA verdict block is repaired, and the repair no longer
  spends a retry** ([reference](docs/AGENT-ARCHITECTURE.md#qa-retry-loop),
  [status](docs/plans/quality-loop-status.md)).
  - A QA stage that writes its report but leaves out the `json` verdict block
    is asked for the block alone. So is a pass that accounts for every stage
    and every acceptance criterion but leaves out `whatIDidNotCheck` or
    `confidence`. The auditor gets its own report back and runs nothing.
    This takes no retry edge and has its own bound of 2 per audit round. If the
    block is still unusable after that, the pipeline stops as failed at that
    stage, as before.
  - Everything else still gets a full re-audit on the stage's `maxRetries`: a
    pass that skips a stage in scope, any acceptance-criterion fault (a
    missing entry, a met entry with no evidence, a non-json pass on an item
    with criteria), and a pass whose own prose says FAIL.
  - Previously a pass missing only `whatIDidNotCheck` or `confidence` caused
    a full re-audit, and a missing block used up the auditor's `maxRetries`.
  - The verdict parser accepts a `JSON`/`jsonc`/`json5`/`js`/untagged fence
    and prose after the block. An unfenced object inside prose is still not
    read as a verdict, and no missing field is filled in.
  - `audit_coverage` evidence rows carry `detail.fault` (`report` or
    `coverage`) and, on a repaired reply, `detail.repairAttempt`. A repair
    visit's `spawn` run event has a `startReason` starting with
    `verdict_repair n/2`.
  - `scripts/run-health.ts` no longer counts replies with no readable verdict
    (`source: unparseable`) as rejected passes; it reports them on a separate
    "no verdict" line. Over a window that includes such rows, the rubber-stamp
    rate will read lower than before. A parsed pass rejected for leaving out
    `whatIDidNotCheck` or `confidence` still counts as rejected, and is also
    shown as its own sub-number.

- **Recall: shown when it qualifies, everywhere an agent starts, and measured
  by whether it was used** ([plan](docs/plans/recall-hardening.md),
  [reference](docs/CONTEXT-HOOKS.md)).
  - Context hooks now run for every agent start on a user's task: swarm
    children, plan runs, side questions, agents spawned by a hook or
    `POST /api/agents`, and a live agent's new task sent by its owner
    (`POST /api/agents/:id/message`), as well as root turns and specialists.
    The voice planning reply and retry respawns are exempt, with the reason
    in the docs. A direct spawn and a side question choose their model after
    the hooks, so a level 3-4 passage puts them on a local model or refuses
    with the reason.
  - A passage is shown when it is similar enough, covers most of the
    message's distinctive words, or contains an identifier from it (an
    invoice number, a version, an error code; not a year, time, amount,
    date, or a two-digit key like `OCT-42`); a keyword match no longer
    bypasses the bar. A short follow-up ("Enterprise?", "and for
    enterprise?") is searched on its own first; only free slots are filled
    from a search together with the previous typed message, with passages
    that hold the new message's own words. An acknowledgement ("ok",
    "thanks", "yes please") is never searched. A long message keeps its head
    and its tail. The keyword search ORs at most 16 lexemes and filters
    purposes, product docs and at most three chunks per source in SQL.
  - Hooks end 4 s after a start began and committing what they show by
    4.5 s; on Postgres the search statement is cancelled at the deadline.
  - A passage still in view from an earlier turn is not sent again. Raising
    the session's protection level and counting accesses happen only for
    passages actually shown; for a specialist or swarm child the access is
    counted once the agent has started.
  - **Indexing:** a paragraph longer than a chunk is split, so new chunks are
    at most 1000 characters. Chunks indexed earlier keep their size until
    reindexed.
  - **New recall settings** `keywordCoverage` (0.6) and `maxGap` (0.15).
    **Defaults changed:** the recall block's `tokenBudget` is 1200 (was
    700) and `excerptChars` 1000 (was 700), the indexers' largest chunk, so
    a chunk is shown whole and the default four passages fit.
  - When the query cannot be embedded, recall runs on its keyword rules and
    the run is marked `embedding_failed`.
  - **Measurement:** the stats show "used" beside "named": an answer uses a
    passage when it repeats a number, code or uncommon word from it that the
    question did not hold. Numbers are compared by value in either
    convention (`1.000` and `1,000` are 1000, `$5.00` is 5 and no evidence);
    list numbers, round percentages and times on the quarter hour are no
    evidence; text is compared NFC-normalised. "Named" matches titles on
    word boundaries, counts recall passages only, and not a title made of
    the question's own words. Both rates count only turns that ended with an
    answer; failed, cancelled and cleared ones are shown apart. Per hook:
    keyword-only runs, blocks dropped for the shared budget or a failed
    commit, and the rule passages were shown on; the average best match
    leaves out keyword-only passages. Numbers per event (root turns apart
    from agents started on a task). A calibration warning when a passage
    cleared a recall hook's `minSimilarity` on 95% or more, or 5% or fewer,
    of at least 30 searched messages at its current value; runs recorded
    before the bar was, and an empty knowledge base, give none.
  - **Threshold sweep:** `POST /api/context-hooks/eval/sweep` runs the eval
    at `minSimilarity` 0.20 to 0.80 and recommends a value; the Recall page
    applies it in one click.
  - **Recall page:** a context note is picked from your notes instead of
    typed as a slug; every recall setting is editable, the numbers with
    their default shown, what it searches (`purposes`, the Octipus manual)
    as checkboxes.
  - **Migration 0199** adds the nullable `context_turns.used_items`. Older
    rows stay readable and are left out of "used". A recall run's jsonb
    record gains `bar` (no migration). The row still stores no message,
    passage or answer text.

- **Terminal editor: a chat message sent while disconnected is reported.** The
  editor's chat pane showed it as sent and the gateway never got it; it now
  says the message was not sent.
- **Terminal clients start faster.** `octi edit` drew its first frame after
  about 2 s and now after about 0.5 s: it no longer loads the MCP bridge
  (some 200 server modules) at start, only when the MCP list (`/mcp`) is
  opened; the status row's MCP count appears from then on, as it effectively
  did before. `octi tui` and `octi edit` are launched with Node directly
  instead of through `npm run`, which saved about 0.4 s more, and the stored
  login no longer loads the server logger. Measured in a PTY on a loaded
  container, from `bin/octi`'s launch command to the first full frame: chat
  0.9–1.0 s → 0.5 s, editor 2.0 s → 0.55 s. `bin/octi.cmd` on Windows still
  goes through npm.
- **Terminal clients refuse a terminal they cannot draw on.** With
  `TERM=dumb` (an Emacs shell buffer, a CI log), or with input or output
  piped, `octi tui` and `octi edit` exit with status 2 and say why, instead
  of filling the output with escape sequences.
- **Terminal compatibility documented and tested.** `docs/guides/tui.md`
  has a "Terminal compatibility" section: tmux (with recommended `mouse`,
  `set-clipboard` and `allow-passthrough` settings), SSH, the Linux console,
  small windows, Windows, screen readers, and what is not tested. Contributors:
  the terminal suites fail at once with a message when the PTY relay's Python
  is missing (`TUI_PTY_PYTHON` picks another), and golden screens
  (`tests/tui/goldens/`, `UPDATE_TUI_GOLDENS=1`) guard the main states of both
  clients.
- **Terminal editor: failures it used to swallow are now said.** A folder that
  cannot be read shows `⚠ cannot read this folder: …` in the tree and is named
  in the file picker; the fallback project search says how many files it could
  not read, and its preview why one could not be shown; a corrupt saved state
  or a failing recovery checkpoint, a tree-sitter module or grammar that did
  not load (highlighting falls back to the line highlighter), and an
  unavailable MCP status are written to the transcript once each; a gateway
  URL that is not a URL is refused instead of replaced by `localhost:3005`. A
  file removed since it was listed, or a dangling symlink, is still skipped
  quietly.
- **Terminal editor: a paste into a tab under agent review says it was not
  pasted.** It used to vanish silently; the bottom bar now says the review has
  to be finished first.
- **Terminal editor: `/delete <path>` deletes that path, and paths keep their
  spaces.** `/delete` ignored its argument and offered to delete the active
  tab's file instead; `/rename` and `/save-as` collapsed a run of spaces in
  the path to one. The argument is now everything after the command name, as
  typed.
- **Terminal editor: project search results keep non-ASCII text intact.**
  ripgrep's output was decoded one chunk at a time, so a character split
  between two chunks showed as `��` and shifted the match highlight. The
  output is now decoded as one stream.
- **Terminal editor: saving keeps a file's owner and works in read-only
  folders.** The atomic save renamed a temporary file created by you over the
  original, so a file owned by another user or group (a shared file, one
  edited under sudo) changed owner, and a writable file in a folder you cannot
  write to could not be saved at all. The temporary file now takes the
  original's owner and group; where that is not allowed, or the folder refuses
  the temporary file, the file is written in place.
- **Terminal editor: opening a named pipe or a device no longer hangs it.**
  The editor read whatever path it was given, so a FIFO blocked it until
  something wrote to the pipe. Anything that is not a regular file is now
  refused with the reason.
- **Terminal editor: vim mode edits the text vim would.** `yyp` put the line
  at the cursor instead of below it; `$` left the cursor after the last
  character, so `$a` appended on the next line; `x` at the end of a line
  joined it with the next; and VISUAL `d` / `y` left out the character under
  the cursor. The NORMAL cursor now stays on the line's last character,
  line-wise registers go below the line, `x` never joins lines, and VISUAL
  selections are inclusive.
- **Terminal editor: very long lines stay responsive.** With soft wrap on, a
  long line (a minified bundle, a JSON log line) was broken into rows again
  for every visible row and every cursor or scroll step: a 200 KB line took
  about 25 seconds to draw and move through. Rows are now cached per line text
  and width, and a line over 2,000 characters is highlighted and styled only
  where it is on screen, with or without wrap.
- **Terminal editor: escape sequences in file names stay text.** A file named
  with ESC, OSC or BEL bytes reached the terminal through the tab strip, the
  unsaved-changes prompt and the rename / Save As fields prefilled with its
  path, so a file name could change the window title, clear the screen or ring
  the bell, and its tab's clickable `×` drifted. Tab labels, prompt labels and
  errors are drawn without escape sequences, and text fields show control
  bytes as pictures (`␛`, `␇`).
- **Terminal editor: auto-reload no longer grows memory without bound.** Every
  reload of a changed file kept a full copy of the old and new text in the
  undo history (up to 200 steps), so a log file appended to every second could
  take hundreds of MB. A reload now records only what changed, the undo
  history is capped by size as well as by steps, and the watcher reads a
  changed file once per check instead of three times.
- **Terminal editor: a rejected agent edit stays rejected.** The agent's edit
  reaches the editor before the tool writes the file, so after you rejected it
  the watcher saw the file change a moment later and reloaded the agent's
  version into the clean tab. Now, when the file becomes the text you
  rejected, the tab keeps your version, unsaved against the new file, and says
  so.
- **Terminal editor: accepting an agent edit no longer reverts your unsaved
  changes.** The review compared the buffer with the agent's whole file, which
  was written against the file on disk, so your unsaved edits showed as hunks
  and accepting everything undid them. The review is now three-way: only the
  agent's changes are hunks, your edits are kept, a change over lines you
  edited is marked as a conflict (`!`) and starts rejected, and the tab stays
  unsaved while it differs from the file.
- **Terminal editor: fragment edits by the agent are reviewed.** A
  `str_replace_editor` `str_replace`, or an `edit` with `old_string`, reached
  the editor as an edit of one fragment and was dropped. It is now applied to
  the text the agent works from (its waiting edit, the open tab, or the file
  on disk) and reviewed hunk by hunk like a whole-file write; a fragment that
  is not in the file, or occurs more than once, is reported instead of
  guessed.
- **Terminal editor: background prompts no longer take the keyboard.** A file
  changed on disk under unsaved edits and an agent edit ready for review used
  to open their prompt at once, switching tabs and taking focus mid-typing, so
  the next keystroke (`r`, `o`, `a`) picked reload, overwrite, accept-all or
  reject-all. Both now wait: the mode bar shows `⚑ … — press alt+y to
  resolve`, and the prompt opens on `Alt+Y` (`app.pending.open`) or when you
  save that tab. An agent edit to a file that is not open opens it in a
  background tab. Prompts you open yourself (Ctrl+S on a changed file) work as
  before.
- **Terminal editor: Save As no longer leaves two tabs sharing one identity.**
  Saving `a.ts` as `b.ts` and then opening `a.ts` again gave both tabs the
  same internal id, so Ctrl+S in the `a.ts` tab wrote `b.ts`, closing one tab
  closed the other and highlighting mixed the two files. Every buffer now has
  an id of its own that never follows its path.
- **Terminal editor: review the agent's edits hunk by hunk.** The diff box
  accepts (`y`) or rejects (`n`) each change on its own, moves between them
  with `]` / `[`, folds unchanged lines (`z`), highlights the words that
  changed inside a line, and applies with Enter (`a` / `r` still take or drop
  everything). An edit to a file that is not open opens it in a tab for review
  instead of going by unseen. A CRLF file is compared without its CRs and saved
  CRLF. If the file also changed on disk outside the agent while you review,
  saving asks before overwriting it — the editor used to take that version as
  saved. Large files are compared with a bounded Myers diff; one too changed to
  compare line by line is shown as a single replacement and says so.
- **Terminal editor: the mouse works.** Click to place the cursor, drag to
  select (the copy is the file's text, without line numbers or the tree),
  double-click a word, triple-click a line, Shift+click to extend. Click a tab
  to switch to it and its `×` to close it, a tree row to open a file or expand
  a folder, a pane's title to focus it; drag a divider to resize the side
  panes; the wheel scrolls the pane under the pointer whatever has the focus;
  the editor's scrollbar takes clicks and drags. A drag in the chat pane copies
  only the chat's text.
- **Terminal editor: navigation and editing basics.** PageUp/PageDown,
  Ctrl+Home/End, Shift with any motion to select, Ctrl+X / Ctrl+V (and Ctrl+C
  on a selection) through the clipboard, `Ctrl+G` or `/goto` to go to a line,
  soft wrap (`Alt+Z`, `/wrap`, remembered per project), a scrollbar, Enter that
  keeps the indentation (one step deeper after an opening bracket), the
  matching bracket highlighted, and three lines kept around the cursor when it
  moves.
- **Terminal editor: search and files.** Replace one match at a time
  (`Alt+Enter` in the replace box, with a preview of the current match) as well
  as all at once; search the whole project (`Ctrl+Shift+F` / `Alt+G`,
  `/search`), with ripgrep when installed and the project index otherwise, a
  preview of each match, and Enter to open it. New file (`Alt+N`,
  `/new-file`), rename (`/rename`), delete with confirmation (`/delete`), and
  reload from disk (`/revert`); in the tree `n`, `m` and `d`. Open files are
  watched: a file changed on disk is reloaded when you have no unsaved edits,
  and you are asked when you have.
- **Terminal editor: C1 control characters in a file are shown.** U+0080 to
  U+009F (such as U+009B, which terminals treat as the start of an escape
  sequence) were written to the terminal as they were; they are drawn as
  `�` now. Found by the new invariant suite for the editor
  (`tests/tui/editor-invariants.e2e.test.ts`).

- **Terminal chat: stop, queue, fold, search, pick, notify, theme, link.**
  `Esc` stops the running turn (twice with none running clears the draft).
  A message sent while a turn runs waits above the composer — `Alt+E` or a
  click takes it back to edit — and goes out as its own turn when the turn
  ends; before, the gateway steered it into the running turn. A turn's tool
  calls are one collapsed row with counts, failures and time; a click or
  `Ctrl+O` shows every call's arguments, full output and edits as diffs.
  Reasoning before tool calls is a folded "Thinking" row, and the per-call
  "<role> arm · …" lines are gone. Replies render as Markdown while they
  stream, without the jump at the end. Transcript search (`Ctrl+F`, also
  `Ctrl+Shift+F`, `/search`) now returns to where you were on `Escape`;
  `Ctrl+R` searches what you sent. `/sessions`, `/resume`, `/skills` and
  `/theme` alone open pickers (the text forms still work), and the command
  palette is the same fuzzy list with a preview. While the terminal is
  unfocused, a finished turn or a waiting decision notifies (bell, OSC 9 or
  OSC 777: `notify` in `~/.octipus/tui.json`), and the window title shows
  idle / working / waiting. Themes: `auto` follows the terminal background
  (OSC 11), plus `light` and `high-contrast`, `NO_COLOR` honoured, `/theme`
  saves the choice; the dark border and four light colours changed to reach
  WCAG contrast. URLs and `path:line` references are OSC 8 links where the
  terminal shows them (`http`, `https`, `file` only), and attached images are
  drawn inline on Kitty-graphics terminals (iTerm2 with `--inline`).
  `Ctrl+F` no longer moves the composer's cursor right (Right does).
  `Alt+C` / `/copy code` copies the latest reply's last code block.
- **Gateway: `session.plan_updated`.** Every save of a session's work plan
  (agent tools, `/plan-feedback`, the web's feedback route) publishes
  `session.plan_updated` (`{ revision }`) to the owner's connections. The
  terminal clients refresh their plan summary on it instead of asking every
  4 seconds. The gateway client gains `stopAgent` and an optional send mode
  on `sendChat`.
- **Terminal editor: an agent's `str_replace` edit no longer offers to
  replace the whole file with the fragment.** The chat adapter reported
  `str_replace_editor`'s `new_str` as the file's new text, so the editor's
  diff showed the file reduced to the replacement. A fragment edit is now its
  own event (`agent.edit`: old and new fragment), which the editor does not
  review yet; `create` (`file_text`) and whole-file writes are reviewed as
  before.
- **Terminal chat and editor run on the alternate screen; drag selects
  without Shift.** `octi tui` and `octi edit` now open on the terminal's
  alternate screen. What you had in the terminal before launch survives —
  resizing no longer erased it (`ESC[3J`) — and quitting restores the screen
  instead of leaving a dead frame behind. In the chat the transcript scrolls
  in the app with the composer and status pinned below it; dragging selects
  transcript text (without the rail) and copies it on release, the wheel
  scrolls with nothing held, Shift+drag (Option+drag in iTerm2) still gives
  the terminal's own selection, and `Ctrl+Shift+F` searches. Copying goes
  through a chain — `pbcopy` / `clip.exe` / `wl-copy` / `xclip` / `xsel`
  locally, the tmux buffer in tmux, OSC 52 otherwise — and says which one was
  used, or that none worked. On quit the last exchange and
  `octi tui --session <id>` are printed. New: `/export [path]` (Markdown),
  `/scrollback` and `Alt+O` (the transcript in the terminal's own scrollback),
  `--inline` (the previous main-screen drawing), and the `tui.mouse` setting
  (`app` | `native` | `off`, in `~/.octipus/tui.json` or `--mouse`). Long
  sessions render only the newest 200 messages and keep at most 5,000 in
  memory, with a notice when older ones were dropped.
- **pi-tui moved to `@earendil-works/pi-tui` 1.6.0.** `@mariozechner/pi-tui`
  is deprecated upstream; its maintained successor is pinned to an exact
  version. It ships small prebuilt native helpers (clipboard reads, modifier
  keys) for macOS, Windows and Linux/X11; Octipus does not call them, pi-tui
  loads the macOS/Windows one only to tell Shift+Enter apart in Terminal.app
  and to enable VT input on Windows, and nothing on Linux or in the Docker
  image loads one. `chalk`, which the terminal theme always used but only got
  through the old package, is now a declared dependency.
- **Terminal editor: saving is safe, and unsaved means unsaved.** Saving
  writes a temporary file and renames it over the original, keeping its
  permissions, its line endings (a CRLF file stays CRLF) and its byte-order
  mark. If the file changed on disk since you opened it, Ctrl+S asks whether
  to reload it, overwrite it or cancel instead of silently replacing the other
  version. A file that is not UTF-8 is refused with the reason rather than
  opened and rewritten. Scratch buffers can be saved: Ctrl+S asks for a path,
  and F12 or `/save-as` saves any buffer under a new name; `/new` opens a
  scratch buffer. The unsaved marker compares the buffer with what was saved,
  so undoing back to it clears the marker.
- **Terminal editor: emoji and accented letters edit as one character, and
  undo undoes what you did.** Backspace after an emoji no longer leaves half of
  it, and the arrow keys no longer stop inside a flag or a letter with its
  accent. Ctrl+Z undoes a typed word, a paste or a replace-all in one step; a
  replace-all with more than 200 matches used to be impossible to undo fully.
- **Terminal editor: vim mode can be switched on, and you can see what you
  select.** Alt+M or `/vim` switches vim mode; the bottom bar shows the mode
  and the `:` command being typed, and `:w`, `:q`, `:wq` and `:qa` work. Ctrl+S
  saves in NORMAL mode. Escape works with the kitty keyboard protocol. The
  selection is drawn, so VISUAL mode is visible.
- **Terminal editor: find shows its matches.** Matches are highlighted in the
  file, the search starts at the cursor, and Esc puts the cursor back where it
  was (Alt+Enter keeps it on the match). Find, replace and the file filter take
  paste, emoji and input-method text. Regex replace understands `$1`. Tab
  inserts what the file indents with.
- **Terminal editor: the file picker finds every file.** It lists the project
  with `git ls-files` (so `.gitignore` is respected) or a folder walk, in the
  background, and ranks all files by fuzzy match; it used to stop at the first
  1,000 names in alphabetical order.
- **Terminal editor: smaller fixes.** An agent edit to a file named relative to
  the project now reaches its open tab, and after rejecting an edit the agent
  already wrote to disk the tab shows as unsaved. Syntax colours follow edits.
  The diff box fits short terminals without skipping lines when paging. Opening
  the workspace or MCP list twice quickly opens it once, and a server that does
  not answer the workspace list times out after 5 seconds with the reason shown.
- **Terminal chat and editor: the composer no longer vanishes during a turn.**
  A tool call whose preview spanned lines (a multi-line shell command, a
  carriage return or tab in a result, an escape sequence in tool output) was
  painted as one row but took several, so the bottom of the screen — the input
  line and status — scrolled out of the window until the turn ended or the
  window was resized. Text from the model, tools and the server is now reduced
  to printable text before it is drawn, one rendered row is always one
  terminal row, and escape sequences in tool output can no longer reach your
  terminal. An agent question that spans lines shows every line in its box.
- **Terminal editor: Up and Down keep their column, and odd bytes in a file are
  shown.** Moving onto a shorter line used to skip a line (Down) or stay put
  (Up); the cursor now lands at the end of the shorter line and returns to its
  column on the next long one. A control byte in a file — the `\r` of a CRLF
  file, an escape sequence in a captured log — is drawn as its control picture
  (`␍`, `␛`) instead of being sent to the terminal, where it corrupted the
  screen. The file itself is unchanged.
- **Terminal chat and editor: a crash no longer leaves your shell broken.**
  The terminal was restored only on Ctrl+C and SIGTERM. After an uncaught
  error, an unhandled promise rejection, a plain `process.exit` or a hangup
  the shell stayed in raw mode with mouse reporting on and no cursor — every
  click printed an escape sequence and typing did not echo. Every exit path
  now turns mouse reporting off, shows the cursor and leaves raw mode first,
  then prints the error and exits non-zero.
- **Terminal chat and editor: pop-up boxes get the same guard as the main
  screen.** Every box — prompts, the command palette and the editor's file
  picker, find, diff and other boxes — is drawn one terminal row per row and
  cut to its width, so a control byte in what it shows cannot break the frame.
- **Terminal chat and editor: a long agent question fits on the screen.** A
  question taller than the window pushed the choices and the keys to answer
  off the bottom and covered the status line. The question now scrolls inside
  its box (Up/Down), and the choices, the keys and the status line stay
  visible; no box is drawn taller than the screen.
- **Terminal chat: `/copy` copies the reply as it arrived.** Since the
  composer fix a copied reply had its tabs turned into spaces and its line
  endings and escape sequences altered — the screen's cleaned version. It now
  copies the original text.
- **Terminal chat and editor: emoji sequences no longer shift the frame.** An
  emoji family, a skin tone or a flag made of joined pieces is measured as two
  cells, but most terminals (xterm, GNOME Terminal and other VTE terminals,
  tmux) draw every piece — so the row wrapped. Such sequences are now drawn as
  their separate emoji (👨‍👩‍👧 as 👨👩👧, 👍🏽 as 👍), and invisible format
  characters (variation selectors, soft hyphens, bidi controls) are removed
  from displayed text. `/copy` still copies the original.
- **Interactive answers as views: forms, tables and charts that answer back**
  ([spec](docs/plans/inline-ui-views-spec.md), [reference](docs/INLINE-UI.md)).
  - An interactive answer can now be a *view*: JSON naming ready-made
    components (choices, text fields, sliders, sortable tables, charts,
    stats, steps) that the web app draws itself. No generated code runs, so
    it never waits for a click, and a button sends the user's answer back to
    the agent as their message, with the values. The answer is kept on the
    message (`metadata.inlineUiAction`) and on the block (`state`). HTML
    blocks stay for free-form visuals.
  - The root prompt's section is rewritten to say when to use one (a choice,
    several items with several attributes, numbers over time, a result that
    depends on inputs, a process) and is no longer filed under guardrails in
    the Context inspector. The delegation guide and the output-formatting
    rules no longer contradict it.
  - **New setting** `agent.interactiveAnswers` (`AGENT_INTERACTIVE_ANSWERS`):
    `auto` (default), `prefer`, `off`.
  - Channel replies, monitors, the group bridge, hook notifications, room
    notifications, `/api/chat` without `renders` and the OpenAI-compatible
    API show a view as text instead of the one-line placeholder.
  - **Wire and API:** `chat.send` / `room.post` take `inlineUi.action`
    (`{ blockId, name, componentId, context, data? }`); an answer that fails a
    check is refused (`INVALID_MESSAGE`; rooms `INVALID_INPUT` / 400); a
    `data` over 16 000 characters is not a refusal (the view's own data is
    stored). A room post that answers a view needs the `api:chat` token
    scope, as an addressed post does.
    `GET /api/sessions/:id/inline-ui/:blockId` adds `kind`, `view`, `state`;
    promoting a view answers 409. `inline-ui__source` adds `kind`.
  - **Migration** `0198_inline_ui_views` adds `kind` (default `html`), `view`
    and `state` to `inline_ui_blocks`.
  - **Logs:** one `Interactive answer offer` line per root turn that was
    offered interactive answers (`used`, `kinds`, `refused`, `setting`).
  - `eval/inline-ui.yaml` gains ten unprompted positives and four view
    negatives (live-model suite; not yet run).
- **Fix:** the calendar list kept for two minutes is dropped when an account
  is connected, disconnected or made the default, so events and edits no
  longer use the new default's token on the old default's calendars.
- **Fix:** "All events" of an all-day series now applies a changed last day to
  every occurrence (Google and Microsoft) instead of answering success and
  dropping it; a Microsoft all-day occurrence is no longer refused as moved to
  another day in zones ahead of UTC.
- **Fix:** an existing event that does not repeat can be given a repeat rule
  (`PATCH /api/calendar/events/:id` with `recurrence`).
- **Fix:** listing accounts, "Make default" and disconnecting no longer write
  back a refresh token and expiry superseded by a refresh made a moment
  earlier.
- **Fix:** routes declaring a `format: 'uuid'` field (email unsnooze and
  dismiss, note proposals filtered by note) refused every request with 422:
  the format was never registered with the validator.
- **Fix:** files uploaded for a mail and never sent are now dropped from
  server memory once their hour is up (a periodic sweep), not only when the
  same user uploads or sends again.
- **Fix:** a snooze that moves only some messages of a conversation marks only
  those as handled; the ones left in the inbox stay in the heartbeat's inbox
  watch.

- **Fewer, merged skill proposals** ([plan](docs/plans/self-learning-consolidation.md),
  [reference](docs/SESSION-LEARNING.md#the-life-of-a-skill-proposal)).
  - Skills → Proposals shows one proposal per topic: a new suggestion on the
    same topic is merged into the open one by the background model ("seen N×
    in M sessions", a diff of what the merge changed). A learned proposal is
    shown once it recurs in a second session or comes from your correction;
    until then it waits under **Not shown yet**, with **Show now** and
    **Reject**. The list is sorted by how often a proposal was seen.
  - **Consolidate now** merges the existing backlog (also run daily),
    **Reject selected** rejects many at once, **Merge into…** merges two by
    hand, and a card says when a live skill is similar. `/proposals` shows
    `×N` for a proposal seen more than once and lists oldest shown first, so
    a proposal keeps its number for `/proposals approve <n>`.
  - Learning checks read only the execution evidence since the session's
    last reviewed check (a failed or skipped check does not count), are shown the nearest skills and open proposals, and are
    asked to extend or patch those rather than file a new skill.
  - **Behaviour changes and new defaults:**
    - Automatic checks run after 40 tool results instead of 10
      (`learning.reviewEveryToolCalls`), and at most every 30 minutes per
      session (`learning.minReviewIntervalMinutes`).
    - A learned skill proposal seen once is a hidden candidate, not a pending
      proposal (`learning.recurrenceSessions` = 2). Candidates never seen in
      a second session and not seen again within 30 days are deleted.
    - At most 2 learned proposals become pending per user per 24 hours, and
      none while 10 are pending. `distill_skill` and patches are not held
      back; a `distill_skill` result that matches a candidate shows it.
    - Two proposals that are only related (similarity 0.70–0.85) are merged
      only when the background model says they are one skill; without a
      usable model they stay separate.
    - Rejecting a proposal now also suppresses differently named proposals
      with the same meaning (with an embedding model), and rejects the
      proposals merged into it.
    - Skill and proposal embeddings are computed by the server; the
      `db:backfill-skill-embeddings` cron is no longer needed.
    - **The skill curator now runs daily** (it was never scheduled), first
      about a minute after the server starts. Across all users it archives
      every non-system skill without an owner-edit lock that was last loaded
      more than 90 days ago, or, if never loaded, created more than 90 days
      ago. There is no unarchive in the API or the UI.
    - Migration `0197_skill_proposal_consolidation`: statuses `candidate`
      and `merged`; columns `embedding`, `source_refs`, `signal`,
      `previous_draft`, `merged_into_id`, `surfaced_at`. Existing pending
      proposals stay pending.
  - New routes: `POST /api/skills/proposals/bulk-reject`, `/:id/merge`,
    `/:id/surface`, `/consolidate`; `GET /api/skills/proposals` takes
    `?include=candidates`, adds `candidateCount`, sorts by `exemplarCount`
    then oldest (was oldest first) and serves a view of each row (new fields,
    no `rejectedUntil`); approve and reject accept candidates.
  - New config keys `learning.minReviewIntervalMinutes`,
    `recurrenceSessions`, `maxSkillProposalsPerDay`,
    `maxPendingSkillProposals`, `duplicateSimilarity`, `relatedSimilarity`,
    `candidateTtlDays`. All nine `learning.*` keys, including the existing
    `reviewEveryToolCalls` and `localIdleMs`, are now settings: Settings →
    Configuration → Agent & Root agent → Learning, or
    `PUT /api/settings/learning.<name>`; changes apply without a restart
    ([CONFIGURATION.md](docs/CONFIGURATION.md#learning-config)).
- **Email is a mail client** ([plan](docs/plans/email-calendar-ux.md)).
  - Folders, list and reading pane; conversations; search; bulk actions with
    undo; compose, reply all and forward with a two-step send; attachments;
    keyboard shortcuts. The page frame renders at once.
  - Mail HTML is drawn in a sandboxed, always-light frame.
  - Outlook is reachable with Google connected, and "All inboxes" merges both.
  - **"Triage inbox" shows what it will do first**: which mails, the
    categories, what the models are told, who answers and what happens
    afterwards. It then runs in the background with progress and cancel, and
    lists the mail it proposes to archive. Your own instructions can be saved
    and are given to both models.
  - **Behaviour changes:** triage settings are stored per user on the server,
    and both "label in the mailbox" and auto-archive start off (the earlier
    per-browser choices are not carried over). Changing categories or
    instructions restarts the decision model's calibration.
  - New routes: `/api/email/accounts`, `/messages`, `/thread/:id`,
    `/messages/batch`, `/message/:id/attachment/:id`, `/triage/settings`,
    `/triage/preview`, `/triage/run`. The older routes still work.
- **Writing in Gmail and Outlook:** attachments (20 files, 25 MB), forwarding
  keeps the original's files, a formatting toolbar (text and HTML). **Snooze**
  takes a conversation out of the inbox until a chosen time; a Snoozed folder
  lists it. Migration `0195_email_snooze`, job `email-snooze`.
- **Several accounts of one provider.** Settings → Integrations → **Add another
  account** connects a second Google or Microsoft 365 account; each is its own
  mailbox and has its own calendars, and "All inboxes" merges them. **Make
  default** picks the account agents and the heartbeat use. Mail routes and
  calendar writes take an optional `account`.
- **IMAP/POP3 mailboxes in the mail window**, with summaries, AI drafts and
  triage (with protection on, mail at level 3–4 reaches local models only).
  `/mail` is the same window with IMAP mailboxes only.
- **Triage over All inboxes** in one run, and **automatic triage** (opt-in) of
  new mail every few minutes, at most 20 mails at a time. Every run uses the
  bound models.
- **Local index of Gmail and Outlook headers.** Lists, search and the unread
  count open at once from an index of the default account's last 90 days of
  headers (sender, recipients, subject, date, folders, flags, the 300-character
  preview). Bodies and attachments are never stored. On by default; turned
  off in the Email page's mailbox settings, which deletes it. Migration
  `0196_email_index`, job `email-index`.
- **Calendar is a calendar.** Week, day, month and agenda views; overlapping
  events side by side; an all-day lane; an event card with Join, RSVP, Edit and
  Delete; create by clicking or dragging, move by dragging; keyboard shortcuts.
  - **Shared calendars.** Every calendar of a connected Google or Microsoft 365
    account can be shown or hidden; the choice is stored per user. Read-only
    calendars refuse writes.
  - **Microsoft 365 users reconnect once** to open calendars shared with them
    (new `Calendars.ReadWrite.Shared` permission; tenants without user consent
    need admin approval). Their own calendars are unaffected.
  - **Behaviour change:** the per-save confirmation tick is gone. Changing or
    deleting an event with guests needs `notifyAttendees: true` (409 with the
    guest count otherwise).
  - **Editing is complete:** drag-resize, dragging on touch, all-day and
    across midnight; repeating events (create; change "This event" or "All
    events"); reminders; guests and description on edit; "Find a time" from
    everyone's busy time; up to 2,500 events per calendar and range.
  - The heartbeat's upcoming-event check and the meeting import follow the
    calendars shown on the Calendar page.
  - **Behaviour change:** on `PATCH /api/calendar/events/:id`, `attendees`
    now replaces the guest list (it was ignored on edit).
  - Fix: Microsoft all-day events land on their own date in any timezone.
  - OAuth connections record the scopes the provider granted, not the ones
    asked for.
- **Email and calendar fixes** (phase 0 of [the email and calendar plan](docs/plans/email-calendar-ux.md)).
  - Gmail mail with an attachment showed only its snippet; the body is now
    found at any MIME depth, and HTML-only mail renders as HTML.
  - A reply sent from the Email page joins its conversation: `POST /api/email/send`
    takes `replyTo`. An Outlook reply keeps the original subject.
  - Remote images in mail are not loaded until **Show images** is chosen.
  - Triage results survive a reload: `/api/email/inbox` returns the stored
    triage with the list (migration `0194_email_triage_result`).
  - **Behaviour change:** auto-archive on triage is off until turned on. It
    was on by default; anyone relying on that ticks the box once.
  - Calendar shows the reader's week (not seven days from today) and readable
    end times.

- **Codemode boundary hardening.** Bounded default and error output, fixed zero-output requests, rejected malformed arguments and misplaced options before dispatch, added a shared source-size limit, preserved prototype-like state keys, and aligned tool discovery aliases with descriptions and invocation. Invalid bridge JSON now returns a client error. Added live-smoke evidence and repeatable request/response, storage, concurrency, timeout and memory boundary tests.

- Codemode now keeps ordinary tool definitions out of API and CLI prompts, including core tools and directly exposed MCP tools. Scripts discover schemas only when needed; coordination controls and existing permission checks are preserved. Models without codemode keep their existing tool advertisement.

- **Voice fixes after review.**
  - **Spoken replies no longer mix.** `spoken` is now part of the message
    (`chat.send`, REST `/api/chat`) instead of a 30-second mark another turn
    could take. A live conversation follows one turn at a time: talking over
    a reply or saying something new before it ends no longer replays or drops
    replies, a failed turn ends there, and a typed message is not read aloud
    unless the client sends `expect_reply`.
  - **Protection.** A speech server moved to a public address no longer
    counts as local, and a conversation opened on a chat that did not exist
    yet applies that chat's protection level once it does. Choosing an engine
    by name (`/voice/transcribe` `model`, `?engine=`/`?tts=` on `/voice`) is
    admin-only.
  - **Engines.** Changing a speech server's model no longer keeps the old
    model's settings (switching VoxCPM2 to Breeze-TTS-2 used to keep 48 kHz).
    The live protocol can be turned off. Language codes such as `en-US` and
    `auto` work on every engine. Voice clips are stored as WAV, so cloning
    servers can read browser recordings. A missing clip file no longer stops
    all speech. Interrupted speech requests are cancelled. Background speech
    workers stop with the server. **Removed:** `POST /api/voice/install`
    (use `POST /api/voice/engines/install`).
  - **Phone calls.** Telnyx and Plivo stream live audio like Twilio, with
    interruption. Plivo webhooks are checked with V3 signatures, which cover
    the request body, and a replayed nonce is refused. New
    `voice.callAssistant` (off by default) gives calls from your own listed
    number, verified by the carrier (STIR/SHAKEN A), the full assistant with
    its tools. Everyone else, and every outbound call, stays on the
    restricted phone reply.

- **Voice, rebuilt around open engines and one pipeline.**
  - **Any speech model.** A model on an OpenAI-compatible speech server
    (Speaches, vLLM-Omni, LocalAI, NVIDIA NeMo-Speech, Groq, …) is a speech
    engine: add it under **Settings → Voice → Your own speech server** with
    its URL and model id. `openai/whisper-large-v3-turbo`, `openbmb/VoxCPM2`,
    `BreezeBlue/Breeze-TTS-2` and `nvidia/nemotron-3.5-asr-streaming-0.6b`
    start with the right request shape. faster-whisper takes any model name
    (`large-v3-turbo`, a Hugging Face repository) and uses a GPU when present.
    Binding a model that is not a speech engine to the Transcription or
    Speech lane is now refused instead of failing on the first word.
  - **One Voice page.** Engines are installed (with progress), tested and
    switched under Settings → Voice; local engines no longer need the CLI.
    The Docker image now carries ffmpeg and `uv`, and
    `docker compose --profile speech up` starts a GPU speech server.
  - **Voices.** Voice profiles replace the free-text voice id: a preset
    voice, a voice described in words, or one cloned from a reference clip.
    `voice.ttsVoice` is still honoured when no profile is active.
  - **Live conversation.** The server now ends your turn (`voice.endpointSilenceMs`,
    default 700 ms — was 1.5 s in the browser), speaks the reply while it is
    still being written, and stops when talked over (`voice.bargeIn`). A
    spoken turn is answered in spoken style, with no markup. Older clients on
    the dictation protocol keep working.
  - **Faster local speech.** faster-whisper and Kokoro keep their model loaded
    between requests instead of reloading it for every clip and sentence.
  - **Fixed:** installing Kokoro or the whisper.cpp model failed behind a
    proxy and held the whole download in memory; every spoken turn began with
    "On it — I've started the general"; Chrome dictation used the browser's
    recognition even with a private engine bound; onboarding's local voice
    choice registered engines without installing them.
  - **Removed:** the server-side wake-word detector and `voice.wakeWord`
    (nothing called it), and the unread `sttEnabled` / `ttsEnabled` flags.
  - **Phone calls.** One reply implementation for both call paths; calls are
    spoken in the install's Speech engine and voice (or the carrier's voice in
    `voice.language`); Twilio's live media stream runs the shared pipeline
    (sentence-by-sentence replies, barge-in, no temp files or ffmpeg).
    Fixed: incoming Plivo calls were never answered, Telnyx webhooks were read
    at the wrong level and its speech recognition was not started, ended
    calls were never removed. `make_call` takes `instructions`, reports a
    call that rang out as not answered, and `voice.expertPrompt` can be set.
    Telnyx now needs `telnyx_public_key`. Not yet run against a live carrier.
  - Operators: new settings `voice.profile`, `voice.endpointSilenceMs`,
    `voice.bargeIn`; new routes under `/api/voice/` (`engines`, `voices`,
    `profiles`); `chat.send` takes `spoken`. See `docs/VOICE.md`.

- **Inspect CLI context and choose session-only CLI models.** Context now records
  known CLI prompt composition, selected skills and available current-context
  telemetry. Select an individual coordinator, child or pipeline run instead of
  mixing their contexts. Connection & model shows the underlying CLI model when
  reported or configured, separately from its adapter. Expand session models to
  override a topic's model/effort or one agent role; reset restores global defaults.
  Changes take effect at the next CLI launch and invalidate its vendor context
  fingerprint, without interrupting active work or changing permissions.

- **Companion's project sessions follow your topic routing.** Companion no
  longer picks a model by name when it starts a project session (it had no
  list to choose from and could land on any enabled model, a test model
  included). The session routes by your topic lanes on every turn, like one you
  start yourself; the Companion page's start form no longer asks for a model.
  Maintenance sessions run on the Companion model. Sessions Companion started
  earlier switch to topic routing on their next turn.

- **Plugin Data access:** admins can approve Internal data for an installed package and its selected named connections without editing or re-signing plugin code. The content-bound approval uses a protected Octipus-rendered tools view, preserves saved records when access changes, and requires review after a package or connection destination changes. Agent guidance is in `docs/PLUGIN-DATA-ACCESS.md`.

- **Accepted for one week: picomatch ReDoS (GHSA-fc5q-39xc-vjpf).** No fixed
  `picomatch` release exists yet (4.0.7 is the latest and affected). It is
  reached only through build and test tooling (vitest, vite, ESLint); the
  served backend and web app do not run it. The dependency audit accepts it
  until 2026-11-24 and fails again after that, so it is revisited. The audit
  exceptions can now accept a hoisted package by naming everything that pulls
  it in ([scripts/audit-allowlist.README.md](scripts/audit-allowlist.README.md)).

- **Fixed: CLI runs on a host-identity environment no longer lose characters
  from their output.** Inherited variables with a credential-like name but a
  short value (a flag set to `1`, a token count) were masked everywhere in the
  vendor's output, so every `1` became `[REDACTED_CREDENTIAL]`. Antigravity
  runs failed their isolation check on the corrupted hashed path; other CLIs
  returned altered ids and paths. Values under 8 characters are no longer
  masked; vault bindings still are.

- **MCP servers go through the codemode executor by default; CLI agents get
  it too.** A server that sets no `exposure` is now `codemode`: agents call its
  tools from one script and only the script's output enters the conversation.
  Agents without codemode (small models, remote rooms) still reach the same
  tools through `mcp_list_tools` / `mcp_call_tool`. Servers saved as
  `deferred` (the MCP page saved every new server that way) keep it; change
  them on the MCP page. Plugin packages' declared tools follow the default.
  CLI workers (Claude Code, Codex, Grok Build, Muse Code, Antigravity, Vibe)
  now get the `codemode` tool over their Octipus MCP connection; its calls
  pass the worker's normal permission pipeline. The standalone MCP server has
  a compact toolset (`--toolset compact` / `OCTIPUS_MCP_TOOLSET=compact`):
  three tools that search, describe and call its 87. See
  [Tool exposure](docs/MCP-INTEGRATION.md#tool-exposure),
  [Codemode in CLI runs](docs/CLI-AGENTS.md#codemode-in-cli-runs) and
  [Compact toolset](docs/MCP-SERVER.md#compact-toolset---toolset-compact).

- **Learned skills can be repaired, owner-edited skills are locked.** A
  learning check may propose a patch to a learned skill whose body the session
  loaded: one passage, matched exactly once, PII-checked, made against a
  recorded content hash. It still needs approval on Skills → Proposals, which
  shows the change in the skill's context and refuses a patch whose skill
  changed since (`409 stale`). A skill the owner creates, edits, imports or
  approves with their own text while signed in (not through an API token or the
  MCP bridge) is locked against patches, against being overwritten by a
  same-name proposal, and against curator archiving. Skill usage now counts
  loading a skill's body, not its line in a role's skill index. Migration
  `0191_skill_patch_proposals` does not lock existing skills; they lock on the
  owner's next edit. See
  [Session learning](docs/SESSION-LEARNING.md#repairing-a-learned-skill).

- **Memory learns only from your own words.** Every new long-term memory
  cites your own messages and a verbatim quote, which the server checks
  against the stored message before writing; assistant replies, tool output,
  compaction summaries and plan briefs can no longer become memories, and
  `remember_this` now requires a `quote`. Memories keep the quote (shown on
  the Memory page), a kind, a status and an optional end date; recall skips
  ended facts and a daily repair pass retires them and merges exact
  duplicates. Migration 0190; existing memories are kept and still recalled.
  See [where a memory comes from](docs/RAG.md#where-a-memory-comes-from).

- **Standing instructions for Companion.** Tell Companion how you want it to
  work and it saves the rule with your exact words (checked by the server); it
  follows them in every turn, background check-ins included, and the Companion
  page lists them with a Remove button
  ([COMPANION-SUPERVISION.md](docs/COMPANION-SUPERVISION.md)).

- **Answer Companion from your phone or chat.** Companion notices go through the
  notification service (bell, live tabs) and, when you turn it on, to your linked
  Telegram, Slack, Teams or WhatsApp chats. A repair that reached its limit asks
  "Try another fix / Leave it" as an approval you can answer from a paired phone
  or by replying in chat; the answer only applies to the incident as it was.
  Reports filed during quiet hours wait until they end, unless high impact with
  an earlier deadline ([COMPANION-SUPERVISION.md](docs/COMPANION-SUPERVISION.md)).

- **Evals grade what changed, not only what was said.** The eval harness can
  check the database after a turn (`db_rows`, `memory_absent`,
  `companion_actions`, …, scoped to the eval user), seed fixture rows, tag
  each check `process` / `outcome` with a failure class (`unsafe`,
  `incomplete`), repeat tests (`--repeat`, pass@1 / pass@k / pass^k) and gate
  on tests admitted after 5/5 clean runs (`--admit`, `--gate`, `eval/gate.json`,
  fingerprinted). New suites cover memory poisoning and Companion authority
  (live tier), and `npm run eval:decisions` runs a model-free, fixed-label set
  of Companion basis decisions with unsafe allows and extra refusals reported
  apart. A list-valued `not_contains` no longer passes regardless of the reply
  ([EVALUATIONS.md](docs/EVALUATIONS.md)).

- **Companion speaks up only when it matters.** Background check-ins no longer
  post their working text or notify you. Companion files a report instead, and
  the server sends it only for strong evidence, real impact and a new matter or
  a material change; held-back reports stay on the goal's Companion page with
  the reason ([COMPANION-SUPERVISION.md](docs/COMPANION-SUPERVISION.md)).

- **Companion acts on your own words, checked by the server.** Every goal,
  session start, instruction, adoption, maintenance start and resume Companion
  makes carries a quote of what you asked for. The server checks the quote is
  really in your message, or in the words you gave when the goal was created,
  and the Companion page shows it as "Because you said…". Background check-ins
  can no longer raise a goal's token budget or cancel a goal, and an owner-turn
  budget raise, cancellation, incident retry or new goal needs your current
  message. Messages Companion sends to project sessions are marked as coming
  from Companion, not from you (so they cannot confirm a waiting plan), and
  per-turn memory extraction now runs only on turns you sent
  ([COMPANION-SUPERVISION.md](docs/COMPANION-SUPERVISION.md)).

- Add provider-reported z.ai/Kimi Code plan usage, reset information and a
  dedicated Kimi Code key entry. Keep legacy Moonshot API bindings unchanged.
- Fix z.ai/Kimi CLI catalogs to use their own configured endpoints and keys,
  and include Grok/z.ai/Kimi quota blocks using the correct provider IDs.
- Populate Grok Build model pickers from `grok models`, using the existing CLI
  login and account availability instead of the separate xAI API catalog.

- **Local custom endpoints count as local.** A model on a custom
  OpenAI-compatible endpoint (llama.cpp, LM Studio, vLLM, …) can be marked
  **Runs on this machine / network** in the model editor, so conversations at
  protection levels 3–4 may use it. Only for an endpoint at localhost, a
  private address or a `.local`/`.lan` host; the API refuses it otherwise
  ([PROTECTION-LEVELS.md](docs/PROTECTION-LEVELS.md)).

- Modernize Antigravity CLI integration: scoped Octipus-only tools, streamed
  activity, resumable conversations, account model discovery, safe tool-less
  completions and measured cache-aware token usage.

- **Optional local embeddings.** Search across documents, notes and memories
  without a key: llama.cpp and a small embedding model (EmbeddingGemma 2,
  about 330 MB with the engine) installed on the server only when an admin
  says yes — Topics page, `octi capabilities install local-embedding`, the
  optional "Search & memory" step of `octi setup` (`OCTIPUS_SETUP_EMBEDDING`),
  the web onboarding, or Docker (`install-docker.sh` asks; build arg
  `OCTIPUS_BAKE_EMBEDDING=1`; new `octipus-models` volume). Downloads are
  pinned and SHA-256 verified, the engine runs on 127.0.0.1 with a key per
  start and stops when idle (`localEngine.idleStopMinutes`). An embedding
  model already bound is never replaced. Nothing changes for installs that
  do not add it ([RAG.md → Local embeddings](docs/RAG.md#local-embeddings)).

- Add Grok Build as a CLI agent model, using an existing login, scoped Octipus
  tools, resumable conversations, streamed activity and cache-aware token usage.
- **Everything beyond one chat model is optional.** Embedding, reading images,
  OCR, image generation, speech to text and text to speech: not configured
  means off — no tools offered to agents, no prompt text, no background work,
  hidden pages and controls ([MODULES.md → Capability gates](docs/MODULES.md#capability-gates)).
  Embedding is no longer reported as required. Without an embedding model
  nothing is chunked or embedded; content saved meanwhile is indexed once a
  model is bound (migration 0184).
- **Agents look at images themselves.** An attached image goes to a model that
  reads images as the image itself (normalized to ≤ 2048 px), not as a
  description; a model that cannot see gets the path and `vision__view_image`,
  and decides whether to look. Channel images (Telegram, Slack, WhatsApp,
  Teams) are handled the same way, with or without a caption, and are no
  longer filed as documents unless `media.fileChannelImages` is on. New
  `vision` tool: `view_image` (pixels for a seeing model, the Vision lane's
  answer otherwise, region crops, URLs through the SSRF guard) and
  `read_document_text`. Browser and MCP screenshots are saved in the
  workspace and shown to a seeing model instead of base64 in the text
  ([MEDIA.md](docs/MEDIA.md)). Settings `media.imageInput`,
  `media.replayRecentImages`.
- **Agents hear and speak.** A recording attached in the chat is transcribed
  with the turn (with `media.audioInput = native`, a model that hears audio
  also gets it); channel voice notes are kept with the conversation. New
  `audio` tool: `transcribe_audio` (long recordings cut into parts and
  stitched) and `speak` (saved in the workspace). Both are offered only when
  a Transcription or Speech engine is bound ([MEDIA.md](docs/MEDIA.md)).
- **Agents draw, and answers carry media.** New `imagegen` tool
  (`generate_image`, offered when an Image generation model is bound: OpenAI,
  Gemini/Imagen, OpenRouter, LiteLLM or OpenAI-compatible endpoints).
  Generated images and `speak` audio come with the answer: in the web chat
  (thumbnails, player), and as bytes on every channel — Telegram photos and
  voice notes, WhatsApp media uploads, Slack file uploads (add the
  `files:write` scope), Teams inline images and short-lived public links.
  Voice notes get spoken replies on every channel. `send_message` /
  `send_to_user` take `attachments`.
- **New lanes:** Image generation, Transcription, Speech. Vision and OCR are
  optional: a model that reads images gets them itself; OCR falls back to
  Vision, then to a default model that reads images. Model rows gain
  *Hears audio* (migration 0185); what a model reads is detected (Ollama
  `/api/show`, a per-family table), once for existing rows at boot.
- **Migration — voice engines moved to the lanes.** `voice.sttProvider`,
  `voice.fasterWhisperModel`, `voice.whisperModelPath`, `voice.ttsProvider`
  and `voice.piperModelPath` are retired. On the first boot they become
  model rows bound to the Transcription and Speech lanes: an explicit choice
  is kept; `auto` now means **local first** everywhere (the microphone used to
  try the cloud first); the next engine of the other kind that can run becomes
  the backup. Check the Topics page after upgrading. `?engine=` on `/voice`
  and `model` on `/api/voice/transcribe` still accept the old engine names.
  `/api/voice/transcribe` no longer reads only `OPENAI_API_KEY` from the
  environment, phone calls use the bound engines instead of a fixed whisper
  and Voxtral voice (`voice.ttsVoice` picks the voice), the TUI transcribes and
  speaks through the server, and speech calls are recorded in usage/spend.
- **Terminal chat: a worker finishing no longer ends the turn.** The chat
  read `agentId` from `agent.completed`, which names every agent `workerId`, so
  any worker finishing looked like the root ending: the next queued message
  went out while the root still ran, and the root's live reply was wiped. The
  turn now ends only on the agent the server marks `root: true`; workers get a
  row in the subagent panel, and their token counts are read again.
- **Terminal chat: Esc stops this chat only.** Esc pressed before the turn's
  root agent was known sent `/abort`, which stops every agent of the user in
  every session — a pipeline in a browser tab included. It now sends the new
  gateway frame `session.stop` (`{ sessionId }`): the caller's running agents
  in that one session stop and their messages queued in it are dropped, and a
  `session.stopped` event says how many. When nothing had started yet the chat
  says so and stops the root as soon as it starts. The `/abort` command is
  unchanged.
- **Terminal chat: only the turn's own answer ends it.** Any gateway `error`
  frame ended the running turn (a stale permission answer, an expired
  approval, a rate limit, dropped events), a late `CHAT_CANCELLED` of a
  stopped turn ended the next one and wiped its live reply, and another tab's
  stop ended this tab's turn. `chat.send` now takes an optional `turnId`
  that the gateway echoes on the turn's `chat.response`, `chat.error`,
  `chat.delivery` and on the `error` frames that answer the send (with its
  `sessionId`; also `RATE_LIMITED` and `INVALID_MESSAGE` for a refused send).
  The terminal ends a turn only on its own answer, its root agent, or its
  session's stop, and shows a late answer without touching the next turn.
  `agent.stopped` now carries the session on its envelope and `root` in its
  payload.
- **Terminal chat: a queued message goes below the reply it waited for.** The
  next queued message was sent, and shown, before the reply of the turn it
  waited on — the root agent finishing arrives just ahead of its reply — so the
  transcript, `/export` and the exit summary read user, user, reply. The turn
  now ends on its answer, after it is shown (or 5 s after the root finished if
  no answer comes).
- **Terminal chat: nothing typed while disconnected is lost.** A message sent
  while the gateway connection was down was dropped by the socket without a
  word, and the chat then waited forever for its reply. It now waits in the
  visible queue ("not connected: sent when the connection is back") and goes
  out on reconnect; a command, a decision's answer or a stop that cannot be
  sent says so. `GatewayClient`'s send methods return whether the frame went
  out.
- **Security — terminal chat: a clicked file link is no longer opened.** A
  `path:line` or `file:` link in a reply was handed to the desktop opener on
  click, so a model-written `notes.command:1` ran on macOS, and
  `file://host/share` (any host was accepted) made Windows send the user's
  NTLM credentials to that host. `file:` links are now kept only for this
  machine (no host, `localhost` or its own name), and a click on one copies
  its path and says so; `http`/`https` links still open in the browser.
- **Terminal chat: `/clear` keeps the composer and status rows.** On the
  alternate screen `/clear` left them blank until something redrew them.
- **Terminal chat: transcript search finds every message in memory.** It
  searched only the rendered window of the newest 200–400 messages, so older
  ones were neither found nor counted.
- **Terminal chat: reasoning reads before the tool calls it led to.** The
  folded "Thinking" row used to appear below the turn's tool calls.
- **Terminal chat: long replies stream without eating the CPU.** Each delta
  re-sanitised and re-rendered the whole reply (a 154 KB reply in 2,000 deltas
  cost about 3 s of CPU). The text is now sanitised incrementally and a long
  reply is redrawn on a budget that grows with its length; the finished reply
  still takes exactly the rows of the last streamed frame.
- **Terminal chat and editor: the window title is restored on exit.** It kept
  the app's last title; the terminal's title stack now saves and restores it.
- **Terminal chat: a failed image upload notifies a failure.** It used to send
  "The reply is ready" for a message that was never sent.
- **Terminal chat: a cancelled picker stays cancelled.** Closing the session
  or skills picker before its list arrived printed the late list into the
  transcript.
- **Terminal chat and editor: they reconnect after the server goes away.** A
  connection cut without a close frame (a crashed or restarted server, a
  dropped network) reported an error first, and the client then never tried
  to reconnect.

## v0.7.0 — Your agent workspace (2026-11-13)

### Highlights

- **A clearer workspace.** Project Desk puts current work, its state and the
  next action first. Navigation is collapsible, Settings is searchable and
  grouped by purpose, and the web UI supports light and dark appearances.
- **Optional Companion supervision.** A dedicated Companion chat can coordinate
  existing sessions, follow projects, keep ideas in to-dos and respond to
  problems. Its model and budget are separate from the sessions it supervises.
- **Signed plugin packages and marketplace.** Plugins install with an explicit
  permission review, verified content and signatures, and sandboxed execution.
  Official marketplace public trust anchors ship with Octipus; users do not
  generate publisher keys. Packages can add tools, pages, dashboards and
  background work, with declared host capabilities and scoped persistent data.
  Marketplace packages are published separately from Octipus itself.
- **Native Windows plugin sandbox.** The release includes the AppContainer/Job
  object helper and checksum for supported Windows installations. Linux and
  macOS retain their platform sandbox runners.
- **Environments & Access.** Configure where work runs and what it may use:
  installed workstation programs and sign-ins, isolated runtimes, remote hosts,
  project folders and unattended work. Explicit denials and configured limits
  remain effective.
- **More reliable long-running work.** Pipeline approvals, recovery, child
  authority and model budgets retain their scope. Chat and MCP retries use
  idempotency keys, queued steering survives CLI turns, and cancelled work
  stops deliberately rather than silently starting again.
- **Simpler first-run setup.** Start with one model and a chat before adding
  optional mail, project or background features. Onboarding is centered and
  themed, validates model details, checks connections before assignment, and
  reports partial failures and save errors with a way to retry.
- **Usable starting budgets.** The default per-user daily allowance is
  10,000,000 tokens. Root, worker, pipeline and plugin budgets have more room
  for useful work; explicit administrator limits remain in place. Refusals
  identify the applicable limit and where to change it.
- **Less setup overhead.** Product help searches the bundled manual locally
  when requested rather than embedding all documentation during startup.
  Backup diagnostics, session model reporting, mailbox/calendar pages and
  task editing have also been improved.

### Security and compatibility

- Plugin content, declarations, protection levels, scopes and revocations are
  checked at installation and use. Per-user plugin store data stays scoped to
  the owner and workspace; runtime files use a shared package data directory.
  Publisher/source changes require a data-handover decision for store data.
- Saved credentials remain in the vault. Trusted API connections keep their
  origin, path and method boundaries; explicitly pinned server certificates
  are checked before credentials are sent.
- Node.js 24.22.1+ or 26.12.1+, with npm and Git, remains required for a source
  installation. The installer and launcher manage application dependencies;
  external programs and model accounts have their own prerequisites.

### Upgrading from 0.6.0

1. Create and verify a database/files backup and retain the existing master
   key and bootstrap configuration. Replacing the master key can make saved
   credentials unreadable.
2. Update using the normal installer/launcher. Database migrations run on
   startup; keep the configured database and workspace files in place.
3. Review Environments & Access and any changed plugin declarations. A new
   content approval or broader permission is an explicit operator decision.

The release workflow attaches the standalone MCP archive and Windows sandbox
helper/checksum. It also publishes the MCP npm package when npm publishing is
configured. Desktop and mobile app-store publishing are separate distribution
steps.

## Development history for 0.7.0

The detailed notes below preserve the implementation and operator history.
The curated release notes above are used for the GitHub release.

### Changed


- **Learned skills can be repaired, owner-edited skills are locked.** A
  learning check may propose a patch to a learned skill the session used: one
  passage, matched exactly once, PII-checked, made against a recorded content
  hash. It still needs approval on Skills → Proposals, which shows the old →
  new passage and refuses a patch whose skill changed since (`409 stale`).
  A skill the owner creates, edits or imports through the API or the Skills
  page is locked against patches, against being overwritten by a same-name
  proposal, and against curator archiving. Skill usage now counts loading a
  skill's body, not its line in a role's skill index. Migration
  `0191_skill_patch_proposals` backfills existing non-system skills as
  owner-written unless a promoted proposal shows they were learned. See
  [Session learning](docs/SESSION-LEARNING.md#repairing-a-learned-skill).

- **Recurring scheduled agent runs can skip unchanged runs (`watch`).** A
  schedule hook whose action is an orchestrated `spawn_agent` turn may name up
  to five sources in `triggerConfig.watch` (a web page, a workspace file or
  directory, the task board, the connected inbox, failing pull requests).
  Before each run they are read without a model; when every source was read,
  nothing changed since the previous run, and that run confirmed success, the
  run is skipped and logged as `skipped` (`reason: "unchanged"`). The
  baseline is probed after a successful run, so the run's own edits to a
  watched source are not a change. A source that
  cannot be read never counts as unchanged. Reminders, digests and one-shots
  always run. See [Hooks](docs/HOOKS.md#watch-skip-unchanged-runs).
- **A failed scheduled run tells its owner.** The cron runner now sets
  `lastError` when a scheduled hook's action fails (it used to clear it) and
  posts a `schedule_failed` notification that names the schedule, once per
  failure streak. An orchestrated `spawn_agent` turn that fails, is cancelled
  or is refused (no model, session budget spent, input guard) is recorded as a
  failed execution rather than a success.

- Plugin-store values have an explicit 128-container nesting limit, returning
  `400 invalid_value` consistently on supported Node runtimes before database work.

- Product help now searches the bundled manual locally on demand, without startup or scheduled documentation embeddings.

- **Useful token budgets from the first run.** The default per-user daily
  cap is now 10,000,000 tokens. Shared root turns start with 2,000,000,
  agents/subagents with 800,000/300,000, pipelines with 10,000,000, and
  plugin models/background runs with 10,000,000 per day and 1,000,000 per
  run. Explicit admin, user and saved-run limits remain in place.
- **Actionable budget refusals.** Chat and API errors name the applicable
  limit, daily reset and settings page; typed quota/spend refusals remain
  HTTP 429 rather than generic server errors. Explicit session zero budgets
  correctly mean unlimited. See [configuration](docs/CONFIGURATION.md#default-token-budgets).

### Security

- **One envelope for outside content in tool results.** Web, mail, GitHub,
  MCP, extension, connection (external API), Google Workspace / Microsoft 365,
  uploaded-document and Companion session reads now reach the model inside
  `<untrusted_tool_result source="…">` with a one-line "data, not
  instructions" notice, as do those tools' own errors and codemode scripts
  that read them. Delimiters inside the content are escaped (including
  zero-width and full-width look-alikes, shared with the webhook fences),
  Octipus's own notices stay outside the block, saved oversized results carry
  it, and the system prompt explains it. Only the model's text changes: result
  objects, UI events and transcript rows are as before. It is a hint, not an
  enforcement boundary; permissions and the flow guard still enforce. The mail
  tools' own notes are replaced by it. See
  [flow guard](docs/FLOW-GUARD.md#untrusted-envelope).

- **The plugin store holds the four boundaries (security review of the
  store, before release).** Protection levels are enforced at runtime on the
  store as everywhere else:
  - A host API call now works at the calling session's protection level too:
    a tool in a level-2 conversation stores its entries at 2 and may not write
    notes or tasks (`403 read_level`), and `documents:write` stores at no
    lower. Before, a store write took only what the package itself had read,
    so a level-2 conversation could be laundered to level 1 through the store.
  - An entry above the package's `maxProtection` answers a get, a write, a
    compare-and-set and a delete as a missing key (`404`, no version, no
    level); a list no longer counts them (`withheld` is gone) and a quota
    refusal no longer says what is used. A write, a version conflict and a
    delete raise the caller to the entry's level, and an overwrite never
    lowers it. When `maxProtection` drops (an upgrade, an egress scope
    approved), the entries above it are deleted in the same transaction
    (audited with counts).
  - An upgrade to another signer or source deletes the store by default;
    keeping it is the optional, unticked consent item
    `change:store-handover` (*"Hands the stored data of N users (X MB) to the
    new publisher"*), `keepStoreData` in the API and `--keep-store-data` in
    the CLI, audited. An upgrade that drops `store` deletes the entries.
  - A plugin's pages, sidebar entries and page store are served only while
    the package may start (not revoked, its content approved: the check
    before every start, cached 30 seconds and forgotten on any approval,
    install or revocation).
  - The quota charges 128 bytes per entry and counts the value as the
    database serialises it; at most 10,000 entries per user and package
    (`413 too_many_entries`); a running total per package, user and
    workspace replaces a sum on every write. Page writes share the tools'
    store write limit. Aggregated store audit counts are written on a timer
    and at shutdown instead of being dropped.
  - The store is per user and per workspace: what is kept in a space is read
    there only, and leaving the space deletes it. "Delete my data" takes an
    optional workspace. Migration `0182_plugin_store` (not released yet) is
    changed in place.
- **Native Windows plugin sandbox.** Marketplace and local package plugins
  can run in a less-privileged AppContainer through `octipus-sandbox.exe`,
  with a kill-on-close Job object (2 GiB, 32 processes). Package files are
  read-only; dedicated data and scratch are writable. A private named-pipe
  broker enforces declared hosts without an internet capability or loopback
  exemption. Node proxy adaptation supports existing proxy-aware packages.
  Exact release installs obtain the tested binary; source Windows installs
  and updates build it with Rust and Visual Studio C++ Build Tools. See
  [Windows sandbox](docs/WINDOWS-SANDBOX.md) for persistent folder permissions,
  runtime limits and Windows CI evidence.

- **Plugin sandbox is a boundary of its own, required by default (final
  security review).** Package plugins were sandboxed only under
  `security.shellSandbox`, which defaults to off: an unwrapped plugin could
  read `DATABASE_URL` and `MASTER_KEY` from `/proc/<ppid>/environ`. New
  setting **`plugins.sandbox: required | off`** (default `required`, env
  `PLUGINS_SANDBOX`): a package plugin never starts without a working runner
  (bwrap or firejail on Linux, sandbox-exec on macOS), and starting, enabling
  and consenting are refused with what to install. `off` applies only to
  plugins not from the marketplace; a marketplace plugin always needs a
  runner. **Upgrade note:** on a host without a runner, enabled plugins stop
  until one is installed (or, for local plugins only, `plugins.sandbox: off`).
  **Windows** uses the native AppContainer helper described above. The
  Docker image installs bubblewrap (`docker-compose.yml` documents the
  seccomp/AppArmor options bwrap may need); a startup log line and the admin
  page say *plugin sandbox: active runner X / unavailable*. Declarations, the
  network status and the marketplace card say "NOT sandboxed on this host" /
  "Network not enforced on this host" where that is so.
- **No terminal for sandboxed commands (TIOCSTI).** bwrap runs with
  `--new-session`, package servers are spawned in their own session and
  stopped by process group, and the Seatbelt profile allows nothing on
  `/dev/tty`. firejail adds `--caps.drop=all --nonewprivs`, and `--private`
  when nothing under `$HOME` is whitelisted.
- **Pages are egress:** a package with pages sees data up to level 1 whatever
  its `maxProtection` says (also in `octi plugin permissions` and the index).
- **A plugin's own text never reaches a model:** the system prompt lists a
  plugin server by a host-written line, tool descriptions are the manifest's
  (consented), undeclared tools are dropped, free text is removed from input
  schemas, and a `tools/list_changed` cannot swap any of it.
- **Expiry:** `keys.json` must carry `expires`, at most 90 days after
  `generatedAt`; the marketplace index at most 45 days (recommended 60 and 30).
- **Plugin routes check API token scopes** (`api:admin` for every change,
  `api:read` for reads; user routes `api:read`/`api:write`) and refuse a
  cookie-signed change from another origin (a sibling subdomain included).
- **Protection-level laundering:** what a package read is kept per package and
  user across calls; notes and tasks are refused after a read above level 1,
  documents are written at no lower level; reset on disable, upgrade, uninstall.
- **Key revocations signed by a root revoked since lapse** (`signerRevoked`)
  unless a trusted root lists them again.
- **Permissions summary:** `secrets` and `settings` (names, sorted, after
  `network`) and a command's `input`; the diff lists every tool effect change
  (down to read widens, external → write narrows), a new secret widens, and a
  wildcard host over a short domain gets a guidance warning.

- **Plugin marketplace hardening (independent review).** Marketplace trust
  stays inside the marketplace: `keys.json` may revoke only keys it endorses
  or ever endorsed (and roots), and its key revocations and the index's
  package revocations apply only to packages installed from the marketplace,
  installs from it and its index; never to `trustedPublishers`, directory,
  URL or bundled installs or other registries. A marketplace package starts
  only with a valid signature by a key `keys.json` endorses now, whatever
  `requireSignature` says (a key simply dropped from `keys.json` stops its
  packages). A package revocation from a signing key revoked since is
  flagged `signerRevoked` and not enforced until a trusted key lists it
  again; listing pins record their signer and a revoked signer's pins are
  dropped. An entry that replaces a pinned version is refused alone
  ("replaced: refused"), the rest of the index kept; `DELETE
  /api/plugin-packages/pins` resets one pin (audited, with a reason). Every
  instance applies the revocations in force (index read, cron tick), and a
  loaded in-process plugin is unloaded when its start check refuses it now.
  One `plugin_revoked` notification per index. A root key's revocation can no
  longer be cleared. `keys.json` and index v2 take an optional `expires`
  (refused after it); a banner and a `plugin_marketplace_stale` notification
  when the last accepted one is older than 7 days. Control, bidi and
  invisible characters are removed from v1 descriptions and echoed names, and
  refused in more forms (U+00AD, U+115F, U+180E, U+2060–U+2064, U+3164, tag
  characters). The asset proxy re-checks that an image is listed before
  serving it from cache and coalesces concurrent fetches; the marketplace's
  tarballs stay on its origin through redirects. `plugins.registries` refuses
  the name `marketplace` and duplicate names. **Migration** 0180 adds
  `plugin_marketplace_keys.endorsed_key_ids` and `plugin_listing_pins.signed_by`.
- **`octi plugin`:** `sign-keys` checks the keys file as a host reads it
  before signing; `keygen` warns loudly about an unencrypted key; new
  `verify-keys <keys.json> --root-pub <file>... --json` and `unpack
  <tarball> --out <dir> --json` (the install's strict tar reader).

- **One install consent per item, bound to the content.** A plugin is
  previewed first (`POST /api/plugin-packages/preview`: downloaded and
  verified with the install's own checks, staged outside the store, nothing
  installed) and installed only with every declaration agreed to (`POST
  /api/plugin-packages/install { previewId, contentHash, accepted, enable? }`):
  the staged copy must still hash to the content hash shown and declare the
  same items, and the installed version must be the one compared against. The
  approvals (content, contributions, host scopes, in-process,
  `model:cli-tools`) are recorded with the row in one transaction and audited
  as one `consent` row. Previews are per admin, single-use and expire after
  15 minutes. An upgrade carries unchanged items it had agreed to and asks
  for what is new or changed; another source, signer, an older version or a
  newer Octipus needed are items to agree to, not refusals. Installed
  packages (an agent's) are agreed to and enabled with `GET`/`POST
  /api/plugin-packages/:name/consent`. `octi plugin install` and `upgrade`
  ask per item at a terminal or take `--accept all|<ids>`, and refuse
  otherwise. The web app uses this everywhere it installs, upgrades or
  enables; the separate approval endpoints keep working.
- **Plugin permissions name what contributions and pages are bound to
  (M3).** `computePermissions` (`octi plugin permissions --json`, index v2
  `permissions`) now lists commands with their tool, schedules with cron,
  tool and input, events with their tool, the prompt with the sha256 of its
  bytes and its roles, the context tool and roles, pages with path, title and
  entry, and `ui: { dir, sha256 }` of the page tree, so a schedule switched
  to another tool, a cron change, new prompt text or a replaced page is a
  change (and widens) in the update diff and the consent. **Breaking for
  registries:** an index must list the new shape (the host's deep-equality
  check refuses the old one).

- **The plugin marketplace, host side.** A built-in registry for
  `https://plugins.octipus.cc/index.json`, anchored by two root public keys
  that ship as placeholders: until a build carries real ones the marketplace
  is off (never fetched, never trusted) and Admin says it is not configured.
  Root keys sign only `keys.json`, which endorses the signing keys (rotation
  and revocation without a release; the backup root may revoke the root,
  never the reverse). An install from a registry recomputes the permissions
  from the downloaded manifest and refuses any difference from the listing,
  checks the content hash, and records provenance (`origin`). A published
  version's content hash is pinned; `generatedAt` and the keys file version
  only move forward. Package and key revocations from the marketplace are
  stored, sticky, refused at install and at every start, and notified to
  admins. Listing images are proxied (PNG, JPEG, WebP, GIF by their bytes;
  no SVG; `nosniff`, `default-src 'none'`). New: `plugins.marketplace`
  (`true` / `false` / `{ url, rootKeys }`), `GET /api/plugin-packages/marketplace`,
  `/marketplace/asset`, `/updates`, `/revocations`, `/:name/usage`,
  `/:name/usage/me`, `DELETE /:name/runs/:id`, `DELETE
  /api/plugin-host/agent/runs/:id`, a daily update check, and `octi plugin
  marketplace`, `updates`, `install <name>`, `sign-keys`. Migration 0179.
  An upgrade from another source needs `allowSourceChange`.

- **OAuth popup callback pages no longer reflect script.** The connector
  callback put `?error=` into an inline `<script>` with `JSON.stringify` under
  a CSP that allowed `'unsafe-inline'`, so `</script><script>…` ran on the
  app's origin; the sign-in provider callback had the same pattern. Only the
  global `script-src 'self'` replacing the page's own policy kept it from
  running — which also blocked the pages' own scripts, so the opener never
  heard back and the popup stayed open. Both pages now come from one builder:
  script-safe JSON, escaped markup and a per-response nonce policy that the
  global security headers keep. The settings page accepts the popup's message
  only from that popup and the app's origin.
- **Artifact embeds are sandboxed wherever they are opened.** The embed's CSP
  header carries `sandbox allow-scripts`; in path-prefix mode an embed URL
  opened directly used to run its bundle with the app's origin.
- **Desktop commands are governed by capabilities.** `get_backend_url` and
  `set_backend_url` are declared in an app manifest and granted to the main
  window; the webview lost the settings-store permission it did not use, so
  the backend URL changes only through `set_backend_url`'s checks.

- **Telnyx webhooks are verified with Ed25519.** The old check ran an HMAC
  keyed with the (public) key, which anyone could compute, and passed every
  webhook when no `telnyx_public_key` was set. Verification now uses the
  Ed25519 signature over `timestamp|body`, and a missing key fails it.
- **Telephony webhooks are refused unless signed.** `/api/voice/webhook/:provider`
  (and `/status`) logged a failed signature check and processed the call
  anyway, and checked it over re-serialised JSON rather than the bytes
  received, so no valid signature could pass. The check now runs over the
  raw body against the public URL and path the provider called, and a
  failure answers 403 and does nothing. Telnyx webhooks older or newer than
  300 s are refused (replay). Plivo needs the V2 signature and nonce
  (`X-Plivo-Signature-V2`); the legacy header is refused.
- **The federation private key is unreachable from vault references.** The
  vault itself now refuses reserved system secrets on `getByName`, `get`,
  `store`, `setSystemSecret`, `update`, `rotate` and `delete`, and leaves them
  out of `list`, so a model's `apiKeyRef` (Test, Fetch Models, real calls) or
  a SCIM token reference named `federation.identity` resolves nothing.
- **Peer link hardening.** Sealed links are capped per address (IPv6 per
  /64) and in all, links from instances that joined nothing here are capped
  and may only ask `space.join`, and a link answers at most 32 requests at
  once (more get `busy`). Handshake budgets are swept every minute and capped
  install-wide; a pre-handshake frame over 4 KiB is refused unparsed; the
  host nonce lives in the socket instead of the key-value store. The keys
  derive from a hash of the whole handshake transcript, which now signs the
  protocol and both app versions, and the AEAD nonce is the sequence number.
  The send-queue cap grows with `gateway.maxFrameBytes`. `/federation` is
  always registered and refuses with 4403 while not hosting, so turning
  hosting on needs no restart. The rightmost `X-Forwarded-Proto` decides
  TLS, and a trusted proxy that names no client is not a LAN client. The
  visitor pool stops redialling a host that refused it (4403/4409) until
  asked again, resets its backoff only after a link stayed up 30 s, and
  redials retained hosts when visiting is turned back on.
- **Spaces on other installs, the visitor side: review hardening.** The
  visitor's agent: an addressed turn checks that its conversation still
  exists, is active, is the member's and names that room (a deleted one is
  never revived: its channel cannot create a session), and deleting or
  archiving the conversation closes its listener; mentions are dated by the
  post and the host's event, the older (10-minute window, none ahead of the clock, no replay) and
  limited to 6 an hour and 30 a day per conversation and per member, before
  the room is read; the mention reaches the agent inside the room context's
  fence, never as the member's words; an unattended turn writes nothing to
  the space, whatever was approved before; the member's panel text counts
  as private, so attended writes ask every time; every task op asks; page
  fetch is gone (web search stays); tool arguments are checked (UUID ids,
  normalised paths inside the space, enum ops); tool descriptions name no
  host string, approval summaries quote host names on one cleaned line.
  Residency: trajectories, the agent event log, prompt dumps, the
  tool-output spill, file auto-indexing, memory, learning and the text of approval notifications
  are off for such a conversation. Host answers are checked against schemas
  (`bad_answer`, 502). A rejoin and a pending leave of the same member and
  host never interleave, and the leave is re-read before it is sent; a host
  with pending leaves is retained and redialled with backoff. The pool keeps
  a host's handshake-confirmed address. A post is answered only by the
  `room.posted` with its `clientId`, and the agent posts on its own
  connection. The host knows a member by a per-host HMAC of their user id.
  The REST post asks `api:chat` for an addressed post. The web encodes
  every path segment, drops non-UUID ids from host data, and loads no image
  from a remote room or note.
- **Hosting members of other installs: review hardening.** A visitor's
  virtual connections pass only room, space and live-note traffic, a
  mention and a requester error to the link (`agent.*`, `swarm.*`,
  `chat.delta`, permission prompts and other progress of a host turn, with
  raw tool arguments and results, are dropped). A visitor's gateway rate
  buckets are shared by all their connections on the link and survive
  `conn.close`. Whether members of other installs read a run is read again
  at every tool decision and before a room reply is posted (a remote member
  may join mid-turn): such a run refuses any egress once the session holds
  personal data, not only credential material, and an answer that drew on
  personal data is not posted. Writes into a space with any remote member
  (notes, files, memory, tasks) are federated egress for every turn there:
  credential material is refused and the personal-data consent names the
  other installs. Blocking an install removes each membership on its own
  (failures reported, the block always audited, the admin as the removals'
  actor). `file.read` reads at most 1 MiB through one handle and refuses an
  answer over the link frame. Posts the input guard only warns about keep
  their flags, and room transcripts mark them. The agent-post cap counts per
  install per room, atomically. Badges show 12 characters of the instance
  id, and member lists carry its full id. Member lists sent to visitors
  carry the member-visible name (the username) and never an e-mail.
- **Spaces across installs: identity and peer link** (first slices of
  `docs/plans/federation-spec.md`). Each install gets an Ed25519 identity,
  stored as the reserved vault secret `federation.identity` (the vault API
  refuses to list, change or delete it; a vault error refuses federation
  rather than minting a new identity). New `federation.*` settings (mode off
  by default). When hosting, `/federation` accepts mutually authenticated,
  sealed peer links (X25519 + ChaCha20-Poly1305, per-direction keys and
  sequence numbers) with per-address handshake budgets; outbound dials go
  through a guarded dialer (public or `federation.lanCidrs` addresses only,
  pinned IP, no redirects). Migration `0137_federation.sql` adds
  `federation_instances`.

- **Invited members no longer get the owner's models and install state.**
  Each account now has an install-models flag. Accounts created on the
  sign-in page (open registration or a space invite) start without it
  (`security.selfRegisteredInstallModels`, default off): they see and run on
  only their own models and what a sponsored space provides, enforced at the
  provider and CLI boundary. Existing, admin-created, SAML and SCIM accounts
  keep access; an admin flips it per account under Users. **Upgrade note:**
  accounts that already joined through an invite keep access until an admin
  turns it off.
- **Install-level routes are admin-only.** Running a tool directly
  (`POST /api/tools/:id/tools/:name/execute`) beyond the tools a member's own
  chat agent has, reloading extensions, plugins
  and mounted skills, and reading model configuration, provider lists, CLI
  status, detailed health, tool/plugin/MCP/capability inventories,
  evaluations, topic bindings and telephony state now need an admin
  (`src/api/admin-guard.ts`); non-admins get a reduced view where the web
  needs one. Skill import/export and skill-topic assignments no longer
  reach other users' skills.

### Removed

- **The built-in OAuth connector framework is gone; plugins cover the need.**
  With Atlassian, Linear and GitLab removed it had nothing left to connect, and
  a [plugin package](docs/PLUGIN-PACKAGES.md) brings its own tools, network
  hosts and secrets. Removed: `src/connectors/` (the empty connector list, the
  registry, definitions, `OAuthHTTPTransport`), the `connector_list_tools` /
  `connector_call_tool` agent tools and their injection into workers and swarm
  children, `connector:<id>` role bindings, the `/api/connectors` routes with
  their OAuth authorize, callback and disconnect flows, the connector parts of
  `src/security/oauth.ts` (dynamic client registration, connector token
  storage and refresh, space OAuth state), the space OAuth connectors
  (`/api/spaces/:id/connectors…`), the Connectors tab of the MCP page and the
  onboarding state's connector list. **Kept:** the space's GitHub token, now
  its own section of Space settings (*GitHub*) and API
  (`GET`/`PUT`/`DELETE /api/spaces/:id/github`, same stored secret); the
  Google and Microsoft 365 mailbox OAuth, its browser binding and popup page;
  generic authenticated connections; MCP servers; plugins. **CocoIndex Code
  moved** to the Knowledge page (*Code index*), its code to
  `src/core/code-index/` and its API to `/api/code-index/cocoindex`; a managed
  daemon set up against `/api/connectors/cocoindex` is pointed at the new
  embedding path on its next connect, and its stored MCP server entry and
  index metadata keep their names. Existing installs need no migration:
  `connector:<id>` bindings, the `connector` container and `connector_*` ids
  are dropped from stored role tool lists when they are read (the seeder also
  drops them from unedited system rows), so a role that names one loads,
  spawns and saves; stored connector tokens (`connector_<id>_*`, personal or a
  space's) are never read, the personal ones stay listed and deletable on the
  Secrets page and a space's go with the space when it is purged; permission
  rules naming `connector` stay until deleted on the permissions page.

- **The Atlassian (Jira/Confluence), Linear and GitLab integrations are gone,
  with no plugin replacement.** Removed: the Atlassian and Linear connector
  definitions and logos, the `atlassian` tool (`atlassian_sites`, `jira_*`,
  `confluence_*`) and the capability table it resolved remote tools with, the
  `gitlab` tool (glab CLI) and its card under Settings → Accounts & services,
  the deprecated `*Atlassian*` OAuth helpers and vault-key constants, the
  Jira and Linear choices in the onboarding tracker question (now GitHub
  Issues, an MCP server for admins, or none), and `atlassian` from the `pm`
  role, whose prompt now works from the task list, the knowledge base and
  GitHub. GitHub is unchanged. The OAuth connector framework, left with no
  connector built in, was removed next (above). Existing installs need no migration: a saved `connector:atlassian`
  or `connector:linear` binding, stored connector tokens (personal or a
  space's) and a saved `tools.tracker` answer of `jira` or `linear` are
  ignored; `atlassian` and `gitlab` are dropped from stored role tool lists
  when they are read (the seeder also drops them from unedited system rows),
  so editing a role that still names them saves. Permission rules and vault
  entries that name them stay until deleted on the permissions and secrets
  pages.

- **The `.octipus/` design notes are gone from the repository.** The 19 notes
  (swarm, multi-repo, UX, audits, archived plans) are removed and `.octipus/` is
  git-ignored: it is the Octipus runtime folder (project skills, attachments,
  extensions). Code comments and docs that pointed at the notes now point at the
  maintained docs (`docs/AGENT-ARCHITECTURE.md`, `docs/MULTI-REPO.md`) or say
  nothing. The notes stay in git history.

- **The core Reader is gone; Reader is the example plugin.** The `reader`
  module, `POST /api/reader` (and `/action`, `/tasks`) and the `/reader` page
  are removed. Reading a page is the example plugin `plugins/reader`: install
  it under Admin → Plugin packages → Bundled or with
  `octi plugin install-bundled reader`. A stored `reader` in
  `modules.enabled` is ignored; tasks it made keep `source: reader`.
  Onboarding no longer mentions it. The `replacedBy` field of
  `GET /api/modules` is removed with it.
- **The core research module is gone; Research is the second example
  plugin.** The `research` module, `POST /api/research` and
  `GET /api/research/:jobId`, the `/research` page and its sidebar and work
  navigation entries, `src/core/research/`, the follow-up *Review research*
  to-do, the standalone MCP server's `octipus_start_research` and
  `octipus_get_research_report` and the feature bench's research flow are
  removed. Researching a question in the background is the example plugin
  `plugins/research`: install it under Admin → Plugin packages → Bundled or
  with `octi plugin install-bundled research`, and approve `agent:run` and
  `documents:write`. A stored `research` in `modules.enabled` is ignored;
  tasks it made keep `source: research`, and its finished runs still show in
  the away digest until retention. The research onboarding use case now
  brings recall and live artifacts, and `product` live artifacts and people.
- **Only the plugins Octipus ships are bundled.** A directory under
  `<install>/plugins` other than the example plugin is no longer listed or
  installable as bundled, and an install refuses a plugin store inside that
  directory: local plugins stay outside the install and the repository
  (docs/PLUGIN-PACKAGES.md#where-plugins-live).
- **No plugin loads from the Octipus checkout or the working directory.**
  Legacy `plugin.json` plugins load from `~/.octipus/legacy-plugins/`
  instead of `<cwd>/extensions/`; plugins left there are not loaded and the
  server logs one warning naming them (move them, or convert them with
  `octi plugin convert`). In-process extensions load only from
  `~/.octipus/extensions/`: a project's `<cwd>/.octipus/extensions/` is no
  longer discovered (one warning names what it skips). `extensions/example-plugin`
  and `extensions/.gitkeep` are removed (the example plugin is
  `plugins/reader`); the converter and validator tests use
  `tests/fixtures/legacy-plugin`, and the "Plugin contract" CI job validates
  and converts that fixture instead of scanning `extensions/*`. `.gitignore`
  ignores `/extensions/` and `.octipus/extensions/`. Agents are no longer told
  to create plugins in `<checkout>/extensions/`.

### Added

- **Parents hear when a child waits on the user.** A detached child's open
  approval or question now ends the parent's `collect_children` wait early and
  is reported as `status="waiting"` with a `pendingApproval` / `pendingQuestion`
  element; a parent that is not collecting gets one notice (withdrawn if the
  user answers first). Grandchildren are attributed to their depth-1 ancestor.
  CLI children are only told to use `request_user_approval` when they have it.
- **Retry keys.** `Idempotency-Key` on `POST /api/chat`, `/api/agents`,
  `/api/sessions`, `/api/pipelines`, `/api/hooks` and tool execution; a
  `clientRequestId` on the MCP server's create tools, on `create_pipeline`,
  and on every mutating tool over the CLI bridge. A retry returns the original
  outcome or joins the call still running instead of doing the work twice.
  See [API](docs/API.md#idempotency-keys) and [MCP server](docs/MCP-SERVER.md).
- **Send modes.** `chat.send` / `chat.steer` take `mode: auto | queue | steer |
  restart`, and the server answers with `chat.delivery` saying what happened
  (`steered`, `queued`, `restarted`, `refused`). `auto` keeps today's
  behaviour, except that a buffered CLI root now reports and does `queued`.
  `/stop`, `/abort`, `agent.stop` and the REST stop drop the caller's own
  queued messages and say how many.
- **Lane availability before delegation.** A spawn whose lane model's CLI is
  not installed, or whose provider circuit is open, moves to the lane's backup
  or is refused with the reason, instead of spending a run, a retry and a
  backup attempt. The `primaryModel` mismatch denial names the bound model, and
  a read-only `list_lanes` tool shows each lane's bindings and availability.

### Fixed

- **A burst of webhook deliveries no longer runs parallel agents in one
  session.** A `spawn_agent` hook with `orchestrated: false` started a new
  agent for every delivery at once, all writing into the hook's one session.
  Each run now waits its turn in the session, like orchestrated hooks and chat
  turns do. The spawn itself is still immediate, so a capacity error still
  fails the hook run.
- **`steer_child` no longer reports guidance it did not deliver.** A CLI child
  that has stopped accepting guidance refused it, but the tool still answered
  "Guidance queued". It now tells the parent nothing was delivered.
- **Webhook events are no longer lost at capacity.** A `spawn_agent` delivery
  refused at the agent cap or a quota releases its delivery claim and hands
  back its cooldown / `maxExecutions` reservation, so a redelivery runs; a
  refused scheduled one-shot is retried with backoff for up to 24 h. Cooldown
  and `maxExecutions` skips are logged as `skipped` executions, and two
  concurrent first runs of a hook now share one session.

- **A burst of remote-space frames no longer closes the federation link.** The
  host closes a link that sends more than 60 frames in a second (4429), and the
  visiting install never paced what it sent on the link every one of its
  members shares. A quick burst — a tab reading a space, an agent turn — cut
  the link for all of them until the redial. The visitor now sends at most 40
  frames per second per link; the rest wait in the send queue, in order. This
  was the cause of the intermittent `visitor-residency.test.ts` timeout
  ("timed out waiting for doc.sync through B").

- **Long sessions keep their prompt cache.** Several things rewrote the start
  of a conversation every turn or two, so everything after the system prompt
  was re-read uncached: session compaction ran after every turn once a session
  passed 8k tokens or 20 rows (it now waits for half the model's window, up to
  64k tokens, or 300 rows); the root agent's tool list followed the wording of
  each message (a tool group now stays once the conversation used it); each
  message could switch model by lane (a warm conversation now changes model
  only for a step up, or once its lane is rebound); old tool outputs and the
  saved conversation were trimmed one message at a time (now in batches).
  `complete_taken_task` no longer lists the open ids in its description, which
  changed the tools whenever a task opened or closed. Casual direct replies no
  longer write a cache entry that only an agent turn, on another prompt, would
  have read.
- **Claude conversations survive Octipus's own history edits.** Claude binds
  thinking blocks to the conversation before them; replayed after a truncation,
  compaction, trimmed snapshot or changed tool set they are rejected on accounts
  created on or after 2026-08-31. Signed reasoning is now removed from the
  first edited message on, and the native API also gets `drop_block`.
- **No Claude model gets a forced tool choice or sampling parameters.** Both
  were version lists that missed new models (Opus 5.5 and Sonnet 5.5 rejected
  the forced tool call; Haiku 5.5 rejected every request's temperature). They
  now hold for every Claude model on every path. Older Claude models lose their
  configured temperature; a non-Claude model behind an Anthropic-compatible
  endpoint keeps both.
- **Session cache keys.** OpenRouter's endpoint pin was shared by every
  session never cleared (its key was the root scope `root:` alone); it is per
  session now. OpenAI gets `prompt_cache_key` by default. Children scope their
  key by role, so siblings share the role prefix. The `session` cache policy
  now means long sessions everywhere: one-hour Claude breakpoints, 24-hour
  OpenAI retention (dropped for a model that rejects it), and a session key
  behind LiteLLM or a custom endpoint.
- **CLI sessions restart cold less often.** Resumed main turns no longer
  re-send the vault, bridge and skill-index blocks; plan and permission mode
  and the order of the skill index no longer change the session fingerprint;
  resumed Codex children keep their tool namespace; a stopped first turn keeps
  its vendor session; `/compact` runs on the session's model; a cold launch
  replays at most half the model's window and retries once smaller on
  "prompt too long". Every stored CLI session restarts cold once after this
  release, since the fingerprint inputs changed.
- **The heartbeat reads standing instructions written in the web app.** It
  looked for a `heartbeat` note outside every workspace, but notes made in the
  web app or by an agent are saved in a workspace, so their instructions were
  never read. Any of the user's personal workspaces now counts.
- **`octi setup` with the Claude CLI registers a model that runs.** It saved
  the model id `claude-sonnet-4-6` for the `cli` provider, which matches no
  CLI tool (`cli/claude-code` does).
- **Installing a recommended local model takes over its lanes cleanly.** The
  model it replaced kept its primary role too, so which of the two answered
  was up to the database's row order.
- **A restart asked for from a chat comes back.** `octi restart` run by the
  agent (from the phone, say) was a child of the backend it stopped, and the
  backend's shutdown reaped it halfway: after the stop, before the start. It
  now hands itself off to a detached process. `octi restart` also brings the
  web UI back when it was running, instead of leaving whatever reached the API
  through it (a domain, the phone app) disconnected.
- **The backend repairs itself, and stays reachable when it can't.** `octi
  start` and the Docker image run it under `scripts/supervisor.mjs`. The
  supervisor retries a boot that fails, falls back to the last build that
  stayed up, and restarts a backend that crashes or hangs. When nothing boots,
  it serves recovery mode on the API port: status, logs, retry, rebuild, and
  starting the last good build, behind a token printed by the new `octi
  recovery`. See docs/RECOVERY.md.

- **REST artifact versions keep their behaviour.** Create, edit and restore
  through `/api/artifacts` stored templates as given: inline scripts could
  not run under the embed CSP, a CSS-only edit dropped the bundle and a
  restore pointed at a bundle file that was never copied. They now use the
  agent tool's version writer (`src/core/artifacts/version-writer.ts`), and
  open viewers hear about the new version.
- **A taken artifact slug is a 409.** Drizzle wraps the driver's error, so the
  REST check on the constraint name never matched and answered 500; the agent
  tool returned the raw "Failed query: insert …". Unique violations are now
  read from the error's cause (`src/db/unique-violation.ts`), also for models.
- **Eval suites' double-quoted strings take YAML escapes.** The loader kept
  them raw, so `"\\*\\*[1-9]"` reached `RegExp` as `\\*\\*[1-9]` and
  matched any digit.
- **Declared dependencies.** `htmlparser2`, `domhandler` and `domutils` were
  imported but installed only through `botbuilder`.
- **Docs.** Tools, channels and MCP groups are registered in lists, not
  discovered; lazy tool discovery is not Ollama-only; REST chat turns are
  unattended (an action that needs approval is refused, not asked).

- **Space invite links use the install's public URL.** The link was built from
  the address the owner's browser used, so an owner on `localhost` handed out
  a `localhost` link no other device could open. With a public URL set
  (`PUBLIC_URL` / `oauth.publicUrl`, the address OAuth callbacks and artifact
  links already use) the invite response carries `url` on it.
- **A space session's files open only through the requester's access.**
  `WorkspaceFS.forSession` now takes the requester's space access (role and
  guest scope, from the turn's `AgentContext.space`, the request principal or
  a membership read) and throws when a shared-workspace session is opened
  without it, or with access naming another workspace; a guest gets their
  folders only. Every call site passes it, and a test checks that they do.
- **Coworking seams (final security review).** A deactivated account (and,
  until federation exists, a remote one) passes no space door: its queued
  and running room turns are dropped at once, its queued space jobs
  cancelled and its space data sources paused (resumed on re-activation),
  while an owner can still change or remove its membership. A deactivated
  sponsor is no sponsor: sponsored turns, room and channel probes stop, and
  each space they sponsor gets an audit row; the sponsor pays again once
  re-activated. Trajectories of space and room turns record their space,
  are written under the space's directory and purged with it, never show
  in a personal list, and `distill_skill` reads only the caller's own
  personal runs. Global search no longer returns other users' personal
  model rows. A room post that asks the agent needs the `api:chat` scope
  for an API token, on REST and on the gateway, where a token's scopes now
  travel with the connection (chat, steer, commands and prompt answers
  need `api:chat` too). The admin answer routes no longer list or answer
  requests raised in a space or a room, whatever the admin's membership:
  the requester answers them (an admin acts through audited impersonation).

- **A live space note's reindex is billed to its space.** The reindex's
  embedding cost rows now carry the space (`cost_log.workspace_id`) and
  `funding: 'install'` as their own columns, not only in the row's metadata.
  The docs now list every coworking route, setting and env var
  (docs/API.md, docs/CONFIGURATION.md, `.env.example`), and the coworking
  spec records where the build differs from it.

- **Joining a space lands in it.** The web's workspace list is read again on
  sign-in and on joining; when the read started at sign-in answered after the
  join's own, its older list (without the space) switched the user back to
  their default workspace. Only the latest read is applied now.

- **Guests, registration and remote members (review of S6/S7).** A guest no
  longer sees the space's whole audit log: activity shows the rows about
  their rooms only, with actors they may see. `GET /api/spaces/:id` and the
  space list count only the members a guest sees and name the creator and
  sponsor only among them; budgets are forbidden to guests; live-note
  cursors and file lease holders are limited to the members of their rooms.
  A guest's room turn reads only the worker outputs of their own turns
  (`task_state` tools), and its prompt lists only their folders. The repo
  registry in a space needs the member's role: scanning (which writes the
  space's knowledge) needs `write`, a guest sees only repositories under
  their folders, a space without the membership is refused; creating a
  repository through `/api/workspace` needs `write` there. Remote URLs are
  never shown or stored with credentials. Migration 0135 (edited in place)
  resets malformed guest scopes to the empty scope, carries existing
  guests' `room_members` rooms into their scope, keeps only rooms of the
  guest's own space, renames a local `~` username past any name already
  taken and audits the rename; a stored scope that still does not parse
  reads as the empty scope (logged) instead of breaking every guest list.
  Guest folders whose note-slug form differs segment by segment (`日本/acme`)
  are refused. Registration checks the mode before the invite and the
  invite before telling whether a username or email exists; an unusable
  invite is a 400 `invite_invalid` in every mode, and a name taken meanwhile
  by SAML, SCIM or an admin is a 409. The invite page hands its token to the
  sign-in page in the history state, not the URL. An impersonation whose
  target became remote ends, and remote rows join no org, receive no
  workspace transfer and own no channel binding.
- **Sponsor, budgets and team surface (review of S5a).** A personal CLI
  model can no longer be a sponsor model, nor run or release its
  credential for anyone but its owner. Only the sponsor makes the space pay
  for more (raising `own` → `unattended` → `sponsored`); an impersonating
  admin can neither name the owner sponsor nor choose their models.
  Sponsored work re-reads the space's funding at every spawn and every 30s
  of a running worker, so it stops once the sponsor is gone, in any
  process; a sponsor's account deletion is audited as such; `POST
  /api/agents/:id/message` re-checks the funding and runs inside the
  sponsor context. Room and bound-channel listen probes are install work
  attributed to the space, gated by the space budget only (never the
  sponsor's personal budget nor a member cap); a room's probe is claimed
  in the database before it is paid (migration 0134), and a proactive
  probe is skipped when the question's author may not ask the agent.
  `listen` turns only read. Their answers take 👍 / 👎, and recent 👎 slow
  the gate of rooms and channels down. Space spend sums use the
  `cost_log` workspace index. `task.changed` reaches non-guest members
  only, and the board debounces its refetch. A bound channel's turns pause
  on the space budget only when the space sponsors them. A sponsor's own
  install-type calls on a sponsor model are stamped `sponsor`. Writing the
  same space budget again no longer resets its notices; budget audits carry
  the previous value; a budget author who left is not told the space's
  spend. My work leaves out archived spaces.
- **Group-channel bridge and space connectors (review of S5).** The Git tool,
  the shell, `gh` and CLI agents in a space run with a fresh per-run tool
  home (`HOME`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, git's config) seeded only
  with the space connector's GitHub login and removed after the run; the
  host's SSH agent, askpass, git config and credential helpers are stripped
  and every helper is reset (`credential.helper=`), so neither the host's
  identity nor another member's planted config is ever used. In a space the
  GitHub, Atlassian and `connector_*` tools act through the space's
  connection and are space tools: writes follow the role, reads no longer
  mark the session private. A bridged room cannot be made private while
  bound and only open rooms are relayed; a binding ends (audited,
  `owner_left`) when its owner stops owning the space; thread mappings count
  only for rooms of the channel's current space (binding clears leftovers,
  a stale cached binding is refused); permission prompts go to the platform
  thread only for turns asked there and a room's prompt is never denied for
  a paused channel; guests in a bound channel get a hint and no room; a
  room held by another channel cannot be bound (400, not 500); a purge
  drops the cached binding; superseded space secrets are deleted. OAuth
  callbacks (connectors, space connectors, Google / Microsoft) must come from
  the browser that started the flow (a `SameSite=Lax` binding cookie), and
  `/api/connectors/:id/callback` is a public route like the other OAuth
  callbacks.
- **Rooms (review of S2).** `remember_for_space` goes through
  `routeApprovalFor` as a space write (role cap, and an ASK after a private
  read in a private space session). The space memory and a side panel's
  linked-room transcript are injected per turn only, never stored with the
  turn (`metadata.promptContext`, native snapshots) nor replayed. Room turns
  carry a stop signal checked at handover, before the root agent spawns and
  before the answer is stored; `/stop`, removal and the approval timeout
  stop only the turn they decided about, and tool decisions in a room
  re-check `roomAccess`. `/compact` refuses while a turn runs. Room history
  and compaction page past the 400-row cap; a turn compacts first when its
  transcript exceeds `rooms.transcriptWindowChars` and its history stays in
  that window. A room `yes` resolves its approval by id. A requester's
  limit refusal posts a neutral line in the room (details to the requester
  only), and failed turns no longer broadcast error text. The swarm routes'
  admin bypass never reaches rooms or space sessions. A room creator's
  manage rights need a write role. Queue turns alternate between members;
  `requester` checks the running turn's requester; pruned subscriptions
  clear presence; `room.subscribe` re-checks access after joining.

### Added

- **Dashboards for plugin packages** (docs/PLUGIN-PACKAGES.md#dashboards).
  A package declares `dashboards`, each with widgets (`stat`, `list`,
  `table`, `chart`, `text`). Octipus draws them with its own components,
  with no plugin code in the browser, in the sidebar's Plugins group. Each
  widget shows what one of the package's own `read` tools returns, called
  as the viewer with the input the manifest fixes, and checked against the
  widget's shape. Text is drawn as text, and links go only to the package's
  declared hosts. The permissions summary lists them (`dashboards`, after
  `ui`; an older listing reads as none), the install consent asks for each
  one, and a new dashboard or a re-fed widget widens an upgrade. A widget's
  call carries `store:read` only, never the user's Octipus data; a link to
  a private or local address is refused; a widget's input may not hide
  characters from the consent. The sidebar takes a plugin's icon only from
  its own icon map (a page icon named `constructor` crashed the app shell).

- **Mail and calendar for plugin packages**
  (docs/PLUGIN-PACKAGES.md#mail-and-calendar). New host scopes:
  - `mail:read`: the user's Mail module mailboxes, each message at its own
    protection level (those above the package's `maxProtection` left out in
    the query), and the connected Gmail or Microsoft 365 inbox, which counts
    as level 4.
  - `mail:draft`: drafts as the user, never sent, marked with the package and
    tool (`mail_messages.plugin_source`); a package changes only its own.
  - `mail:send`: for `external` tools only; it counts as egress, so the
    package sees level 1 at most and a call holding more may not send.
  - `calendar:read` and `calendar:write`: the connected Google and Microsoft
    365 calendars at the level an admin sets (`plugins.calendarProtectionLevel`,
    default 3); a package changes only the events it created.

  Personal accounts (the inbox, the calendars) are reached from the personal
  workspace only, and the user's permission rules on each source's own tool
  apply. Migration `0183_plugin_mail_calendar` adds `plugin_items`, what a
  package created; an uninstall or a change of signer or source deletes its
  rows. `writeCalendarEvent` now returns the provider's event id.

  Before release, a security review tightened it: one approved call sends one
  message, and a package at most 20 an hour per user; a send is bound to the
  exact draft checked; replying needs `mail:read` and keeps the original's
  recipients; a Mail module message above `maxProtection` answers `404` (its
  level unsaid); a package's event is not changed once the user invited
  someone to it (`409 has_attendees`).

- **A per-user store for plugin packages** (docs/PLUGIN-PACKAGES.md#store).
  A package declares `store: { quotaBytes }` (default 5 MB, at most 20 MB per
  user) with the host scopes `store:read` and/or `store:write`, and keeps
  small JSON values per key through `/api/plugin-host/store` (get, list, put
  with compare-and-set, delete) or, from its pages, over the bridge
  (`{ octipus: 'store', op: 'store.get' | 'store.set' | 'store.delete' |
  'store.list' }`, `/api/plugins/:name/store/…`). The host keeps the entries
  apart for each user and each workspace, on the user and workspace of the
  call's token or the signed-in page: there is no shared store and no way to
  name another user, and what is kept in a shared space is read in that
  space only. The quota (128 bytes per entry plus its key and value as the
  database keeps it; at most 10,000 entries per user) is checked atomically
  with each write against a running total; a read tool gets `store:read`
  only; an entry records the call's level (the calling session's included)
  and reading it raises the call to it, so a notes or tasks write after it is
  refused. Writes are audited in aggregate. The consent shows *"Keeps up to 5 MB of its own data per
  user"*; the permissions summary carries `store: { quotaBytes } | null`
  after `settings` (index v2 too; a new store or a larger quota widens).
  Settings → My plugin usage shows each plugin's size for you with **Delete
  my data**; admins see the total and per-user size; uninstalling deletes
  every user's data, deleting a user deletes theirs, leaving a space deletes
  theirs of that space. New migration
  `0182_plugin_store`, a `with-store` template, and the contract and the
  authoring skill tell agents to keep per-user data there.
  **`OCTIPUS_PLUGIN_DATA_DIR` is shared by all users of an install**: it must
  never hold user data.

- **Marketplace, Updates and Installed tabs** in Admin → Plugins (Browse
  redirects to Marketplace): instant search folding case and accents,
  categories, sorting, cards with what each asks for, download counts and
  install/update/incompatible/revoked badges, a detail with the README
  rendered safely, the updates with their permissions diff and the
  revocations (cleared with a reason), and per package its origin, revocation
  banner, 30-day usage and running background runs with Cancel
  (`GET /api/plugin-packages/:name/runs?status=running`). Users get Settings
  → My plugin usage (`GET /api/plugin-packages/my-usage`).

- **Offline plugin tooling for publishing: `octi plugin hash`, `pack`,
  `permissions`, `verify`, `verify-index`, and package `validate`.** None
  needs a running server, and each runs the host's own code, so a
  marketplace's CI and its publishing machine compute the same content hash,
  tarball, permissions summary and signatures as an install does. `pack`
  writes a reproducible `.tar.gz` (sorted entries under `<name>-<version>/`,
  ustar, mtime 0, owner 0, modes 0644/0755, a fixed gzip header): the same
  files give the same bytes, and the tarball installs through the
  remote-install reader to the same content hash. `permissions` prints what a
  manifest asks for (host scopes, network hosts, tool effects, contributions,
  pages, `model.trustedInput`, the effective `maxProtection`); `verify` and
  `verify-index` check a package's or an index's signature against given
  public keys (`verify-index` passes when any one of several keys verifies).
  `validate` now checks a plugin package (`octipus-plugin.json`) the way
  `plugin_validate` does; a legacy plugin is checked as before. Each takes
  `--json`, which prints one JSON document on stdout and every diagnostic on
  stderr (docs/PLUGIN-PACKAGES.md#packing-and-publishing).
- **Passphrase-encrypted signing keys.** `octi plugin keygen --passphrase-file
  <path|->` writes the private key as encrypted PKCS#8 (AES-256-CBC); `sign`
  and `sign-index` take the same flag, or ask at a terminal without echo, and
  are refused with no terminal. Unencrypted keys keep working.
- **A package's `marketplace.json` is listing metadata, not content.** The
  content hash of a package's source (`hash`, `pack`, `sign`, `validate`)
  leaves a root `marketplace.json` out, `pack` never packs it, and install
  leaves it out of the installed copy, so editing a listing never changes what
  was signed. In an installed directory a `marketplace.json` that appears later
  counts like any other file.
- **Plugin host API: `documents:write` and `agent:run`.** `documents:write`
  creates a text document for the calling user in the call's workspace (a
  space's role rules apply), recording the package and tool in
  `metadata.sourceRef`, at least at the level of what the call read, and
  updates only documents the same package created. `agent:run` starts a
  background run of the host's own agent as the user (`POST
  /api/plugin-host/agent/runs`, a role, its tools narrowed to search, fetch
  and read) and answers its id at once; a later call reads its status and
  result. No token outlives its call: the run is unattended under the user's
  rules, spend budgets and protection routing, bounded per package and user
  (3 in a burst, 6 an hour, 2 at once), by `plugins.hostAgentRunTokens` (new,
  default 150,000 tokens a run, 0 turns runs off) and the daily plugin
  allowance (which now counts run tokens), and stopped after 20 minutes or
  when the package is disabled, upgraded or its approval changes. Only a
  write tool starts a run; personal workspaces only. Both need an admin's
  approval; the admin page says what they do (docs/PLUGIN-PACKAGES.md#host-api).
- **Research, the second example plugin** (`plugins/research`): a question
  researched in the background by the host's research agent, its cited report
  shown on the plugin's page and saved to Documents when the user asks
  (docs/PLUGIN-PACKAGES.md#bundled-plugins, plugins/README.md).
- **`/plugins/<name>` opens a plugin's first page**, and a plugin's finished
  background run in the away digest links there.
- **Run outcome and evidence.** The run view shows how a run ended, the files
  its tools recorded writing, the files its answer says it saved — *missing*
  until a recorded write matches — and the verification checks that judged it.
- **Agents at a glance.** The sidebar's Mission control item shows runs
  working now and approvals waiting (`GET /api/agents/pulse`); the chat shows
  the agents a session spawned in a strip above the conversation, each opening
  its run; the context inspector's bar marks where older tool output is cut and
  where history is summarised.
- **Run detail: why a run exists.** Opening a run shows its provenance chain
  (what started the tree, the hook, the heartbeat check that passed, the
  pipeline or Companion goal, the parent), its run tree, and the prompt its
  first request held by category (`GET /api/agents/:id/run`). Workers are now
  measured too: their sizes are stored on the agent row.
- **Triggers covers monitors and Companion goals.** *Agents → Triggers* lists
  session monitors (interval, last check, the session they wake) and open
  Companion goals (their actions today as runs) beside hooks.
- **`octi plugin convert`: legacy plugins become plugin packages.** It wraps a
  legacy `plugin.json` plugin's handlers in a generated MCP server and writes
  an `octipus-plugin.json` with every tool `external` until lowered, refusing
  plugins that need the host (hooks, the vault, host imports). The legacy
  in-process loader is deprecated and warns once per plugin. See
  [docs/PLUGINS.md](docs/PLUGINS.md#converting-to-a-plugin-package).
- **Roster: roles as agents.** *Agents → Roster* lists the root agent and every
  specialist role with its lane, tools, heartbeat switch (next check and latest
  decision), assigned to-dos and today's runs. New route:
  `GET /api/agents/roster`. See [docs/MISSION-CONTROL.md](docs/MISSION-CONTROL.md#roster).

- **Triggers page and recorded heartbeat decisions.** *Agents → Triggers*
  shows every heartbeat, schedule, webhook and event hook with what it did
  today on a timeline, the heartbeat funnel (checks → skip reasons → turns
  started) and, per heartbeat, why it did or did not run. Each gate decision is
  now stored in `heartbeat_checks` (migration `0171_heartbeat_checks`, ids and a
  reason only, pruned after 14 days) instead of a debug log line. New route:
  `GET /api/agents/triggers`. See [docs/HEARTBEAT.md](docs/HEARTBEAT.md#seeing-what-it-decided).

- **Mission control and an Agents section.** The sidebar has an *Agents* group
  (Mission control, pipelines, hooks & schedules). Mission control lists every
  agent run of the day with what started it — you in chat, another agent, the
  heartbeat, a schedule, a webhook, a pipeline or Companion — plus what is
  running now, approvals waiting, recorded spend and the next scheduled runs.
  Agents now record their origin (`agents.source`, `agents.origin`, migration
  `0170_agent_origin`); older rows show *Not recorded*. The previous agent list
  moved to *Run history* (`/agents/history`). New route:
  `GET /api/agents/overview`. See [docs/MISSION-CONTROL.md](docs/MISSION-CONTROL.md).

- **Context inspector in the web chat.** A *Context* panel shows how full the
  root agent's context window was at the start of the latest turn and what
  filled it, in nine fixed categories (guardrails, role & persona, delegation,
  workspace, tool definitions, skills, turn context, conversation, other), with
  caps marked, the provider's reported input beside the estimate, growth by
  turn, the text of each section for the latest turn, and a *Compact
  conversation* button. Sizes are stored with each turn's user message
  (`metadata.promptComposition`, sizes only); the text stays in memory. New
  route: `GET /api/sessions/:id/context` (owner only). See
  [docs/CONTEXT-INSPECTOR.md](docs/CONTEXT-INSPECTOR.md).

- **The pipeline plan loop is visible and configurable.** In the template
  editor, a step can be marked **Writes the plan** or **Repeat for each plan
  item**. The list, the graph and the run view frame the steps that repeat and
  say in one sentence what the loop does. A loop can set **Max items per run**:
  items beyond the limit are marked skipped with the reason, and the chat says
  so. **How pipelines loop** explains the QA retry and the plan loop side by
  side. Saving now rejects a QA step in a loop whose retry target sits outside
  that loop; the compiler used to re-target it without saying so.
- **Pipeline steps can force skills.** Skills selected on a step are loaded in
  full into that step's agent prompt, for API and CLI agents alike, instead of
  only being listed in the index. A step can also let the decision model add
  the discovered skills it is confident the task needs (`skills.select`,
  local-only). A missing declared skill fails the step.
- **A setup guide on the home page.** It asks what you use Octipus for
  (build software, run a company, product management, research), then a few
  questions per use case, says what is already set up, shows the list of what
  it will do, and does it through the ordinary routes: models and lanes,
  coding CLIs, areas of work and a shared space, logins for companies with
  their own mailbox, a Telegram link, Jira or Linear, the mailbox and inbox
  watch, standing instructions, permissions and role agents. What is already
  set up, by hand or by an earlier run, is listed as done and left alone.
  Steps only you can do (a sign-in, a chat code) wait for you. Secrets are never saved with
  the progress. `/onboarding` opens it again later. See docs/ONBOARDING.md.
- **The heartbeat can watch your inbox.** Turn on **Watch my inbox** on the
  new *Heartbeat* settings tab and new mail wakes the heartbeat: the agent
  decides per message whether nothing is needed, a task, a short message to
  you, or a reply draft, and records it. Checking costs no model call when
  nothing is new; newsletters and social mail are skipped; mail from before
  you turned it on is never looked at. What was done is kept in
  `email_handled` (ids and outcomes only — migration `0143_email_handled`)
  and shown on the tab. Server switch: `heartbeat.probeEmail`. The same tab
  turns your heartbeat on or off and sets how often it checks.
- **Reply drafts in the mailbox.** `save_reply_draft` (email processor tool,
  allowed by default) and a *Save to drafts* button on the inbox page save a
  threaded reply in Gmail Drafts or Outlook Drafts without sending it.
- **Role agents can run each task through a pipeline.** In the Role agents
  panel a role can be set to work each task through a pipeline template: one
  task per heartbeat, checked out, commented on, closed when the run
  completes, and handed back to you (with a notification) when it does not.
- **Approvals from background runs.** A pipeline step's sign-off can be set to
  approve itself when no one is watching (role agents, the heartbeat, the
  API); you are still asked on runs you start. Approvals from such runs are
  also posted to your own linked chats, where a reply answers them. An
  approval nobody answered now pauses the run as unanswered, not as
  "rejected by user".

- **The companion follows you outside the chat.** Across all of your
  conversations, not just the open one: the tab icon becomes your companion
  in your chosen shape and colour, animated while it works, raising a badge
  when it needs an answer and cheering when it is done, and the title counts
  what happened while the window was away. System notifications say when work
  is done, a question or approval is waiting, or a turn failed; a click opens
  that conversation. A new *Presence & notifications* card on the Persona page
  holds the per-device switches (off by default in a browser, which has to ask
  for permission; a soft chime is opt-in). After twenty quiet minutes the
  companion dozes. See [Desktop](docs/DESKTOP.md#the-companion-in-the-tray).

- **Desktop tray icon.** The desktop app puts the companion in the system tray
  (Windows notification area, macOS menu bar, Linux app indicator), animated
  by what it is doing. Its menu shows that status and whether the backend
  server is running, starts a local server that is down (`octi start`), and
  toggles notifications, start at login (hidden to the tray) and keep running
  when the window closes, which is on by default. Native notifications come
  from the app, so they arrive with the window closed. A second launch brings
  the running app forward.

- **Interactive answers.** In the web chat and in rooms, the root agent can
  answer with a small widget — a calculator, a chart, a diagram, a stepper —
  written as an `octi-ui` fenced block in its reply. The server stores the
  block and leaves a marker line; the web app runs it in two nested sandboxed
  frames with no network, and other surfaces get one plain line. Scripts wait
  for a click when the answer comes from history, a room, a conversation that
  read outside content, an admin acting as the user, or a browser other than
  Chromium. Links and suggested follow-ups need a click on the chat page; what
  happened to a block reaches the model with the next message as enums only.
  An answer can be saved as a static artifact that reaches no network. Off for
  a user, or everyone, with a stored DENY on tool `inline-ui`. See
  [Interactive answers](docs/INLINE-UI.md); `eval/inline-ui.yaml` measures
  when the model uses them.

- **MCP servers in the system prompt.** An agent that can reach MCP tools gets
  an `MCP SERVERS` section, after pi's `mcp_servers` section. It lists every
  enabled server whose tools are not declared, says how this agent reaches
  them (`mcp_list_tools`, or codemode scripts for `codemode` servers when the
  agent runs codemode), and gives one line on what each offers. That line is
  the server's new `description` field (settable when adding a server, on the
  MCP page, with `PUT /api/mcp/servers/:id/description`, or with
  `mcp_add_server`). Without a description, the first line of the server's own
  `instructions` is used, reduced to one safe line. The section has a
  4,096-character budget and sits in the cacheable prefix. See
  [Server list in the system prompt](docs/MCP-INTEGRATION.md#server-list-in-the-system-prompt).

- **MCP tool exposure.** Each MCP server sets how its tools reach the model,
  after pi's exposure modes:
  - `deferred`, the default and the previous behaviour: tools are found through
    `mcp_list_tools`.
  - `direct`: each tool is declared as `mcp__<server>__<tool>` on every request.
  - `codemode`: tools are left out of `mcp_list_tools`; codemode scripts call
    them as `tools.mcp__<server>__<tool>` and find them with `searchTools()`.
  - `hidden`: the bridge refuses every call.

  `toolExposure` overrides it per tool, by exact name or `*` pattern. Set it on
  the MCP page, through `PUT /api/mcp/servers/:id/exposure` and
  `PUT /api/mcp/servers/:id/tools/:tool/exposure`, or with `mcp_add_server`.
  Exposure changes only what the model sees: every call still passes the same
  permission checks, and script calls are routed through `mcp_call_tool`. An
  agent without codemode treats `codemode` tools as `deferred`. See
  [Tool exposure](docs/MCP-INTEGRATION.md#tool-exposure).

- **Codemode.** Agents get a `codemode` tool: the model writes one JavaScript
  script that calls its tools (`await tools.<name>(args)`), and only what the
  script outputs comes back. Chained calls, parallel calls and large results
  that only need filtering no longer re-enter the conversation on every later
  request. Scripts run in a QuickJS/WebAssembly sandbox
  (`@earendil-works/pi-codemode`) with no network, filesystem, timers or
  modules; every call a script makes goes through the same permission, flow
  guard, approval, hook and audit pipeline as a direct call, and a refused
  approval ends the script. Scripts reach real tools only — not
  `spawn_child`, plans or other orchestration meta-tools — and find them with
  `searchTools()`, `describeTool()` and `ALL_TOOLS`, so the tool description
  stays fixed and cacheable. On for every tool-calling worker whose model
  supports tools and is not a small model (`agent.smallModelMaxParams`).

- **Join spaces on other installs.** With `federation.mode` `visit` or
  `both`, a user pastes an invite link with a host fingerprint into
  "join a space on another install" (picker, Settings, or "open there" on the
  host's `/join` page); the fingerprint is shown before anything connects.
  The space appears under "on other installs" with the host's badge, and the
  rooms, notes (live co-editing), tasks and files views work on it through
  `/api/remote-spaces/...` and the gateway's `remote.frame` /
  `remote.event` / `remote.link`. Only a pointer row (`remote_spaces`, in
  migration 0137) is kept; leaving is a tombstone delivered whenever the
  link to the host next opens. Audited `remote_space_joined` /
  `remote_space_left`.
- **Your own agent in a space on another install.** "Ask my agent" in a
  remote room opens a conversation that reads the room live each turn,
  holds only the remote space tools plus web search, and
  never feeds memory, learning, the profile, indexing or compaction. Its
  posts are asked: every time after a private read, the first time in a
  conversation otherwise. "Let my agent answer when addressed" is opt-in.
- **Admin → Federation** lists the installs whose members joined spaces
  here, with block and unblock; **Settings → Spaces on other installs**
  lists yours, their link state and pending leaves. Space member lists mark
  members of other installs.
- **Hosting members of other installs (federation, host side).** With
  `federation.mode` `host`/`both`, invites also return `federatedUrl`
  (`#octipus=<instance id>`), and another install can redeem them over its
  peer link (`space.join`): the member becomes a remote row (at most an
  editor), counted against `federation.maxVisitorsPerInstance`, and passes
  `getMembership` only while its install is active and this install hosts.
  Visitors use the gateway's room and live-note frames through virtual
  connections (same parsing, rate buckets and handlers) and REST-shaped
  operations for rooms, notes (edit proposals), tasks, files (read-only) and
  space memory, checked as for a local member of the same role. Remote posts
  pass the input guard; agent posts are labelled and capped per install per
  room; remote members carry an `[B:xxxxxxxxxxxx]` badge; `@~name@fp8` mentions reach
  them over the link. Their `@octipus` runs a sponsor-funded `remote` turn
  (refused in `own` spaces, ASK denied, a per-install cap), and any turn in a
  room with a remote member has a federated audience (personal and
  credential reads refused). Admins block or unblock an install
  (`/api/admin/federation/instances/:id/block|unblock`). Migration 0137 adds
  the remote-owner guard, `note_edit_proposals.proposer_key` and four audit
  actions. See docs/SPACES.md → Hosting members of other installs.
- **Presence fails closed.** A space presence (or live-note awareness)
  recipient whose membership reads null now sees nobody, not everyone.
- **Guests and registration modes (coworking S6).** A guest's scope
  `{ rooms, folders }` lives on their membership and on guest invites
  (validated on write: shape, and rooms of the space). Guests now reach
  their scope instead of being refused every content route: the rooms it
  names, the members of those rooms, the files and notes under its folders
  (with their live documents, revisions, links and proposals), the tasks
  raised from their rooms and the knowledge chunks of those notes and files;
  documents, artifacts, space memory and private chats stay out of reach.
  The invite dialog picks a guest's rooms and folders, and owners edit a
  guest's access from the members list. `security.registration`
  (`REGISTRATION_MODE`: `open` | `invite_only` | `closed`) decides who may
  register; registration is one transaction (first-account detection and
  an invite token's redemption inside it). The sign-in page hides
  registering when closed and asks for an invite when invite-only. SAML,
  SCIM and admin-created accounts are not subject to it. See
  docs/SPACES.md → Guests, Registration modes.
- **Remote members (coworking S7 contract).** `users.kind` (`local` |
  `remote`), `remote_instance_id`, `remote_user_ref`; local usernames may no
  longer start with `~` (registration, admin creation, SCIM and SAML JIT
  refuse it; migration `0135_guests_remote` renames existing ones before a
  CHECK). Remote rows never sign in (sessions, API tokens, impersonation,
  SAML, passkeys refuse them) and are left out of admin user lists and
  SCIM. See docs/SPACES.md → Across installs.
- **The agent as co-editor, and file leases enforced (spaces).** In a space
  whose agent edit mode is `suggest` (the default), the notes tool's
  changes to existing notes — `write_note`, `capture_note`, `archive_note`
  — become the session's pending edit proposal and answer
  `{ proposed: true, proposalId, status: 'pending', baseSha256 }`;
  `read_note` shows that pending proposal; new notes are still created.
  `direct` mode writes through the live document as before. Members with
  the note open hear of proposal changes live (`doc.proposals`; the
  *proposals* tab shows the pending count). An accepted proposal on a
  closed note refreshes its links and index. Every file-changing
  filesystem tool now checks space file leases (prefix matching for a
  recursive delete or a directory move) and refuses a leased path with who
  holds it and until when. Lease paths are canonical (a lease through a
  symlinked directory names the real file) and the agent's write is checked
  by both spellings; the check and the write hold the path locks of the
  file and its directories, which taking a lease also takes, so no lease is
  taken between an agent file tool's check and its write. Shell, git,
  docker, skill scripts and CLI agents stay advisory (docs/SPACES.md).
  A session's pending proposal is shown rebased onto the note's current
  text (or `stale`), and a write from a newer read carries it forward, so
  an accepted proposal never reverts a member's edit; agents sharing a
  session merge into one proposal or are refused; a proposal is decided
  only as it was read; archive and edits never silently replace each other;
  a write that changes nothing proposes nothing; an archive proposal of a
  note edited since turns stale; an agent's new note (or new daily note) is
  created only while its slug is free. A capture refused for size leaves no
  new daily note behind. Meeting notes stay personal-only in spaces and
  `link_knowledge` edges are direct (documented deviations from §7.4).
- **Space funding, budgets and the team surface** (coworking S5,
  `docs/SPACES.md` → "Funding and budgets", "The team surface"). A space's
  owners choose who pays for the agent — each member (`own`), members for
  their own turns and a sponsor for unprompted work (`unattended`, the
  default), or a sponsor for everything (`sponsored`, each member under a
  per-member cap) — and an owner can sponsor the space with their own
  models. Space budgets cap the sponsor's spend for the whole space and per
  member (Space settings → Budget); a member at their cap is paused alone.
  Sponsored spend never moves a member's personal budget or token quota.
  "My work" lists my open tasks across my spaces; assigning a space task
  notifies the assignee; the space's board updates live from `task.changed`
  instead of polling. Rooms get `listen` and `proactive` modes with the
  group channels' gate (quiet hours, caps, 👍/👎 feedback), paid by the
  sponsor. Migration `0132_space_funding`.
- **Group channels bound to a space** (coworking §9.4). A group channel's
  owner who also owns a space can bind the channel to it (Settings →
  Channels → *Bind to space room*, with the acknowledgement that everyone
  in the channel can read what the room shows; audited). Each thread is then
  a room of the space: members' requests run as room turns as themselves,
  linked people outside the space get a private hint and no turn, the room
  is posted back in the thread, taken tasks land on the space's board (one
  per message) and the space's budget replaces the channel's. Binding closes
  the members' own thread sessions of that channel. Migration
  `0133_space_bridge_connectors`.
- **Space connectors** (coworking §9.5). Space settings get *Connectors*:
  owners connect GitHub (a token) and Atlassian / Linear (OAuth, with their
  own connect, callback and refresh flows) for the whole space. Their
  credentials are a new vault scope, `space`, keyed by the space
  (`dekForRow`, also used by both rotation scripts), readable only through
  the space access layer and never through `{{secret:}}`. In a space the
  shell, the GitHub tool and CLI agents run with an empty per-space
  `GH_CONFIG_DIR` (CLI agents also an empty `HOME`), so a space session
  never acts with the host's GitHub login.

- **Rooms in the web.** With a shared space selected, the sidebar gets
  *rooms* (with the unread count) and `/rooms` lists the space's rooms with
  unread badges. A room shows everyone's posts (others on the left with name
  and initials, mine on the right) and Octipus's answers; the composer has
  an "Ask Octipus" toggle and `@` completion of the room's members; a turn
  strip says "Octipus — answering Anna", "waiting for Anna to approve" and
  who is queued (cancel for my own requests). Side panels: members (a
  private room's creator and space owners add and remove), space memory
  (add and retract with `write`), settings (title, visibility). Also mute,
  "Ask privately" (opens my private chat in the space linked to the room),
  new room for editors and owners, presence avatars in the header saying
  where each member is, catch-up after a reconnect (`afterMessageId`), and
  a notice when the room is taken away (`room.removed`). `/chat?session=<id>`
  opens that chat.
- **Rooms.** A space's shared chats (coworking S2, backend): sessions with
  `kind = 'room'` (`space` or `private`), every space starting with
  "General". Members post, `@mention` each other and ask Octipus; each turn
  runs as its requester through a per-room queue
  (`rooms.maxQueuedPerMember`, `rooms.approvalTimeoutMinutes`), sees the room
  as one fenced, attributed transcript (compacted past
  `rooms.transcriptWindowChars`), and its answer reaches every member while
  the stream reaches the requester only. New gateway frames `space.subscribe`
  and `room.*`, events `room.*` and `space.presence`, routes under
  `/api/spaces/:id/rooms`. Space memory (`/api/spaces/:id/memory`, the
  agent's `remember_for_space`, `spaces.memoryMaxItems`) is injected fenced
  into every space session. Private side panel: a space chat with
  `context.linkedRoomId`. Migration `0129_rooms`. Rooms are invisible to
  every personal route, their creator included; a room's user row is
  written once, with its author (the repositories refuse any other).
  `notify()` takes the workspace as an argument. See docs/SPACES.md.
- **Live space notes.** Members of a shared space edit a note together: the
  notes editor binds to a shared document (Yjs over the gateway: `doc.join`,
  `doc.update`, `doc.awareness`, `doc.leave`), shows the others' cursors and
  avatars, and saves by itself ("Saved"). Every other writer — REST saves,
  quick capture, meeting notes, the agent's note tool, restores, accepted
  proposals — is merged into the live text from the base it read (three-way
  merge) or refused as stale (409), never reverting typing; `read_note` and
  `GET /api/notes/:id` return the live text and its sha. Space notes get a
  history (revisions with authors, restore), the agent's edit proposals
  (`note_edit_proposals`: diff, accept, reject; `workspaces.agent_edit_mode`),
  and space files get leases ("Ben is editing", `file_leases`). Migration
  `0130_live_documents`; new settings `spaces.noteMaxBytes`,
  `docMaxUpdatesPerSecond`, `docPersistDebounceMs`, `docReindexMinutes`,
  `docBaseTtlMinutes`, `fileLeaseTtlSeconds` — startup now fails when
  `spaces.noteMaxBytes` exceeds half of `gateway.maxFrameBytes`. New
  dependencies: `yjs`, `y-protocols`, `node-diff3` (server) and
  `y-codemirror.next` (web): a CRDT and a three-way merge are not 20 lines.
  See docs/SPACES.md.
- **Own models.** Settings → My models (`/api/me/models`) adds a personal
  model — provider, model id, your key or CLI token, a custom endpoint for
  custom providers — and binds it to text lanes; your turns then run on it,
  in your sessions and in spaces. Personal rows (`model_config.owner_user_id`,
  `user_model_bindings`, migration `0131_personal_models`) never appear in
  anyone else's lists, routing, defaults or caches; admin model and topic
  routes refuse them. Keys resolve under the row's owner, a custom endpoint is
  SSRF-checked on every request, and personal CLI rows run with a per-user
  CLI home and the owner's token. See docs/SPACES.md ("Own models").

### Changed

- **Plugin model calls on Antigravity and Vibe take multi-line prompts.** An
  approved `model:cli-tools` call hands the prompt to them on stdin instead of
  the command line: Vibe with a bare `-p`, Antigravity as a stream-json user
  event (`--input-format stream-json --output-format stream-json`, which also
  reports token usage). A prompt with a line break, which every prompt with a
  system text has, was refused on both. The command-line guard against line
  breaks is unchanged; agent runs are unchanged.
- **The flow guard lets an agent message its own user after reading mail.**
  `send_to_user` to the session's own user is delivered only to that user's
  verified chats, so it is no longer escalated to an approval after the
  session mixed private data with outsider text. Every other send still is.
- Install-topic model calls (compaction and its chunk summaries, learning,
  link resolver, weekly review, evaluators, document processing, the group
  listen probe) are now stamped `install` in `cost_log` whatever turn they
  run in, through `withInstallUsage`. Spend budgets' `user_id` is nullable
  for space budgets (author only); a user's own budgets are still deleted
  with their account (a trigger replaces the cascade).

- **Live space notes: review fixes** (coworking S3). Nothing typed is lost
  on a reconnect: a closed note stays in memory for a minute (a member whose
  connection blipped keeps the epoch and Yjs merges what they typed
  offline), and after a rebuild (a restart, a reload) the editor merges its
  unsent text back through the hub (`POST /api/notes/:id/merge`, three-way
  from the last server text it synced) — a clash keeps the member's text
  with a notice and a "Copy my version" button. Shutdown saves every open
  note. A body write to an existing space note must name its base
  (`baseSha256`; `write_note`'s `base_sha256`): without one it is refused
  (400 `base_required`) instead of reverting what changed since its read;
  meeting re-imports merge from the body they last rendered. The hub owns
  awareness (a connection holds at most two client ids, never another's,
  and its states name its member), refuses updates that write outside the
  note's text (other root types, embeds, formats, `\r`) and caps the
  encoded document, builds notes with `\n` line endings (CRLF bodies are
  normalized and saved) and normalizes every writer's text. The live
  reindex keeps explicit and meeting tags; capture appends to an open daily
  note instead of merging; an archived note opens read-only; a membership
  change during a join takes effect on the next frame; a failed save keeps
  its authors; read bases outlive persist-only ones. See docs/SPACES.md.

- **Model identity is the row name.** Agent contexts carry `modelName`
  beside the provider `model` id, and providers re-read rows by
  `modelConfigName`; a modelId lookup returns install rows first, then the
  requester's own. `/model` overrides are per (session, user). Explicit model
  names (`/model`, `POST /api/agents`, `/api/agents/route`, pipeline stage and
  executor models, `/v1/chat/completions`, evaluation runs) resolve only to a
  model the caller may use; a registered model they may not use is refused
  instead of passed through. `GET /api/models/:name` returns only models the
  caller may see. Custom providers resolve an install row's key from the
  system vault only (no longer the requester's vault first).

- **Shared spaces in the web.** The workspace picker lists "my workspaces"
  and "shared spaces" (with role badges) and creates a space; a space has a
  settings page (`/spaces/<id>/settings`: name, members, invites with a
  copyable link, activity, archive, delete) and invite links open a join page
  (`/join/<token>`) that signs in or registers and comes back. Notes, tasks
  and documents follow the member's role (read-only for commenters and
  viewers, and in an archived space). A removed member is switched back to
  the default workspace and told so; the server's 404 for a denied workspace
  now carries `code: "workspace_denied"`. See docs/SPACES.md.

### Security

- **Own models: review fixes** (coworking S4). A personal CLI model's
  one-shot completions (mail triage, reader, research, `/plan`, the casual
  path) run without native tools (`--tools=`, no settings files) in a
  directory under the owner's CLI home, never in the shared workspace root;
  a CLI tool that cannot run tool-less (Codex, Antigravity) can no longer be
  bound to a lane and serves agent runs only. A personal CLI agent run is
  locked to its adapter's safe mode, as in a space (Claude: permission mode
  `default` with the stdio permission tool and only a locked settings file;
  Codex: read-only; Antigravity: plan mode); Mistral Vibe is refused for
  personal rows. Codex MCP discovery reads the run's own `CODEX_HOME`. A
  personal row's key is released only to its owner at the provider layer
  (`resolveModelKey`), so another user's request on it fails whatever key it
  brings; `/compact` never compacts another member's conversation on their
  personal model. In a space a personal CLI binding a commenter (or an
  adapter without a space mode) may not use falls through to the install
  lane instead of failing the turn, and side questions and the voice plan
  gate follow the same rules. `isRegisteredModel` only considers install
  rows and the caller's own (plus the reserved `u/` namespace), so another
  user's personal model id no longer blocks a passthrough. Red-team runs,
  `POST /api/eval/run` and `PATCH /api/topics/:topic/config` refuse personal
  rows. Admins see disabled and other orgs' install rows in
  `GET /api/models/:name` again; install rows fall back to the env key when
  the vault cannot be read (personal rows still fail loud). The SSRF guard
  also refuses `fec0::/10`, `ff00::/8`, IPv4-compatible `::a.b.c.d`, 6to4 of
  a private IPv4, local-use NAT64, Teredo and documentation ranges, and a
  personal endpoint must be `https://`. Personal rows may set
  `contextWindow` and `maxTokens` within bounds, and a compaction that runs
  on a personal row is funded `own`.
- **Shared spaces: review fixes to the access layer** (coworking S1).
  Admins no longer list, read or stream another user's agents in a space
  (history list, live list, live details, events, stop). Starting an agent or
  a pipeline, or messaging an agent, never keeps a space principal from a
  `?sessionId=`, so a viewer or a member of an archived space cannot start a
  run there; such routes keep the space for reads and stops only. The
  personal repositories refuse to write into a space (an agent context in
  a space, or a caller's `workspaceId`). Viewers cannot open chats in a space;
  an archived space refuses new chats, chat edits, learning checks, monitor
  events and plan feedback. Removing, demoting or the leaving of an owner
  revokes the invite links they made, and an accept refuses a link whose
  creator is no longer an owner. Task wakeup notifications go only to people
  with access at send time: a personal task's owner, a space task's author
  and assignee while members; space assignees must be members and personal
  ones the owner, and space tasks are never assigned to roles or nodes.
  Archive also cancels the space's queued jobs and expires its pending
  prompts; a removal cancels the member's queued jobs there. A failed
  follow-up after a committed membership change is reported in a `warning`
  instead of a 500. Impersonated space changes name the admin in the audit
  row. A user who authored space content cannot be deleted; a deletable one
  leaves their spaces with audit rows first. The personal predicate is now
  positive (no workspace, or a personal one), the gateway lets members follow
  a space artifact, a page slug prefers the viewer's personal artifact and
  never opens a space page to a guest, and a space search uses no personal
  repositories or extra scan paths.

- **Events reach their own user only.** Every gateway and turn event now names
  its user, including swarm, pipeline and agent-stream events that used to go
  out user-less to every signed-in browser. `/ws` and `/gateway` deliver an
  event to its user's connections only, whatever the connection's trust level
  or admin rights.
- **Live-artifact events go to the artifact only.** Artifact updates are sent
  to connections subscribed to `artifact:<id>` after an access check (the
  workspace owner), and the gateway now accepts the `artifact_token` sign-in
  the embed SDK sends; such a connection can follow its one artifact and
  nothing else.
- **The artifacts tool uses the agent's workspace.** It no longer guesses one
  of the user's workspaces; without a workspace in context it refuses.
- **Documents, knowledge and search no longer cross users** (coworking S0a,
  L1–L3). The documents tool lists, reads and searches only the user's own
  documents, and an admin's agent no longer inherits the admin bypass. The
  knowledge base is per user: every chunk has an owner, and the knowledge
  routes, the knowledge, documents and notes tools, and global search see the
  caller's own entries plus the product docs. Admins reach the whole
  knowledge base only with `?scope=install` on `/api/knowledge`, which is
  audited. Global search returns only the caller's sessions and hooks.
  Migration 0125 assigns owners to existing chunks (documents, notes, and
  workspace files by path); chunks it cannot attribute are visible to admins
  through `?scope=install` only.
- **Deactivation takes effect at once.** Deactivating a user (admin console or
  SCIM) revokes their sessions, refuses their API tokens, passkey, SAML and
  device-pairing logins, closes every socket they hold, stops their agents,
  expires their pending permission and approval prompts and ends any
  impersonation of them. Sessions now read `is_active` and `is_admin` from the
  database on every request, so a demoted admin loses admin rights immediately
  (their gateway connections are closed and reconnect without them). Hooks,
  heartbeats and monitors of an inactive user no longer fire. Migration
  `0126_user_deactivation` adds `users.deactivated_by`.
- **SCIM is scoped to its org.** A SCIM token's DELETE and PATCH answer 404 for
  users outside its org, deactivate an account only when no other org holds it,
  and can no longer re-activate an account an admin deactivated (409). SCIM
  DELETE now answers a proper empty 204. SCIM POST no longer adopts an
  existing account outside the org by `userName` (409 `uniqueness`), and
  PATCH changes `userName`/`emails` only on an account the org alone holds
  (403 otherwise). An org's SAML IdP signs in only that org's members or new
  accounts; a username held by an account outside the org is refused (403),
  so an IdP can no longer sign in as the install admin.
- **Deactivation closes sockets that were still signing in**, and an admin's
  deactivation of an account SCIM had already switched off is recorded, so
  that org's SCIM cannot undo it. If a step of a deactivation fails, the admin
  edit still applies and the response carries `warnings`.
- **Global search returns only skills the caller can see** (system, own and
  their orgs'), not other users' private skills.
- **Live-artifact viewers are bounded.** At most 50 `artifact_token`
  connections per artifact; each closes when its token expires, and all close
  (with their tokens refused) when the artifact is deleted or its visibility
  changes.
- **The bundled web server appends its peer to `X-Forwarded-For`**, so it can
  be listed in `TRUSTED_PROXIES` (`127.0.0.1,::1` in the Docker image) without
  letting clients pick their own address.
### Security: trust, client addresses, and who answers a request

- **No more `local` or `system` trust.** The `local` gateway auth method and
  the `~/.octipus/local-token` file are gone (the server no longer writes it),
  as is the unwired `hmac` method. An admin signed in on loopback, or behind a
  reverse proxy on the same host, used to see every user's events and pass
  every session ownership check; admin API tokens did so from anywhere. Every
  connection is now `user` trust: ownership checks (joining a session,
  `/history`, `/proposals`, `agent.stop`, `chat.steer`, `chat.interject`)
  compare user ids, and admin-only commands read `is_admin` from the database.
  `/abort` and `/status` cover the caller's own agents only.
- **The TUI signs in with your account.** It uses the CLI login
  (`~/.octipus/session.json`), opens the login prompt once when there is none,
  and does not connect without one. `/logout` disconnects.
- **Client addresses come from the socket.** `X-Forwarded-For` / `X-Real-IP`
  are honoured only from proxies listed in the new `security.trustedProxies`
  (`TRUSTED_PROXIES`, default empty) — for the gateway, REST rate limits,
  login and passkey lockouts, and audit rows. The gateway's per-address cap now
  applies only to connections that have not authenticated yet.
- **Voice mode** on `/ws` checks session ownership, and the voice planning gate
  is keyed by session and user.
- **Requests are answered by their requester.** Admins no longer answer other
  users' permission requests or agent approvals through REST, `/ws` or the
  gateway, and `GET /api/chat/approvals/pending` lists the caller's own. An
  admin unblocks someone else's run through
  `POST /api/admin/permission-requests/:id/resolve` or
  `POST /api/admin/approvals/:id/resolve` with a `reason`, which is audited;
  `GET /api/admin/permission-requests` and `GET /api/admin/approvals` list
  what is pending.

**Upgrade notes:** run `/login` in the TUI once (it prompts on start). If
Octipus runs behind nginx, Caddy or a load balancer, set `TRUSTED_PROXIES` to
the proxy's address, or every client shares the proxy's address for rate
limits. Extensions that registered commands with `minTrustLevel: 'local'`
now use `adminOnly: true`; an extension that still passes `minTrustLevel:
'local'` or `'system'` gets an admin-only command and a deprecation warning.

### Security: sign-in hygiene

- **Sign-ins are audited.** `/api/auth/login` and `/api/auth/login-mobile`
  write a `login` audit row on success and `login_failed` (with the reason:
  unknown user, bad password, bad TOTP code, disabled, locked out) on failure;
  `/api/auth/register` writes `user_created`.
- **TOTP works in the web.** The login page now reads the server's
  `requiresTOTP` answer, shows the code field and resubmits with the code;
  TOTP accounts could not sign in from the browser before.
- **Back to where you were.** Login and register accept a `returnTo` that must
  be a same-origin path (one leading `/`, no `//`, no backslash, no control
  characters); anything else is refused with 400. The web sends the page you
  were on and returns there after sign-in.
- **Pairing codes are hashed and single-use.** Device pairing codes are stored
  as `sha256(code)` and redeemed with an atomic get-and-delete, so two
  concurrent redeems of one code no longer both get a session. Codes issued
  before the upgrade stop working (they expire within five minutes anyway).
### One multi-user model

- **Workspaces are always on.** The `multiuser.orgWorkspaces` setting
  (`MULTIUSER_ORG_WORKSPACES`) is removed: `/api/me/workspaces` and the
  workspace header always work, and `/api/admin/orgs` stays admin-only. A
  stored row for the setting is deleted at startup.
- **Workspace resolution fails closed.** When the workspace of an
  authenticated request cannot be resolved, the request answers 503 instead
  of running without a workspace filter.
- **No stand-in users.** A user id that is not a real user is no longer mapped
  to "the first admin" (skills routes) or "the first user" (the profiles
  tool); it is an error. `'system'` is only ever a system job: system jobs keep
  their rate-limit exemption and stay outside per-user Docker isolation, and
  the Atlassian tools refuse without a real user. With
  `security.dockerIsolation: enforce`, a Docker call with neither now fails
  instead of running unisolated.
- **User deletion is guarded.** Deleting a user goes through one check
  (`assertDeletable`), which refuses the last active admin.
### Workspaces: notes, integrity, transfer and workspace secrets

- **Notes follow the request's workspace** (coworking S0c). Every note route
  (list, query, index, tags, read, backlinks, suggestions, pin, delete,
  capture) shows the current workspace's notes plus user-level ones, and new
  notes land in the current workspace. `workspaceId` is no longer accepted in
  the `POST /api/notes` and `POST /api/notes/capture` bodies. A slug lookup in
  a workspace falls back to a user-level note of that slug, so daily capture
  appends to an existing user-level daily note instead of creating a second
  one.
- **Migration 0127 repairs workspace stamps.** Notes, tasks, knowledge links,
  repos and background jobs whose `workspace_id` named a deleted workspace or
  another user's workspace become user-level; a note that would then clash
  with a user-level note of the same slug is renamed `<slug>-<first 8 chars of
  its id>` (the existing user-level note, or the oldest, keeps the slug). The
  five columns now reference `workspaces(id) ON DELETE SET NULL`, like every
  other `workspace_id`. Deleting a workspace renames its notes the same way
  when their slug is already used at user level.
- **Transfer moves the whole workspace.** Transferring a workspace now moves
  the previous owner's rows of every workspace table — notes, tasks,
  memories, embeddings, links, repos, agents, pipelines, jobs and the rest,
  not only sessions, documents and hooks — in one transaction. Workspace
  secrets are re-encrypted under the recipient's key; before, a transferred
  secret could no longer be decrypted. The table list lives in
  `src/db/workspace-tables.ts`, and `scripts/backfill-workspace-id.ts` uses
  it too (it now also stamps notes, tasks, memories and links). The
  workspace's files directory moves to the recipient too (see "Files per
  workspace"); a transfer onto an existing directory is refused with 409
  `files_conflict` and changes nothing.
- **Workspace secrets resolve by name.** `getByName` with a workspace now
  returns that workspace's secret (it was selected, then never decrypted). A
  `scope='workspace'` secret bound to no workspace is no longer shown or
  returned in every workspace.

### Workspaces become real (coworking S0c)

- **A turn runs in its session's workspace.** The root agent, role heartbeats
  and gateway `chat.send` used the user's default workspace whatever session
  they ran in, and went on without one when it could not be resolved. A turn
  now uses `session.workspaceId` (the default only when the session has none),
  checks the user owns it, and fails rather than run unscoped. Tasks,
  artifacts, files and memories a turn produces land in that workspace.
- **The TUI's workspace is honoured.** The gateway reads `?workspace=` (id or
  slug) at sign-in and stores it on the connection; a name that matches none
  of the user's workspaces fails the sign-in. `chat.send` accepts a
  `workspaceId`, and new sessions are created in it, else in the connection's
  workspace. An existing session keeps its own.
- **Files per workspace.** Each workspace has its own file root,
  `users/<id>/workspaces/<files_dir>/files`. `workspaces.files_dir` is stored
  (migration 0127): the workspace that is each user's default at upgrade
  keeps `default`, every other workspace (and every new one) uses its id.
  Changing the default, or creating a workspace as the default, moves no
  file. A transfer renames the directory to
  `users/<recipient>/workspaces/<workspace id>`; deleting a workspace removes
  its directory. The file browser,
  the Changes tab, `/changes`, uploads, the repo registry and the shell all
  follow the session's or the request's workspace. A user's agent never
  resolves to the flat `workspace.rootPath`: an agent without a real user is
  refused, and a system job names its root.
- **Shell `cwd` is checked.** A named working directory must lie inside the
  workspace root, an allowed extra path or the dev-mode project; a relative
  one is taken from the workspace (or project). This keeps the work where the
  evidence gate and Changes tab look; it is not a sandbox.
- **A pipeline stage's verify command runs in the session's workspace.** It
  had no workspace outside dev mode and was reported to the auditor as not
  run.
- **Hooks and link suggestions follow the workspace.** A directly spawned
  (non-orchestrated) hook agent runs in the hook session's workspace, and
  note link suggestions offer only notes of the note's workspace and
  user-level notes.
- **A new user's first requests no longer race.** Parallel first requests
  each creating the default workspace could collide and answer 503; the
  insert now tolerates the race and reads the winner's row.

**Behaviour changes for users of several workspaces:** files created from a
non-default workspace before this release sit in the `default` directory and
stay there (nothing is moved); new files from that workspace go to its own
directory. Memories now follow the session's workspace: facts learned in a
non-default workspace, which were filed under the default one, are no longer
mixed into it. Existing memories are not migrated.

### Shared spaces (coworking S1, backend)

- **Spaces: workspaces several people share.** A space is a workspace with
  no owning user; access is membership with a role (`owner`, `editor`,
  `commenter`, `viewer`, `guest`), read from the database on every request.
  `POST /api/spaces` creates one (who may: `spaces.creation`, `any_user` by
  default or `admins`); `/api/spaces/:id/...` renames, archives, lists and
  manages members and invites, and shows the space's activity. Someone who is
  not a member gets 404 for every space, admins included. See
  [docs/SPACES.md](docs/SPACES.md).
- **Invite links.** Owners create links per role with a clamped lifetime
  (`spaces.inviteMaxTtlHours`, default 30 days) and a use count; only a hash
  of the token is stored, a single-use link admits exactly one person, and a
  revoke reaches only its own space. `GET /api/invites/:token` previews a link
  without signing in; both invite routes are rate-limited like logins. A space
  holds at most `spaces.maxMembers` members (default 50).
- **Removal takes effect at once.** Removing or downgrading a member stops
  their agents in the space, expires their pending prompts there and pauses
  the data sources they own on the space's artifacts. The last owner cannot be
  removed, demoted or leave, and a user who is the last owner of a space
  cannot be deleted.
- **Archive, then delete for good.** An archived space is read-only and its
  agents stop. An owner can delete it once it has been archived for
  `spaces.purgeAfterArchiveDays` (default 7): every row and file of the space
  goes, in one transaction; its audit and cost history stay.
- **Every change is audited** with the space's id (`space_*` audit actions).
- Migration `0128_spaces` adds `workspaces.kind`, `created_by` and
  `archived_at` (and makes `user_id` nullable for spaces only),
  `workspace_members`, `workspace_invites`, `workspace_id` on `audit_log`,
  `permission_requests` and `cost_log`, `funding` on `cost_log` and `agents`,
  paused flags on artifact data sources, and a per-workspace unique note slug.
- **Members work on the space's content.** With a space selected
  (`X-Octipus-Workspace`), notes (and their links), tasks and comments,
  documents, artifacts and their pages, knowledge, sessions and notifications
  read and write the space's rows by the member's role: viewers read,
  commenters also comment, editors and owners write (a refused write is 403,
  an archived space 409). Every other route runs in the caller's personal
  default workspace, except agents and pipelines addressed by id, which follow
  their session. A header naming a space you are not (or no longer) a member
  of is 404 on every route but sign-in, health, `/api/me/workspaces` and
  `GET /api/spaces`.
- **Personal paths never return a space's rows**, for their author or an
  admin: the personal repositories, the note and link repositories, the notes
  graph, global search, knowledge search, role-agent and heartbeat probes,
  memory routes and the admin session lists all exclude shared workspaces.
  Links resolve inside one scope, vault sync stays personal, and a space's
  files live in `<workspace.rootPath>/spaces/<id>/files` and its uploads in
  `<workspace.documentsPath>/spaces/<id>/`.
- **Space tasks wake their own people.** Closing a blocker wakes and notifies
  the dependent task's author (and a user assignee), whoever closed it; a
  space task never wakes a role heartbeat. A data source of a space artifact
  refreshes only while its owner may write in the space, and pauses
  otherwise. Private artifacts in a space are their creator's only.
- **Notifications carry their workspace.** A notification filed with a
  `workspaceId` lists in that workspace's inbox (and user-level ones
  everywhere).
- **The agent works inside a space.** A member's private chat in a space
  runs the agent there: its tools read and write the space's notes, tasks,
  documents, artifacts, knowledge and files by the member's role. Every
  agent context is built in one place (`buildAgentContext`,
  `src/core/agent/context.ts`), which reads the membership and refuses a
  viewer, a removed member, an archived space, and schedules or monitors in a
  space; children inherit the space, what started the run (`trigger`) and
  who pays (`funding`, `own` for now). `POST /api/agents` follows the session
  it names: 403 for a viewer, 404 for a non-member, 409 for an archived space;
  `POST /api/pipelines` likewise, for roles that may write (editors, owners).
- **One decision for every tool call.** `routeApprovalFor` re-reads the
  membership on every call, on all six dispatch paths (agent loop, tool
  middleware, CLI permission relay, MCP, verification gate, action recovery):
  a commenter's agent runs only read and comment tools, nobody runs a
  personal-only tool in a space (scheduling, monitors, pipelines and recipes,
  memory and profile tools, vault sync, indexing, meeting notes, writes
  through personal connectors — the agent is told why), and once a session
  has read your private data, writing into the space asks first even with
  the flow guard off.
- **Personal memories and profile stay out of spaces**, child workers
  included, and space sessions are never learned from (`sessionAudience`).
- **CLI models in spaces** run only in a mode where their own tools stay
  behind Octipus's checks (Claude: permission mode `default` with the
  permission tool; Codex: read-only; Antigravity: plan); Mistral Vibe is
  refused, commenters use API models only, and an install CLI login serves
  spaces only when its model is marked `metadata.cliAgent.sharedUse: true`.
- **Spaces: personal connections and agent configuration stay out.** In a
  space, writes go only through tools known to act on the space; writes
  through your OAuth connectors (`connector_call_tool`), MCP servers, real
  browser (`browser-ext`), MCP server administration, skill distillation and
  `update_skill` are refused and not offered, and their reads mark the
  session private so writing that data into the space asks first. The flow
  label is now stored on the session (`sessions.flow_label`, migration 0128),
  so a restart keeps it. A Claude-binary CLI model in a space reads no user,
  project or local settings file (`--setting-sources=` with a locked
  `--settings` file), and nothing writes `.claude/`, `.codex/`, `.gemini/`,
  `.agents/` or `.mcp.json` in a space's files. A pipeline's verify command
  follows the space rules, a pipeline resumes only for a starter who can
  still write, and a space artifact takes no `tool` or `mcp` data source.
- **Only an administrator edits a system skill.** Before, any signed-in user
  could change a skill shared by every user (`update_skill`, `PATCH
  /api/skills/:id`).
- **Cost rows name the space.** Every model call of a space turn writes
  `cost_log.workspace_id` and `funding`; compaction, embeddings, memory
  extraction, toolshim, decision, vision and OCR calls are stamped `install`.
  Permission requests carry their workspace, and an admin who is not a member
  of a space can neither list nor answer its requests and approvals.
### The web is on the gateway (coworking S0d)

- **One gateway connection per tab.** The web app's chat page, permission
  prompts, recommended-models panel and documents page share one `/gateway`
  connection per browser tab (`/auth/ws-ticket` → `auth`). Every tab of a user
  receives that user's events, so a reply, an error, a steered message or an
  answered prompt shows in all of them. **The legacy `/ws` and
  `/ws/permissions` sockets are removed** — integrations still on them must
  move to `/gateway` (frame mapping in `docs/architecture/gateway.md`). The
  browser extension's `/ws/browser-bridge` and `/voice` are unchanged.
- **New gateway messages:** `chat.error`, `approval.resolved`, `document.*`,
  `model.install_progress` and `voice.speak` events; the `permission.pending`
  snapshot after `subscribe` (a tab opened after a prompt was raised shows
  it); client `voice.set` and `replay { sessionId, afterEventId }` (own
  sessions only). In-app deliveries to `webchat:<you>` arrive as a
  user-stamped `chat.message`. `approval.respond` for an unknown or foreign
  request now answers `APPROVAL_NOT_FOUND` instead of nothing.
- **Limits are settings:** `gateway.maxConnectionsPerUser` (default 20, was a
  fixed 10; a tab over it shows "Too many open tabs"),
  `gateway.maxFrameBytes` (default 256 KiB, the gateway socket's
  `maxPayload` — it was the `ws` default of 100 MiB) and
  `gateway.replayMaxSessions` (default 500; replay buffers are now capped,
  least recently active first, and dropped when a session is deleted or
  archived). Env: `GATEWAY_MAX_CONNECTIONS_PER_USER`,
  `GATEWAY_MAX_FRAME_BYTES`, `GATEWAY_REPLAY_MAX_SESSIONS`.
- **Workspace switches are clean.** The API client's workspace header (now
  the workspace id) changes synchronously on a switch and the query cache is
  cleared; workspace-scoped queries key on the workspace id.

- **Tabs keep to their own session.** A reply, error, status line or
  streamed text of another session (another tab's turn) no longer stops this
  tab's spinner or replaces its streamed text, a tab on "New chat" no longer
  jumps into another tab's session, and only the spoken turn's own reply is
  read aloud. `voice.set {on:false}` from a tab that did not turn voice on is
  ignored, and a closing tab takes a session out of voice mode only when no
  other tab of the user holds it there.
- **A refused message says so.** A `chat.send` refused before its turn starts
  (`INVALID_MESSAGE`, `RATE_LIMITED`, `SESSION_NOT_FOUND`) stops the spinner
  and shows why; the chat page checks the 100 000-character limit and the
  frame cap (`auth_ok.maxFrameBytes`) before sending.
- **Reconnects do not duplicate.** `replay` without `afterEventId` answers
  `gap: true` with no events (the client reloads from REST) instead of the
  whole buffer; a replayed reply and another tab's steered message are
  matched against their persisted rows instead of shown twice. `auth_ok`
  reports the frame cap the socket enforces (read at start), not a later
  config value. Replay buffers are also dropped for sessions removed by a
  space purge. Model install progress is re-read on reconnect.
- **In-app delivery needs a chat page.** A delivery to `webchat:<you>` counts
  as delivered only while a connection shows the chat page (it subscribes to
  the `chat:inbox` resource); an open terminal or a tab on another page no
  longer counts.

**Behaviour changes:** the TUI uploads pasted or attached images over REST
(`POST /sessions/:id/attachments`, creating the session first if needed) and
names them in `fileRefs`, as the web does, so images up to the 10 MiB upload
limit work under the default `gateway.maxFrameBytes`. Inline `chat.send`
`attachments` are now held to 256 KiB each. Approval answers from the web go
over the gateway instead of `POST /chat/approve` (the route stays for REST
clients).

## v0.6.0 — Shared work, budgets, and stronger review (2026-10-01)

Octipus 0.6.0 brings a shared task board for people and role agents, dollar
spend budgets, and explicit acceptance criteria for pipeline review. It also
improves long-running CLI work, skill management, and MCP connections. This
release includes 95 commits since v0.5.1, before release preparation.

### Shared tasks and background work

- **Task board:** assign tasks to users, roles, or swarm nodes; claim work with
  atomic, expiring leases; and leave progress comments. The tasks page adds
  assignee filters, claim controls, and a role-agent panel.
- **Role agents and wakeups:** enabled roles work assigned tasks on the
  heartbeat. Completing a blocker or the last child task wakes dependent work;
  PostgreSQL notifications carry wakeups across processes and a database lease
  coordinates role turns. Child briefs include goal ancestry, and task
  mutations enter the audit trail.
- **Persistent session monitors** track follow-up work. Agent approvals are
  stored in the database rather than only in process memory.

### Spending, permissions, and data flow

- **Dollar spend budgets:** admins can set daily or monthly limits per user,
  role, or workspace. The default warning is 80%; reaching 100% pauses agents
  and refuses further runs until reset or a limit increase. Budget settings,
  dashboard cards, banners, and chat refusals show the same recorded spend.
  Budgets are opt-in. Unknown CLI/subscription costs count as $0, and an
  in-flight call can cross the limit, so these are not exact billing caps.
- **Flow guard:** sessions track reads of untrusted content, private data, and
  raw credentials. Qualifying outbound calls escalate from ALLOW to ASK,
  without an extra model call. It defaults to `agent.flowGuard: ask`; unattended
  calls that need approval are blocked. Labels are in memory and reset on
  restart. Bridged tools are checked, but Codex native tools have no per-call
  relay; vault-authenticated calls have a documented exemption. See
  [Flow guard](https://github.com/PatriceA/octipus/blob/v0.6.0/docs/FLOW-GUARD.md)
  for the coverage and limits.
- **Authorization fixes:** enforce ownership for mid-run guidance, hooks, and
  notification destinations; verify webhook signatures against raw bytes,
  deduplicate redeliveries, and queue accepted events fairly.

### Review and execution reliability

- **Acceptance criteria:** plan items can name criteria that QA must check with
  evidence. An unmet or omitted criterion prevents a pass. Using the same model
  for implementation and review produces a notice pointing to the Verify lane;
  the Bug Fix recipe now uses that lane for verification.
- **Attempt tracking:** retries compare changes against the original baseline.
  A worse swarm retry that changed no files retains the earlier attempt, and
  pipeline escalation identifies the best earlier attempt and its commit.
- **CLI continuity:** preserve parent and child sessions, support explicit
  child `resumeKey` values and opt-in Git worktrees, deliver image attachments,
  and keep meaningful mid-run messages visible after reload. Long tool calls
  and child collection survive bridge delays more reliably.
- **CLI controls and portability:** expose the role's assigned skill index,
  direct delegation through `spawn_child`, add shell-network hook checks, and
  fix Windows command resolution and metacharacter escaping. Quota detection
  now uses failed vendor runs rather than matching ordinary output.

### Skills, models, and MCP

- **Skills:** pin skills per chat or as defaults, deduplicate imports, hide
  personal entries, and reload mounted skills without restarting. Agents and
  MCP clients can update editable skills through shared authorization;
  mounted skills remain editable at their source.
- **MCP package:** `octipus-mcp-server@0.6.0` adds an `update_skill` alias,
  includes skill IDs in listings, and documents shared authorization and
  mounted-skill restrictions for updates. Existing skill tools and loading
  aliases remain available; the server now advertises 87 tools across 25 groups.
  The backend adds MCP permission controls, reconnects dropped servers on demand, applies HTTP request
  timeouts, and keeps an unavailable server from blocking tool dispatch.
- **Optional decision models:** a decision lane supports TypeSafe Jev and a
  local Ollama stand-in, with shadow evaluation for routing, retrieval,
  categorization, and review. Privacy and retention checks gate remote use;
  this is an optional capability, not a new required provider.
- **Everyday fixes:** configurable email-triage categories and mailbox labels,
  chat slash-command suggestions, reduced history polling, corrected settings
  toggles, and preservation of embedded data when initialization fails.

### Upgrade notes

- Back up the database/data directory and `.env` (including `MASTER_KEY`) and
  stop Octipus before updating. Node.js **24.19.0 or newer** remains required
  for the full application. Reinstall locked dependencies and rebuild the
  backend, web app, CLI, and MCP server; database migrations **0108–0119** run
  during normal backend startup.
- New source installations support `octi update` (`--dry-run` previews it).
  Existing v0.5.1 installations should first use the installer update path in
  the [installation guide](https://github.com/PatriceA/octipus/blob/v0.6.0/docs/INSTALLATION.md).
- Update a global MCP installation with
  `npm install -g octipus-mcp-server@0.6.0`, or pin your MCP client's npx
  arguments to `["-y", "octipus-mcp-server@0.6.0"]`, then restart that client.
  The npm package is the bridge; update the connected backend too to use the
  new skill-update behavior.
- Review unattended workflows affected by the default flow guard. Spend limits
  need admin configuration; role agents and child worktrees also require
  explicit setup.

[Full comparison](https://github.com/PatriceA/octipus/compare/v0.5.1...v0.6.0)

## v0.5.1 — The MCP server, on npm (2026-09-18)

`octipus-mcp-server` is published to npm, so an MCP client — Claude Desktop,
Claude Code, anything that speaks the protocol — can reach an Octipus instance
without checking the repository out:

```json
{ "mcpServers": { "octipus": {
    "command": "npx", "args": ["-y", "octipus-mcp-server"],
    "env": { "OCTIPUS_URL": "http://localhost:3005", "OCTIPUS_API_KEY": "octi_…" } } } }
```

The package was ready to publish four releases ago and never was, which left a
few things to fix on the way out — each of them the kind that is free to change
now and breaking afterwards.

- **The installed command was `assistant-mcp`**, named after what this project
  was called before the rebrand. It is `octipus-mcp` now. Nothing referenced the
  old name; every install after a publish would have.
- **The server reported version `1.0.0` in the MCP handshake** — hardcoded, and
  wrong in every build ever shipped. It reads its own package version now.
- **`octipus_chat` advertised an `expert_id`** it was sending to an API that
  stopped reading it when the expert layer was retired.
- **The docs listed `octipus_list_experts` and `octipus_chat_with_expert`**,
  which the server no longer registers, and claimed 88 tools across 26 groups
  where it advertises 86 across 25 — counted by asking a running server rather
  than by reading the source.
- **The package now carries a LICENSE**, a homepage, an issues link and
  keywords; npm only packs files inside the package directory, so the repo-root
  licence never reached it.

**Release process.** The gate now runs the tests of the package it publishes —
the MCP server has its own suite that `npm test` at the root does not touch,
which is how the expert removal broke it unnoticed. It also fails when the
committed version does not match the tag: `sync-version` rewrites the runner's
copy so the artifact is right, but it never wrote back to the repository, which
is why `package.json` sat at `0.1.0` while the tags climbed to v0.4. And the
process itself is written down in CONTRIBUTING.md rather than living in a
workflow comment.

**Topics API.** `PUT /api/topics/agents/binding` and
`PATCH /api/topics/coding/config` write through to the lane a retired name
resolves to instead of returning 404. The model registry and the topic-config
store always resolved those names; only the API rejected them, which made the
v0.5 compatibility promise false exactly where a script would lean on it.

## v0.5 — One model per kind of work (2026-09-18)

114 commits since v0.4. The theme is that Octipus stopped asking one model to do
everything: a request is now routed to a *lane* before the turn starts, each lane
carries its own model binding, and the layer that used to sit between a request
and its model — the expert — is gone. Alongside that, a conversation with a
vendor CLI survives the turn that started it, and the token ledger finally tells
the truth about what a cached prompt costs.

Measured against the same four-task harness the previous release was measured on
(one model, one endpoint, ten harnesses — <https://harness-arena.net>), the same
work is 15–31% cheaper per run than v0.4 and the standing prompt fell from 20,951
tokens a call to 12,357.

### Lanes: the model is chosen per request, not per install

`agents` — the one lane that served every worker — is split, and two more lanes
join it. The full set is now `build`, `everyday`, `verify`, `research` and
`background`, and each binds its own primary, backup and executor model on the
Topics page.

- **`build`** takes implementation, debugging, architecture and anything that
  leaves an artefact someone later depends on. This is where a stronger model
  changes the quality of the answer rather than whether one arrives.
- **`everyday`** takes chat, lookups, classification, summaries and drafting —
  high volume, low stakes, wrong answers visible immediately.
- **`verify`** takes review and QA, and exists to be a *different* model from the
  one that did the work: a second opinion from the model that wrote the code
  shares the blind spot that produced it.
- **`research`** keeps its own binding because it is the highest-token work in
  the system and should be pinnable somewhere cheap on its own.
- **`background`** takes memory extraction, summarisation and LLM-as-judge.

Routing happens *before* the turn, in `src/core/agent/lane-intent.ts`, and the
rule is the cost of being wrong. A model sent to the wrong tool notices and calls
`list_tools`; a model sent to the wrong lane notices nothing — a weak model does
not stall on hard work, it produces something plausible and finishes. So work
that names a file, a stack trace or a diff fails *up* into `build`, and
everything else falls to `everyday`.

Every retired topic name still resolves (`coding`, `qa`, `writing`, `chat`,
`voice` and the rest alias to their lane), so existing bindings, scripts and
plugins keep working.

`spawn_child`'s `topic` argument now actually selects the child's lane instead of
only labelling the topic path, and `escalate_to_expert` becomes
`escalate_to_other_lane` — it refuses when the lane named resolves to the model
the parent is already on, before the escalation budget is spent.

### Roles replace experts, and you can write your own

The `presets` table and the whole expert layer are gone (migration
`0105_drop_experts`). An expert was a row that paired a role with tools, a
prompt, critical rules and a model preference — and every one of those parts
already had a better home:

| was on the expert | lives now |
|---|---|
| role + tools | the role itself |
| critical rules | `RoleMeta.criticalRules`, appended to the role prompt |
| skills | skill↔role assignments, keyed by role name |
| deliverable template | the role's `prompt.md` OUTPUT section |
| model preference | the lane the role resolves to |

The practical failure it removes: standing instructions used to be a *database*
lookup, so a seed that had not run — or a row an operator deleted — silently
produced a specialist with no rules, and nothing said so. They are behaviour for
a kind of work, so they now belong to the role that does it.

Roles themselves became editable data rather than sixteen folders in the source
tree. The Topics page lists each lane's roles underneath it; an admin can add a
role with a name, a one-line description, a prompt and a tool list, edit any
shipped role, and delete one they created. A created role joins the live registry
immediately — no restart — and becomes spawnable at once.

How a role gets *used* is worth stating plainly, because the grouping does not
say it: nothing selects a role out of a lane. The arrow runs role → lane. A role
is chosen by an agent naming it in `spawn_child`, off its one-line description,
which is why the description is a required field rather than a comment — a role
with a blank one is a bare name in the delegation menu that nobody picks.

### The advertised tool list is chosen for the message

Lazy tool discovery already split a role's tools into an advertised core and a
long tail reachable through `list_tools`. That split was per role — identical on
every turn — so a coding turn that only touches files and a shell still paid for
the user's notes, to-do list, knowledge base, chat channels, repo registry and
web search on every single call.

The core set is now a property of the **message**. Two rules keep it survivable:
it can only ever *shrink* a role's own list, so nothing new is granted and the
role's `toolIds` remains the permission boundary; and it fails open, so a tool
group with no entry in the intent table is always kept and shipping a new tool
cannot silently lose it. Swarm children get the same treatment as the root.

Measured on the arena's model: 20,951 tokens a call → 12,357.

### A vendor CLI conversation survives the turn

Claude Code and Codex runs are resumed across turns instead of starting cold
every time: the vendor session id is stored on the Octipus session, only the new
turn is sent, and Octipus's own compaction is piped through to the vendor
session. A resume that fails falls back to a cold run rather than failing the
turn. `cli.reuseSessions` is **removed** — reuse is always on, and an adapter
declares whether it can resume at all.

Two isolation holes closed along the way: the one-shot CLI provider path and the
agent CLI path both now load an isolated MCP configuration unconditionally,
rather than inheriting whatever MCP servers the host user happens to have
configured. CLI prompts are sent on stdin, because a multi-line argv is silently
truncated on Windows, and the tool bridge no longer returns fault detail to its
caller. Runaway completions have a cap and a kill.

### The token ledger tells the truth about caching

- A **billable-token** figure that excludes cache reads, and every cost gate,
  budget comparison and spawn decision now reads *that* rather than the grand
  total. A cached prompt was previously charged against budgets at full price.
- Anthropic, OpenAI-compatible and LiteLLM cache counters are recognised and
  logged, including the cache-write/cache-read split, with a warning when cache
  tokens arrive on a model that has no cache pricing configured.
- Every assembled system prompt is splittable at a volatile marker, so the
  static tier can sit ahead of a provider's cache breakpoint instead of being
  invalidated by a per-turn block.
- An OpenRouter conversation is kept on one endpoint, because a provider switch
  mid-conversation throws the prompt cache away.
- An Octipus session is one coherent conversation *across* providers.

### Windows

A batch of real portability work: the premise check and the docs index key paths
the same way, shell commands keep their paths and a deadline actually kills the
process, `devMode` accepts a Windows project path (and refuses Windows system
directories), owner-only files are owner-only there too, CocoIndex installs, the
real `node.exe` is spawned, CRLF is out of the tree, and Vitest can see its own
test files.

### Desktop, mobile and connectors

- The desktop app runs a self-healing preflight before launch, rebuilds the
  backend when `dist/` is older than the sources, selects its mode through Vite
  rather than an `sh` env prefix, and stops watching the Rust build directory.
- Paired phones get push notifications for approvals and permission requests, a
  30-day session lifetime, and never get advertised a LAN URL they cannot reach.
- A native multi-repo registry with Java support, ownership scoping and hardened
  discovery; a CocoIndex Code connector; MCP stdio child-environment hardening.
- Mutating tool calls are journalled so an uncertain outcome can be reviewed
  after a crash or a cancellation, with cancellation plumbed through.
- An MCP server's tool list is read to the last page, not just the first.

### Operator-facing changes

- **New lanes need binding.** `build`, `everyday`, `verify`, `research` and
  `background` each take their own model on the Topics page. Retired names still
  resolve, so nothing breaks unbound — but until you bind them, routing changes
  the log line and nothing else.
- **The topics API accepts retired names.** `PUT /api/topics/agents/binding`
  and `PATCH /api/topics/coding/config` write through to the lane the name
  resolves to instead of returning 404, so an existing script keeps working; the
  response reports the canonical topic it landed on. A name that is not a topic
  at all is still a 404.
- **`cli.reuseSessions` is removed.** Vendor CLI session reuse is always on.
- **The `presets` table is dropped.** If you customised an expert's prompt, copy
  it into a skill before taking migration `0105` — that is the replacement, and
  the reason skill proposals now promote to skills rather than to experts.
- **`GET|POST|PATCH|DELETE /api/experts` are gone**, replaced by `/api/roles`,
  which now also creates and deletes. `GET /api/roles` returns a role's prompt
  and critical rules to admins only.
- **The MCP server's `octipus_chat` drops its `expert_id` parameter**, which had
  been sent to an API that no longer reads it.
- **`GET /api/health/detailed` reports the running version**, so "which build is
  answering" is a reading rather than a guess.
- **The version is now declared in one place.** `package.json` is the source;
  `scripts/sync-version.ts` rewrites the web app, the plugin SDK, the MCP package
  and the Tauri bundle from it on a release tag. Those four had said `0.1.0`
  since the first release because they were never in the list.

### Fixed

- `/clear` leaked cleared conversations into resumed CLI sessions.
- A vendor CLI session id was mistaken for an Octipus session id.
- `codex exec resume` rejected `--sandbox`.
- Binding a model with no embedding capability to the `embedding` topic is
  refused at the API rather than failing at first use.
- OpenRouter model discovery no longer sorts by price; read-only meta-tools
  default to ALLOW; `search_files` accepts globs.
- `defaultMaxTokens` could exceed `maxTokens` after a migration raised only one
  of the two defaults.
- Custom Anthropic endpoint discovery, vault secrets with surrounding
  whitespace, and the Voyage model list.


## Earlier — the backlog these releases drew from (2026-05 – 2026-08)

### The orchestrator hop is gone — one agent loop per turn (2026-08-23)

Phase 9 of [`docs/plans/rebuild-execution-plan.md`](docs/plans/rebuild-execution-plan.md),
which closes that plan. The agent you talk to now holds real tools.

**What changed for a user.** A message used to be read twice: a keyword
classifier decided whether it was "casual" (a tool-less one-shot completion) or
work (an `orchestrator` agent whose only tools were `spawn_child` and
`profiles`). That orchestrator could not do anything itself, so 51% of its runs
read the request, concluded they needed nobody, and answered from memory —
18.2% of all agent tokens for a hop that returned nothing. The root of a turn
now runs as the `general` role with the general toolset **plus** the delegation
meta-tools: it reads the file, runs the search, stores the note, and calls
`spawn_child` only when a task genuinely needs a specialist. Delegation, swarms
and pipelines are unchanged.

**Operator-facing changes.**

- **`orchestrator.mode` no longer accepts `router`.** An existing `router`
  setting (DB or `ORCHESTRATOR_MODE`) is migrated to `lite` at load; nothing to
  do, and boot will not fail on it. Modes are now `auto | full | lite`, and a
  mode is a *prompt tier*, not a control-flow branch: a small model runs the
  same loop with a trimmed prompt, a tool list capped to
  `orchestrator.smallModelMaxTools`, and a hard iteration cap.
- **`orchestrator.liteMaxIterations` default 3 → 8.** Three was sized for
  "delegate once and relay"; a root that does its own work needs to read,
  search, and answer. An explicit setting is untouched.
- **`orchestrator.routerSmallModelMaxParams` keeps its name** — it is the
  "small model" threshold every trim in the product reads, not a mode selector.
- **The `orchestrator` role is deleted.** Custom per-role tool allowlists for it
  are ignored; the roles API no longer lists roles that have no folder. Casual
  turns are agent runs now, so they appear in the agent list and in cost
  tracking, where the old shortcut was invisible to both. Expect a casual turn
  to count more tokens (it carries a tool schema) at roughly unchanged latency
  and near-unchanged cost — the bulk is the prefix providers cache.
- **Unattended runs (hooks, heartbeats) no longer raise approval prompts.**
  The root can hit an `ASK`-level permission now that it holds tools; on a run
  with nobody watching, the existing unattended path (auto-approve, or refuse
  via `multiuser.unattendedDenyActions`) applies instead of waiting out the
  five-minute request TTL and then failing.

  **Superseded 2026-09-10:** unattended `ASK` actions now return
  `approval_required`; they are not auto-approved. Stored `DENY` decisions take
  precedence over broad allow rules. See
  [`docs/reports/consolidation-2026-09-10.md`](docs/reports/consolidation-2026-09-10.md).

**Two latent bugs fixed on the way, both of which affected any install.**
`loadRolesFromDb` rebuilt each in-memory role from the four columns the `roles`
table has, so at boot it silently dropped `readOnly` — the only per-handler
write filter in the product, meaning the read-only `qa`, `review` and
`architecture` roles regained file-writing tools after startup — along with
`coreToolIds`, which disabled lazy tool discovery everywhere. Both are now
preserved, pinned by a database-backed test.


### Hermes v0.18 adoption — learning loop, verification, Vertex (2026-07-16/17, PRs #237–#245)

Selectively adopts ideas from Hermes Agent v0.18 ("The Judgment Release")
after a comparison against octipus. What we stole/finished, why, and what we
deliberately ignored is in
[`.octipus/plans/hermes-v018-adoption.md`](.octipus/plans/hermes-v018-adoption.md);
Mixture-of-Agents was assessed and **parked** (opt-in preset only — see
[ROADMAP](ROADMAP.md) → *Later*).

- **CI unblock (#240).** `main` had been red team-wide since #231 — the only
  `*.integration.test.ts` missing the `describe.skipIf(!isIntegration)` guard
  (`topic-alias`) ran its embedded-PGlite setup in the unit lane, where a
  process-global DB/registry singleton made it order-dependent (passed locally,
  failed in CI). Gated it behind `INTEGRATION=1` like every sibling. Backend CI
  green again.
- **Learning loop — octipus can now *generate* skills, not just prune them
  (A1-M1 #244, A1-M2 #245).** A new **`skill_distill` tool** distils a reusable
  skill from recent conversation, provided text, or a **verified-good
  trajectory**, and files it as a **pending proposal** for review — never a live
  skill directly (the human approve gate stays in the loop). `skill_proposals`
  gained a **`kind` (`skill` | `expert`)** discriminator so the approve route
  promotes a distilled *procedure* into a skill (it only made experts before) +
  a `sourceRef` for provenance. Trajectory distillation is gated on quality:
  outcome must be `success` and, if the session recorded B1 verification
  evidence, none of it may have failed. Distiller model resolves via the
  `skill_distillation` topic → shared `background` lane. See
  [`docs/EXPERT-TOPIC-SKILL-ROUTING.md`](docs/EXPERT-TOPIC-SKILL-ROUTING.md)
  ("Skill lifecycle").
- **Verification evidence ledger (B1 #242).** QA verdicts were computed then
  dropped; they now persist to a durable, append-only `verification_evidence`
  table (`kind`, `passed`, `confidence`, `detail`) and are readable per session
  at `GET /api/verification/:sessionId` (ownership-scoped). The "verified" rule
  fails loud: **no evidence ⇒ not verified**. Foundation for evidence-backed
  completion contracts; `pre_verify` hooks + the verify-stop-loop are the
  tracked follow-up (B1b). See
  [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) ("Verification evidence").
- **Trajectory export for training (B2 #243).** `scripts/trajectories/export.ts`
  turns recorded runs into chat-format training JSONL for offline eval /
  fine-tune pipelines — `--from/--to/--outcome/--out`, reads compressed or plain
  dailies, re-runs the PII filter at export, and reports scanned/exported/
  filtered/malformed counts (no silent truncation).
- **Vertex AI provider with OAuth2 token minting (A3 #241).** First-class
  `vertex` provider via Google's OpenAI-compatible endpoint, authenticated by a
  short-lived access token **minted from a service account** (RS256 JWT-bearer
  grant via `node:crypto`, cached + refreshed before expiry) — **no static
  keys** on disk; the SA lives in the vault. Selected by a `vertex/` model
  prefix. See [`docs/CUSTOM-PROVIDERS.md`](docs/CUSTOM-PROVIDERS.md)
  ("First-class Vertex AI provider").
- **Scheduler reliability hardening (A2 #238).** Adapts three Hermes cron
  fixes onto the task scheduler: **missed-grace** (an overdue task past its
  window is dropped once with a `skipped_missed` event, not run stale);
  **fail-closed on wake-gate drift** (a gate that can't be *evaluated* fails the
  task after a cap instead of deferring forever — a legitimate "not now" still
  defers); and a **liveness heartbeat**. Also wires `getScheduler().start()`
  into boot — the worker loop had **no caller**, so the task queue (e.g.
  artifact cleanup) was filled but never drained.

### Live voice conversation — talk to the orchestrator (2026-07-13/14, PRs #210–#217)

Realtime, hands-free voice in the web chat that runs the full orchestrator
pipeline. Architecture + tuning knobs in [`docs/VOICE.md`](docs/VOICE.md)
("Realtime Web Voice Conversation").

- **Realtime duplex voice (Phase 4, #210–#213).** `/voice` WebSocket streams
  16 kHz PCM off an AudioWorklet through streaming STT (local whisper.cpp or
  Mistral Voxtral); per-sentence streaming TTS with **barge-in**; and a Twilio
  media-stream path (`/voice/media/:provider`) for duplex phone calls.
- **Propose-then-confirm gate (#216).** With the mic on, a work request isn't
  dispatched blind — Octipus proposes an approach (or asks one short clarifying
  question when the request is vague) and only executes on your spoken "yes";
  "no" cancels, anything else refines. Runs on the fast model mapped to the
  **`voice` topic**; read-only over the orchestrator (can't self-spawn). Voice
  turns only — typed chat is unchanged.
- **Backend narrator (#216).** Agent lifecycle is spoken as it happens
  (`worker_spawned`/`worker_completed` → `{type:"speak"}` frames over `/ws`),
  session-scoped; the reply is spoken fresh from each `chat_response`, fixing the
  stale-reply repeat.
- **Make the spoken loop usable (#214).** Default Mistral TTS voice
  (`en_paul_neutral`) so `/speak` stops 500-ing; whisper `[BLANK_AUDIO]` filtered
  at the root; `Sources:` footer + markdown stripped before TTS.
- **Live-testing fixes (#217).** Gate now also catches `ambiguous` turns (vague
  speech rarely scores as a clean `task`); warmer, conversational planning tone;
  utterance silence window widened to 2000 ms so a pause doesn't split a
  sentence; Voxtral wired for realtime STT; enlarged live-transcript readout; and
  a **WebSocket reconnect-storm fix** — the auth-ticket failsafe no longer opens
  empty-token sockets or retries at a flat interval, so a rate-limited
  `/auth/ws-ticket` backs off and recovers instead of looping.

### OpenClaw gap integration — eight phases (2026-07-12, PRs #199–#207)

Closes the gaps ranked "worth closing" in `docs/OPENCLAW-COMPARISON.md`,
delivered as eight independently-reviewed, CI-green PRs. Plan and
per-workstream status in
[`docs/plans/openclaw-gap-integration.md`](docs/plans/openclaw-gap-integration.md).

- **CI & security hardening (WS1 — PRs #199, #201, #202).**
  `bun audit` is now **blocking** (with a reviewable allowlist);
  CodeQL, semgrep (`p/typescript` + `p/security-audit`), zizmor
  workflow audit, and `dependency-review` run on every PR; a
  tag-driven `release.yml` extracts the CHANGELOG section and syncs
  `package.json` on `v*` tags; an install smoke test runs
  `install.sh` + `octi doctor` on ubuntu **and** macOS. Also fixed the
  repo's long-standing CI flakiness — a bun coverage stdout burst was
  crashing test runs with `WriteFailed`; `coverageReporter=["lcov"]`
  in `bunfig.toml` removes the ~530-row table from the pipe.
- **Observability (WS4 — PR #199).** Prometheus metrics via
  `prom-client` (`src/core/telemetry.ts`) with `record*` helpers that
  never throw, and end-to-end `runId` correlation via
  `AsyncLocalStorage` (`src/core/run-context.ts`) stamped into pino
  logs and exposed on `/metrics`. **Operator-visible:** `/metrics`
  now serves a real registry; legacy gauge names preserved.
- **API-token scope enforcement (WS6.1 — PR #199).**
  `src/security/scopes.ts` — token scopes are now enforced, not just
  stored. **Back-compat:** a token with *empty* scopes retains
  full access, so existing tokens are unaffected.
- **OpenAI-compatible HTTP API (WS6 — PR #200).** New `GET /v1/models`
  and `POST /v1/chat/completions`. `model: octipus/orchestrator`
  (default) runs the full pipeline; `octipus/<role>` forces a role; a
  raw registry model id is a single-turn passthrough. Protocol-correct
  SSE streaming (`stream: true`) and an OpenAI error envelope so
  off-the-shelf SDKs work. **User-visible:** point any OpenAI client at
  `/v1` with an `octi_` token.
- **Heartbeat / proactive loop (WS2 — PR #203).** A cron-runner-driven
  periodic per-user turn, gated **cheap-first** (quiet hours → quota →
  a pending-work probe, all before any LLM call). Standing instructions
  come from a pinned `HEARTBEAT` note. Migration 0077 adds the
  `heartbeat` trigger type. **Operator-visible:** off unless a
  `HEARTBEAT` note is pinned.
- **`tool_search` (WS5 — PR #204).** Embedding-based semantic ranking
  layered onto the existing lazy tool discovery and wired into
  `list_tools`, so large role tool-sets surface the right tool by
  meaning, not just name.
- **Local-runtime presets (WS8 — PR #205).** Model presets +
  autodiscovery for local runtimes (Ollama / LM Studio / vLLM / …)
  reusing the OpenAI-compat provider, plus `/api/models/presets` and
  `/api/models/discover`.
- **Versioned plugin SDK (WS3 — PR #207).** `@octipus/plugin-sdk`
  publishes the plugin contract (manifest types, `validateManifest`,
  `checkApiVersion` with semver gating) and a `validatePlugin` kit
  that dry-runs a plugin's full lifecycle. New `octi plugin validate
  <dir>` CLI and a `plugin-validate` CI job over `extensions/*`.
  Consumed by the host via a tsconfig path alias — zero install
  impact. **Plugin authors:** set `apiVersion` + `capabilities.tools`
  in `plugin.json` (see `docs/PLUGINS.md`).

**Deferred (tracked on the roadmap):** token-true streaming for `/v1`
(needs a token-delta path through the orchestrator — step-1 SSE ships
now), an inbound email channel (ASK-gated), OpenTelemetry traces
(metrics + `runId` shipped; the OTel SDK is dependency-blocked in the
build environment), and plugin remote-install/signing. Subscription
OAuth was dropped (Octipus is multi-user only).

### Voice — first-class, multi-surface (2026-07-10, PRs #187–#197)

Voice becomes a real channel across web, TUI, and messaging, with a
local-first STT path and a cloud TTS default so it works with no host
setup.

- **Live voice conversation in the web chat (#191).** Hands-free mode:
  talk, and Octipus streams a reply and speaks it back, with background
  agents spawning exactly as in text. Half-duplex loop (mic →
  VAD-segmented utterance → local `whisper.cpp` transcribe → the same
  pipeline as text → speak → listen), a live-voice toggle +
  listening/thinking/speaking chip in the composer, and graceful
  text-only degrade when TTS is off. **User-visible:** TTS default
  flipped to cloud (Mistral Voxtral) so voice-out works out of the box;
  piper stays the local opt-in. Streaming STT + barge-in deferred to a
  realtime phase.
- **Voice on every channel + Telegram voice-out + TUI push-to-talk
  (#195, #197).** Voice-in across all channels, Telegram voice replies,
  and push-to-talk voice in the TUI.
- **Mistral vision + OCR and Voxtral STT/TTS (#188, #190).** Native
  Mistral vision + OCR; Voxtral speech-to-text and text-to-speech
  engines.
- **Local whisper reliability (#193, #194).** Cross-platform fixes to
  decode / language-detect / gating / install so local `whisper.cpp`
  works reliably.
- **Windows `octi.cmd` parity (#187).** The Windows launcher reaches
  command parity with the bash `octi`.

### Swarm reliability — release-candidate hardening (2026-07-06–08, PRs #179–#186, #196)

A budget/liveness diagnosis arc (RC5/RC7) that makes swarm budgets
actually bind and stops orphaned agents from outliving their parents.

- **Budgets bind; detached orphans are killed (#181, #182).** On
  *normal* completion (not just failure) a parent now aborts + cancels
  any detached child still pending after auto-collect, so answering the
  user no longer leaves a child running. The orphan reaper actually
  *stops* unambiguous orphans (a detached child of an already-terminal
  parent) instead of only relabeling DB rows. The token-budget cap
  binds even under providers that under-report usage.
- **Capability + context-window gates at spawn (#183, #186).** A
  worker's model is gated for capability at binding time and for
  context-window fit at spawn — failing loud instead of mid-turn.
- **Liveness-gated reaper + hard backstop (#185, #184).** A
  heartbeat / last-activity signal gates the age-based reaper so a
  healthy long-running orchestrator isn't torn down; an absolute
  backstop resolves a wedged `collect_children` wait.
- **Fan-out + relay correctness (#180, #196).** Depth-1 subagents are
  discoverable so fan-out can happen; fixes for scaffolding leaks,
  duplicate spawns, per-child relays, and misread child status.
- **Also:** research-drift failure fix (#179); each spawned worker now
  sees its siblings' prior actions; 60 s dedup on identical sends to the
  same target; a `remember_this` loop + duplicate-memory fix; the saved
  research report is conditional rather than mandatory; the orphan
  reaper runs periodically, not only at boot.

### Provider correctness + orchestrator robustness (2026-07-04, PRs #172–#177)

- **Gemini tool calling fixed; every provider lane hardened (#174).**
  `flash-lite` is now usable as an orchestrator — the QA conclusion
  "flash-lite can't tool call" was an integration bug. Schemas are
  sanitized for Gemini (`$schema`/`$id`/`$defs` stripped, `$ref`
  preserved), orphaned tool-calls get synthesized error results,
  empty-content turns are filtered, and a new
  `toolChoice: auto|required|none` maps per provider (OpenAI
  `tool_choice` / Gemini `functionCallingConfig.mode`). Truncated turns
  retry natively with more tokens before the toolshim; one shared
  `parseToolCallArguments` helper across providers.
- **Orchestrator relay fidelity + child-aware timeouts (#175).**
  Auto-collect gives each forgotten detached child a real relay budget
  (2–12k chars) instead of truncating to 500, with a deterministic
  fallback that appends child results verbatim when the final answer is
  a stub. `collect_children` is on the lite-mode tool surface. A
  stopped child emits a complete-shaped terminal event so the UI
  spinner resolves and a detached parent finalizes.
- **CLI agent fidelity + MCP session-before-spawn (#173, #176).**
  CLI-agent event/tool-tracking fidelity; the MCP path creates a
  session before spawning an agent.
- **Fixes (#172, #177):** experts null-override, dev-session workspace
  root, and model-lane visibility; a bun-test preload reaps leaked
  per-test `/tmp` scratch dirs.

### `writing` model lane (2026-07-02, PR #171)

- **Operator-visible:** Long-form roles (`research`, `writer`, `pm`,
  `communication`) all funneled into the single `agents` model lane
  after topic consolidation, so they couldn't be bound to a cheaper /
  faster model than coding work. A new canonical `writing` lane is added
  and those four roles re-pointed to it (alias-table only — no role
  config changes). Migration 0075 seeds the writing lane's binding from
  the current `agents` binding so nothing fails loud on deploy; rebind
  `writing` to a flash model on the Topics page. Mirrored in the web
  Topics UI and the health feature list. (Routing analysis in #169;
  e2e topic-coverage fix in #170.)

### Core file refactor (2026-07-01, PR #167)

- **Programmer-visible:** Split the four largest logic-heavy files
  (`api/routes/models.ts`, `core/orchestrator/service.ts`, `core/swarm/spawner.ts`,
  `core/agent-worker.ts`) into focused sibling modules — routes now delegate to
  a `src/services/` layer, and swarm budget/validation/cache plus the
  detached-child manager and tool-loop detector are their own units. No
  behavior change; every public API and import surface preserved.

### Session changes review — `/changes` (2026-07-01)

- **User-visible:** Review the file changes an agent made during a session. A
  git-backed `/changes` view surfaces every touched file, with a new web
  **Changes** tab and the same set rendered in the TUI client.

### Orchestrator detach — activated + hardened (2026-07-01)

- **Operator-visible:** Detached subagents are now collected by default
  (`maxPendingDetached` 0 → 6) instead of being discarded in await-mode, so
  long-running child results actually land. Swarm budget accounting reconciled:
  canonical wall-clock is 600 s (10 min) per level, and child spend feeds the
  shared pool.

### Robustness + MCP auto-reconnect + permission queue UI (2026-07-01, PR #168)

- **Operator-visible:** MCP servers **auto-reconnect** after a drop, and
  a **permission-queue UI** surfaces pending approvals. Approval-manager
  global-resolution and timeout bugs fixed; worker spawners proactively
  check tool availability; the skill markdown parser moved to `js-yaml`;
  registry + visual-analyzer test coverage added. Docs: QA sections for
  topic model-roles / session changes / detachments, a roadmap sweep,
  and seven shipped design notes archived under `.octipus/archive/`.

### Provider, desktop, and web fixes (2026-06-26–28)

- **Desktop lifecycle (#164).** `octi desktop` backgrounds by default so
  the GUI survives closing the terminal (`--foreground`/`--stop` to
  control); `octi stop` / `uninstall` reap the desktop app; new
  `octi start/restart --backend-only` (aliases `--headless` / `--no-web`)
  run the backend with no UI so desktop/TUI users attach their own
  client; fixed a desktop-dev `ChunkLoadError` by giving `next dev` its
  own `.next-desktop` cache separate from the static-export build.
- **Provider / prompt fixes.** DeepSeek: always send `reasoning_content`
  on tool-call turns; the orchestrator no longer treats a thinking-only
  turn as the final answer; the current date is stamped into the prompt.
- **Browser extension** now authenticates the bridge with an API token
  instead of the master key.
- **Web:** a refresh button on provider model-discovery; DocumentCard
  hydration-error fix (nested buttons).

### QA batch — end-user surfaces (2026-06-10)

Findings from the 2026-06-10 QA pass, delivered as nine focused branches
(each independently reviewed). Highlights:

- **Single-user mode removed — always multi-user.** The `multiuser.enabled`
  flag and the legacy `MASTER_KEY` Bearer fallback are gone; every request
  must carry a session or API token. A single-user install simply never
  creates a second user. Workspaces are always per-user; the default
  workspace root moved out of the repo tree to `~/.octipus/workspace`
  (gitignore-leak fix). **Operator action:** anyone authenticating via
  `MASTER_KEY` must mint an API token (`POST /api/tokens`) or log in. Run
  `bun run test:e2e` against a live stack before deploying. Supersedes the
  feature-flag note in the 2026-05 multi-user entry below.
- **Agent file-writes resolve correctly in the UI.** `file_change` events now
  carry the path the tool actually wrote (post session-relocation), fixing
  "File not found" when clicking an agent-created file.
- **Notes / to-dos route to their real features.** The `general` role now has
  the `notes` and `tasks` tools (+ prompt routing), so "write a note" / "add
  a to-do" hit the Notes / Tasks tabs instead of dropping a loose markdown
  file. The Tools page shows which roles can use each tool.
- **Markdown renders everywhere.** A shared sanitized renderer backs chat,
  Deep Research reports, document/file previews, and a new Notes
  Edit/Preview toggle.
- **Run-mode indicator.** The web header and TUI status bar show
  Router / Light / Full (derived from the default-model size); the duplicate
  user card was removed from the sidebar.
- **Dashboard feature-status rework.** Required vs optional per feature,
  OCR + Vision shown separately, Memory Extraction + Evaluation added,
  Architecture dropped, per-feature hover help, two-column layout.
- **New-repo parent folder.** "Create new repository" lets you pick the
  parent folder (root / additional paths) with a destination preview;
  symlink-safe containment.
- **MCP feature tools.** tasks, notes, email, memory, Deep Research, and
  Reader are now exposed on the standalone MCP server.
- **Email overhaul.** HTML bodies render (server-side sanitized), messages
  mark read on open, inbox paginates (Load more), "Draft reply" proposes
  directions for you to choose before drafting, bigger reading pane, triage
  shows a result summary.

### Streamlined setup (2026-05-26)

One way in. The six divergent setup paths (`install.sh`, inquirer
`scripts/setup.ts`, pi-tui `scripts/init.ts`, `bin/octi start`,
`web/app/setup/page.tsx`, `docker-entrypoint.sh`) collapse into a
single `octi setup` wizard. After it runs, the service is runnable
and the user picks TUI or web — both surfaces consume the same
backend; neither owns onboarding.

User-visible:

- **`octi setup`** is the only wizard. Walks storage → secrets →
  backend boot → admin account → provider+key → default model →
  capabilities install (Playwright, MCP, browser ext, …). Supports
  `--non-interactive` (env-var driven, for CI / Docker builds) and
  `--remote <url>` (configure a running container from your host).
- **`.env` is secrets only** — `MASTER_KEY`, `JWT_SECRET`,
  `SESSION_SECRET`, storage targeting, `API_HOST`/`API_PORT`, and
  one-shot `BOOTSTRAP_*` vars consumed at first boot. Everything
  else (ports, channels, workspace, providers, feature flags) lives
  in the `settings` table / vault and is editable via the API at
  runtime.
- **`octi capabilities`** lists installed/missing optional tools.
  Sub-commands: `octi capabilities install <id>` and
  `octi capabilities install --all` to fix gaps after first run.
- **Web `/setup` is gone.** First-run onboarding happens in the
  terminal; the legacy route redirects to `/chat` once the system
  is set up, or shows a one-paragraph CLI hint otherwise.
- **Docker reports its own capabilities.** Playwright Chromium and
  the MCP server build are pre-baked in the image; the
  `capabilities` table reflects that on first boot. The entrypoint
  prints a one-shot `octi setup --remote` hint when the system has
  not been set up yet.

Internal:

- **Shared probe utilities** (`src/setup/probes.ts`) and a canonical
  provider registry (`src/setup/providers.ts`) replace three
  duplicated copies.
- **Capability service** (`src/capabilities/service.ts`) persists
  every tool's `checkAvailability()` result into a new
  `capabilities` DB table. The orchestrator gates `getToolsForRole`
  against this table at spawn time, so an agent that requires
  Playwright but lacks it logs a clear
  `octi capabilities install browser` hint instead of failing deep
  in a tool call.
- **Settings registry** (`src/config/settings-registry.ts`) gained
  explicit `*.apiKey` entries for OpenAI / Anthropic / Gemini /
  DeepSeek so the wizard can route keys into the vault through the
  existing `PATCH /api/settings/:key` handler.
- **Deleted**: `scripts/setup.ts` (715 LOC inquirer wizard) and the
  five `web/components/setup/*.tsx` step components. The
  `@inquirer/prompts` dev-dep dropped with them.

### Orchestrator freedom + Hermes-inspired curator (2026-05-24)

Branch `claude/orchestrator-freedom-hermes-fixes`. 8-phase land
inspired by a deep-dive into the Hermes-agent and pi-mono repos.
Headline: the orchestrator can now narrate, supervise, and chat to
the user while children run — it used to block on every spawn. Plus
a Hermes-style skill curator, a `/model` slash command, and a pile
of UX polish that surfaced while wiring everything together.

User-visible:

- **Orchestrator can talk while children work.** `spawn_child mode:
  "detach"` is now valid at depth 0 — the orchestrator fires up to
  six parallel agents, narrates progress, takes side-channel
  questions, then synthesizes via `collect_children` (or the
  framework auto-collects before the final reply). Previously every
  spawn was a blocking await: persona-narration events fired but the
  UI only saw them after the worker finished, so it looked like
  narration only triggered on errors. Now narration appears live.
- **Narration actually appears in chat.** The persona-narration
  bridge has been emitting `swarm.narration` events since the
  2026-05-20 ship but no surface rendered them — chat went silent
  during waits. New `narration` message role + chat-UI handler
  surfaces them as compact inline italics.
- **Tool-call streaming in the agent card.** Per-tool
  `tool_call_complete` events flip rows from spinner → check (or
  red X) the moment a tool returns, with duration + result preview.
  While the agent is running you see the live stream of what it's
  doing; once the agent finishes the inline list collapses and the
  tool count badge stays in the agent header. Survives the 10s
  REST poll without flickering.
- **Inline code stays inline.** LLM outputs like "the container is
  ` octipus-pg `" rendered as full-width fenced blocks. New
  formatting rule in every role prompt + a UI heuristic that
  collapses short single-line fenced blocks (≤80 chars, no
  language) to inline code.
- **Swarm-tree "Task brief" shows the full brief.** The WS event
  used to slice the preview to 200 chars while the DB stored 4000 —
  the modal looked truncated until a hard reload. Slice unified at
  4000; modal height bumped from `max-h-72` to `max-h-[60vh]`.
- **`/model` slash command.** Switch the orchestrator model for
  the current session without editing config. `/model <id|name>`
  to set, `/model clear` to revert, `/model list` to browse,
  `/model` to show the active override. Bad picks (reasoner,
  no-tools, known-unreliable for orchestration) get rejected at
  command time, not mid-turn. In-memory; resets on restart.

Operator-visible:

- **Skill curator (Phase 4 — Hermes-inspired learning loop).**
  Skills now track `last_used_at`, `usage_count`, `archived_at`,
  `curation_notes` (migration `0061_skill_curator_lifecycle`).
  A debounced in-process tracker (5s window or 32-id threshold,
  race-safe follow-up flush) records every prompt-injection of a
  skill. `runSkillCurator()` flags skills unused >30d, auto-archives
  unused >90d with a note. `findActiveByTopic` now filters archived.
- **Cross-provider tool-call IDs survive edge cases.**
  `normalizeToolCallId` falls back to a hash when stripping
  invalid chars would leave an empty string — earlier those silently
  dropped the assistant↔tool message link. Added idempotency and
  length-cap tests.
- **Orchestrator detach budget is configurable per level.**
  `LEVEL_DEFAULT[0].maxPendingDetached`: 0 → 6 (matches `fanOut`).
  Override per deployment via `config.swarm.levelDefaults.orchestrator`.

Internal:

- New: `src/skills/{curator,usage-tracker}.ts`,
  `src/core/orchestrator/session-model-override.ts`,
  `src/core/commands/model.ts`,
  `src/core/orchestrator/meta-tools-detach.test.ts`,
  `src/core/tool-executor-events.test.ts`.
- Reshape: `ModelSelector.selectForOrchestration(sessionId?)` runs
  both the default model and the session override through the same
  suitability gate.
- Roadmap items closed by this branch: **Skill auto-extension —
  promotion path** (curator covers archive lifecycle; promotion UI
  remains).
- Tests: 2009 / 0 / 128 pass / fail / skip across 200 unit files;
  134/138 e2e pass (4 failures pre-existing — env config + flake).

### UX + personality revamp (2026-05-20)

Branch `claude/octopus-ux-personality-swToC`. Five-slice land of the
full plan at `docs/plans/ux-personality-revamp.md` (Hermes-agent
inspired). User-visible:

- **Orchestrator now has an identity.** Per-user, persists across
  every channel. Default is `Octipus` — an octopus-machine that
  refers to itself in the third person, uses "we" for the swarm,
  and gives short dry replies. Rename via `/persona name <X>`;
  change tone/narration/free-form facts via `/persona ...`. Six
  preset YAMLs ship under `personas/` (`octipus`, `terse-engineer`,
  `mentor`, `nautilus`, `concierge`, `verbose-academic`). Specialist
  children stay role-defined — persona is host-level only.
- **Live swarm narration.** New `swarm.narration` event mirrors
  `swarm.node_spawned` / `node_completed` / `budget_warning` with
  persona-rendered text ("Octipus dispatches a research arm.",
  "qa arm failed. Predictable."). Per-user `persona.narration: off
  | minimal | chatty` setting.
- **Side-channel messages.** New gateway message type
  `chat.interject` lets the user ask a quick question while a
  swarm runs. Reply lands as `chat.message` with `sideChannel: true`
  and persona attribution. Running orchestrator is neither cancelled
  nor blocked.
- **Friendly no-engine path.** First message before a model is
  configured no longer throws — replies in the persona voice with
  three concrete next steps (`bun run setup`, `octi doctor`, web
  Models page).
- **Casual chat is persona-aware.** `directResponse` (the
  greetings/small-talk path that bypasses the orchestrator) now
  uses the same persona resolver — so "hi" gets an Octipus reply
  too, not a generic friendly-assistant string.

Operator-visible:

- **One-shot installer.** `curl -fsSL .../install.sh | bash` (Unix)
  or `iex (irm .../install.ps1)` (Windows) clones, installs deps,
  builds the compiled binary, symlinks it onto PATH, runs setup.
- **Compiled `octi` binary.** `bun run build:cli` produces a static
  ~95MB executable at `dist/octi`. Retires the PATH-mutation
  `scripts/setup.ts` used to do. Handles
  help/version/doctor/init/tui/edit/persona natively; delegates
  start/stop/restart/status/logs/open to the bash dispatcher.
- **`octi init`.** New pi-tui based setup wizard. Welcome →
  service auto-detect → storage mode → provider (Ollama first if
  detected, then LiteLLM, then direct provider — Voyage excluded)
  → model picker → API key → summary → writes .env. Falls back
  to `bun run setup` (the inquirer flow) on non-TTY.
- **`octi doctor`.** 15 environment health checks: bun, .env,
  vault keys, storage mode, base persona, state dir, Ollama,
  LiteLLM, postgres, redis, backend, MCP server build, browser
  extension, log sanity, disk space. JSON + text output.
- **First-boot model bootstrap.** `src/db/bootstrap-model.ts` reads
  `BOOTSTRAP_PROVIDER` / `_MODEL` / `_API_KEY` / `_BASE_URL` from
  `.env` (written by `bun run setup` / `octi init`), seeds a
  default `model_config` row, stores the API key in the vault.
  Idempotent.

Programmer-visible:

- **`before-agent-start` hook.** New typed mutable-context hook in
  `src/core/orchestrator/hooks.ts`. Fires inside `runOrchestrator`
  with `BuildSystemPromptOptions` — handlers can prepend, append,
  or substring-replace the system prompt. The persona-block
  injector is the first consumer. `SECURITY_PREAMBLE` and
  `roles/orchestrator/prompt.md` stay byte-untouched (DESIGN.md
  rule #6). Extensions can subscribe — see PLUGINS.md.
- **New meta-tools on the orchestrator:**
  - `remember_about_self` — writes durable behavioral rules into
    the per-user persona profile (parallel to `remember_this`).
  - `reflect` — answers "what are you doing?" by reading the live
    swarm tree, no spawn, no LLM call.
- **New REST routes** at `/api/persona` (GET resolved, GET
  /presets, PATCH, POST /facts, DELETE /facts/:idx, POST /reset).
  See API.md.
- **Schema:** new `category='assistant'` rows in `profiles`,
  composite `(user_id, category)` index added by migration 0060.
- **Docs:** `docs/CONFIGURATION-PRECEDENCE.md` explains the
  `.env`-bootstrap vs DB-runtime split; `personas/octipus.yaml`
  is the canonical voice spec; full design at
  `docs/plans/ux-personality-revamp.md`.

1929 / 0 / 133 pass / fail / skip on `bun test src`. Typecheck +
lint clean.

### Legacy `source_type` retirement (2026-05-17, PR #28)

Completes the column-retirement flagged after the memory-redesign
cleanup arc. Phase A (migration 0049) added `purpose` as the
canonical categorisation column; `source_type` carried alongside
it during the soft-migration window. This drops `source_type`
entirely.

**Breaking — single-operator cut. External callers, MCP-tool
prompts, and the web UI all switch in lockstep.**

- **Schema.** Migration 0056 drops `embeddings_source_type_idx` and
  the `source_type` column. Idempotent. The Phase A backfill already
  mirrored every value onto `purpose`, so no information is lost.
- **Service.** `EmbeddingService.store / indexText / indexStructured /
  search / ftsSearch / hybridSearch / listAll / readById /
  deleteBySource` now take or return `purpose: EmbeddingPurpose`
  instead of `sourceType: string`. `getStats()` returns `byPurpose`.
  `SearchResult.sourceType` → `purpose`. The `purposeFromSourceType`
  shim is removed.
- **API.** `POST /knowledge/search`, `POST /knowledge/index`, and
  `GET /knowledge` rename the request field `sourceType` → `purpose`.
- **MCP tool.** `search_knowledge` argument renames `source_type` →
  `purpose` with an updated description listing the canonical values
  (`document`, `code`, `message`, `image_description`,
  `knowledge_artifact`, `ephemeral`). `read_knowledge` return field
  renames as well.
- **Web.** `/knowledge` page renames every visible reference — types,
  state, query strings, the "Source Type" picker label (now
  "Purpose"), the color/icon registries. New colors for
  `image_description`, `knowledge_artifact`, and `ephemeral`.
- **Other callers.** `rag/health.ts` probe row uses
  `purpose='ephemeral'` + a unique `sourceId` for cleanup;
  `retention-service.ts` orphaned-doc and legacy-ephemeral filters
  use `purpose`; `indexer.ts`, `documents/processor.ts`, and
  `tools/filesystem/index.ts` pass `purpose` directly.

### Memory-redesign cleanup follow-up — Phases A-G (2026-05-16, PR #27)

Seven follow-up phases on top of the original Phase 1-7 audit fixes.
Plan in `.octipus/memory-redesign.md`; commits `fbf2a8f..e416263`.

- **Phase A — clear desk.** Drop unused `SCIM_PATCH_SCHEMA` (biome
  lint); gate the Whisper-dependent voice tests on `WHISPER_BINARY`
  + `WHISPER_MODEL_PATH`; gate the LiteLLMClient-dependent
  embeddings tests on `INTEGRATION=1` so the unit suite is green
  by default; mark `.octipus/memory-redesign.md` as shipped;
  update `docs/QA.md` for the deleted permanent `qa-demo` channel.
- **Phase B — memory finish-the-job.** `recordAgentCompletion`
  derives `task_state.task_kind` from the role (`review` → `review`,
  `qa`/`security` → `finding`, else `agent_output`); new
  `TaskStateRepository.reapOrphans` drops typed-output rows whose
  session was deleted; new `scripts/check-embedding-drift.ts` +
  `db:check-embedding-drift` npm script + boot-time warning when
  the `embeddings` or `memories` table carries multiple distinct
  `embedding_version` values.
- **Phase C — memory user-facing.** PII filter at the judge
  boundary (redact-not-drop, confidence knocked down 0.2 on
  redaction); new `remember_this` orchestrator meta-tool for
  explicit fact promotion through the same judge pipeline; new
  `config.memory.extractionCadence` (`per_turn` / `on_compaction`
  / `off`); new `/memory` web page + `GET/DELETE /api/memory`
  endpoints + supersession-chain viewer + soft-delete (sets
  `valid_until`, preserves audit trail).
- **Phase D — architecture cleanup.** Split retention out of
  `rag/embeddings.ts` (1100+ lines) into
  `rag/retention-service.ts`; remove `compactedSummary` writes
  in favour of the `compaction_entries` log; readers fall back
  to `compactedSummary` only for sessions compacted before this
  change; mark `SessionContext.compactedSummary` `@deprecated`;
  codify the repository-pattern exceptions list in
  `CONTRIBUTING.md`.
- **Phase E — test coverage.** New `scim.test.ts` (8 auth-refusal
  tests against every endpoint); `voice.test.ts` (3 tests for
  unauth + malformed body); `channels/discovery.test.ts` (4 tests
  verifying the shipped channel folders load + uniqueness).
- **Phase F — vector index strategy.** Migration 0055 reads the
  prevailing embedding dimension across `embeddings` and
  `memories`; if homogeneous, `ALTER COLUMN TYPE vector(N)` +
  `CREATE INDEX USING hnsw (vector_cosine_ops)`; if empty,
  no-op; if drifted, `RAISE NOTICE` and skip. Restores HNSW
  performance without locking the deployment into a specific
  embedding model.
- **Phase G — infrastructure & docs.** README documents
  Bun-only server runtime explicitly; mcp-server CI now runs
  `bun run build` + asserts `dist/index.js` exists + `npm pack
  --dry-run` confirms the artefact ships in the tarball.

### Memory-redesign cleanup — Phases 1-7 (2026-05-16, PR #27)

Audit of the just-shipped memory-redesign work surfaced 4 critical
and 11 medium-priority defects. Phases 1-7 closed them.

- **Phase 1 — Phase B + D delivery gaps.** Phase B shipped writers
  but no readers — new `task_state` MCP tool
  (`list_recent_session_tasks`, `read_task_state`) added to the ten
  roles that already carry `knowledge`. `AgentContext.workspaceId`
  typed and threaded from orchestrator → swarm → worker so
  `recordAgentCompletion` finally populates the `workspace_id` FK
  that was previously NULL on every row; `swarmNodeId = agent.id`
  filled too. Memory scope wired to `classification.topic` instead
  of the constant `'orchestrator'`. `updateMemoriesAfterTurn`
  receives the just-persisted user message id and the last three
  turns. Plan-execute and expert paths now fire memory.
- **Phase 2 — schema cleanup.** Migration 0054 adds the real FK on
  `embeddings.doc_id` with `ON DELETE CASCADE` (Phase C declared the
  column but not the FK); recreates
  `memories_user_scope_type_active_idx` as a partial index
  (`WHERE superseded_by IS NULL`); refreshes the stale Phase 0/4
  nullable-userId comments on `embeddings`.
- **Phase 3 — code quality.** Replace `sql.raw` vector-literal
  splicing with parameterised binds in `memories.searchSimilar` and
  `rag.hybridSearch`. Memory judge uses the canonical
  `buildEmbeddingVersion` helper and hoists the embedding-model
  lookup out of the per-candidate loop. `renderMemoriesBlock`
  surfaces confidence next to inferred facts (`p<0.9`). Dead
  `retrieveSemantic` removed (silent factType default violated
  fail-loud). Dead "duplicates" cleanup pass removed (Phase A unique
  index makes duplicate inserts impossible).
  `cosineSimilarity` / `l2Distance` typed `column: AnyPgColumn`.
- **Phase 4 — test coverage.** 9 integration tests for
  `MemoryRepository` (supersede atomic, user isolation,
  `OR(NULL, scope)` filter, retrieveTop ordering, supersession
  chains, non-finite vector rejection, empty vector early-return);
  9 unit tests for confidence rendering + extractor boundary cases.
- **Phase 5 — small cleanup.** Delete dormant
  `src/channels/qa-demo/`; log on the `discovery.test.ts` teardown
  failure instead of a bare `catch {}`.
- **Phase 6 — npm posture.** Root package marked `private: true`
  with `license` + `repository`; mcp-server now ships `dist/` via
  `files: ['dist', 'README.md']` and a `prepublishOnly` script;
  versions synced.
- **Phase 7 — focused coverage.** `rate-limiter.ts` 0% → 85% via 13
  unit tests; `org-membership.ts` eager paths 0% → 100% via 5 tests.

### Memory-redesign — final wiring (2026-05)

Closes the two deferred "ships disabled" pieces left from the phase
batch so nothing in `.octipus/memory-redesign.md` remains a leftover.

- **Memory layer is now wired into the orchestrator turn.**
  `OrchestratorService.handleMessage` fetches the top-N active
  memories scoped to `(userId, agentScope='orchestrator')` once per
  turn and threads the rendered block into both the orchestrator's
  own system prompt and the `directResponse` system prompt via a new
  optional `extraSystemContext` parameter. After the response is
  produced, a fire-and-forget `updateMemoriesAfterTurn` extracts /
  judges / persists new facts. Auto-no-ops when (a) no model is
  bound to topic `memory_extraction` (extractor skips, no LLM call)
  or (b) the memories table is empty (retrieval returns empty,
  prompt unchanged). Zero behaviour change until the operator binds
  the extraction model.
- **`SearchResult` surfaces ancestor heading path.** `search`,
  `ftsSearch`, and `hybridSearch` now project `section_path` +
  `heading_level` so callers can render structural context next to
  a hit without a second query. `getAncestorHeadings` remains for
  callers that need the full ancestor row objects (abstracts etc).

### Memory-redesign Phase D — memories layer (2026-05)

Atomic, updatable long-term memories. Distinct from RAG embeddings
(content chunks) and `task_state` (per-session workflow). One row =
one fact about the user with ADD/UPDATE/DELETE/NOOP semantics driven
by an LLM judge.

- **New table `memories`** (migration `0053`) with self-FK
  `superseded_by` (never destructive — updates insert a new row and
  link the old). `memories_active` view filters superseded + expired
  so callers don't have to remember the predicate.
- **`src/core/memory/`** — `repository.ts` (typed CRUD, vector-scoped
  search, LFU-ordered retrieval), `extractor.ts` (LLM call: latest
  user turn → candidate facts, short-circuits on no-first-person
  turns), `judge.ts` (embed candidate, find closest existing match,
  LLM picks action, apply), `retrieval.ts` (turn-start hot list +
  `renderMemoriesBlock` for system-prompt injection).
- **ModelRegistry**: new topic `memory_extraction` (cheap model;
  extractor + judge bind to it).
- **Not auto-wired into the orchestrator.** The operator must first
  bind a model to `memory_extraction`; the wiring into
  `OrchestratorService.handleMessage` ships separately so per-turn
  LLM spend turns on deliberately.

### Memory-redesign Phase E — image-purpose tagging (2026-05)

Vision-derived rows in `embeddings` (vision-LLM caption + OCR for an
image upload) are now tagged `purpose='image_description'` at write
time, so the retention policy for images can diverge from the
document retention policy without a schema change. No vector model
or storage layer added.

### Memory-redesign Phase C — document hierarchy (2026-05)

A chunk now knows its section path. Retrieval can pull "Clause 4.2"
plus its ancestor headings into the prompt without extracting a
knowledge graph.

- **Migration `0052`** adds `parent_chunk_id` (uuid, self-FK
  ON DELETE SET NULL), `section_path text[]`, `heading_level
  smallint`, `doc_id uuid` to `embeddings`. GIN index on
  `section_path` for path queries.
- **`src/core/rag/markdown-chunker.ts`** walks Markdown, emits one
  chunk per heading and one per body block, threads `parentIndex`
  so callers can resolve `parent_chunk_id` after insert. ATX
  headings only; fenced code blocks pass through verbatim.
- **`EmbeddingService.indexText`** dispatches to the structural
  chunker when the content (or `metadata.filePath`) looks like
  Markdown. Other content types keep using the flat chunker.
- **`EmbeddingService.getAncestorHeadings(chunkId)`** walks the
  parent chain for retrieval-side ancestor injection (wiring into
  the orchestrator ships in a follow-up).

### Memory-redesign Phase A.5 — retention_policies (2026-05)

Per-purpose retention replaces the hardcoded 30-day sweep.

- **Migration `0051`** adds `retention_policies(purpose pk,
  max_age_days, lfu_min_access, lfu_min_age_days, notes, updated_at)`
  seeded with the defaults from
  `.octipus/memory-redesign-schema.sql`.
- **`EmbeddingService.cleanup`** now runs a per-purpose pass first
  (age cap OR cold-and-stale LFU per row). Result adds
  `byPurpose: Record<string, number>`. Legacy passes
  (orphaned-docs / short-entries / duplicates) remain as backstop
  for non-purpose rows.

### Memory-redesign Phase B.2 — LISTEN subscriber (2026-05)

Closes the deferred follow-up from Phase B. Sibling agents can now
react to peer completions without polling.

- **`src/db/task-state-listener.ts`** wraps a dedicated postgres-js
  connection (max=1, separate from the query pool — LISTEN ties up a
  socket). `subscribeTaskState(sessionId, handler)` returns an
  unsubscribe function; multiple subscribers on the same session
  share one upstream LISTEN via reference counting.
- Embedded (PGlite) mode returns a no-op subscriber — readers must
  poll. Same trade-off as the rest of embedded mode.
- Shutdown hook wired into SIGTERM/SIGINT so the dedicated
  connection closes cleanly on process exit.

### Memory-redesign Phase B — workflow state out of RAG (2026-05)

Sibling agents stop discovering each other's results through cosine
similarity over chunked text and start reading typed SQL rows.

- **New table `task_state`** (migration `0050`) with per-session
  LISTEN/NOTIFY trigger (`task_state_<session_id>`). Holds the typed
  durable record of agent work: inputs, outputs (jsonb), status,
  depends_on, error. Indexed by `(session_id, created_at)` for
  sibling-discovery reads.
- **`src/core/rag/auto-indexer.ts` deleted.** Agent outputs no longer
  land in the `embeddings` table — they were polluting cosine search
  (a 4 KB trace ranked against a one-line user preference). Replaced by
  `src/core/agent-task-recorder.ts`, which calls
  `TaskStateRepository.create` with the same skip-rules (orchestrator
  outputs and outputs < 100 chars are still skipped).
- **`TaskStateRepository`** added with create / complete / fail /
  updateStatus / getById / listSessionRecent / listByOwnerStatus /
  deleteDoneOlderThan. Long-lived LISTEN subscriber deferred to a
  follow-up so the connection-management story can land as its own
  reviewable change.
- **Knowledge tool + Web** drop `agent_output` from the
  `search_knowledge` source-type filter (and the Web Knowledge page
  loses the orange "Agent Output" stats tile / filter option). The RAG
  cleanup pass keeps the old branch but now matches
  `purpose='ephemeral' OR source_type='agent_output'` — steady-state
  count is expected to stay at 0.

### Memory-redesign Phase A — embeddings purpose + versioning (2026-05)

See prior batch c entry below for the artifacts/single-user batch.

- Adds `purpose`, `content_sha256`, `embedding_version`,
  `access_count`, `last_accessed_at` to `embeddings`. Migration `0049`
  truncates and adds NOT NULL columns plus a UNIQUE
  `(purpose, source_id, content_sha256)` dedup index.
- Write path: app-side SHA-256 + `embedding_version` (`<model>/<dim>`).
  ON CONFLICT (dedup key) DO UPDATE just refreshes `last_accessed_at`,
  so re-indexing unchanged content is a no-op.
- Read path: `search` / `ftsSearch` / `hybridSearch` fire-and-forget
  bump `access_count` + `last_accessed_at` on returned rows.

### Live artifacts + single-user fixes (2026-05 batch c)

Bug-fix and DX batch surfaced while bringing the live-artifacts feature
end-to-end in a single-user install.

- **Single-user mode now provisions a default workspace.** The artifacts
  feature (and any other workspace-scoped surface) previously 500'd in
  single-user installs because `resolveWorkspace` returned
  `workspaceId: null` when `multiuser.orgWorkspaces` was off. The flag
  is now correctly scoped to *multi-workspace switching*; real users
  always get a default workspace. `/api/me/workspaces` GET is no longer
  flag-gated (mutations stay gated).
- **Artifact pages render in iframes again.** The global
  `X-Frame-Options: DENY` middleware was overriding the per-artifact CSP
  and blocking the same-origin embed iframe. Artifact routes (`/a/*`,
  `/__artifacts__/*`) now skip the global XFO + generic CSP and rely on
  the per-artifact CSP with `frame-ancestors`.
- **Swarm token-budget changes now apply to running sessions.**
  `deriveChildBudget` re-reads `swarm.levelDefaults.*.tokens` from
  current config on every spawn instead of using the snapshot captured
  at root-node creation, so raising the cap via the settings UI takes
  effect on the next child spawn. Decreases still need a session
  restart (we never shrink a parent's effective cap below `used`).
- **Artifacts tool now reachable by agents.** The `artifacts` tool was
  registered but no role's `toolIds` included it, so orchestrator
  routing fell through. Added to `general` and `data` roles, with
  matching classifier keywords ("live artifact", "dashboard", "rss
  feed", etc.).
- **Tighter artifact tool descriptions + validation.**
  `create_live_artifact` / `update_live_artifact` now spell out the
  template ↔ source coupling rule, the visibility consequence
  (`workspace` returns 404 to anonymous viewers), and the auto-refresh
  wake-gate. `sources` param gains per-kind config examples; `kind` and
  `visibility` get enum constraints. The server cross-checks
  `{{data.<name>.…}}` references against attached sources and returns
  any mismatches in a new `warnings[]` field. Create now returns
  `embedUrl` + `outerUrl` + `visibility` + `warnings`.

### Multi-user + TUI follow-ups (2026-05 batch b)

Carry-overs from the May feature work — the Web UI / org-shared
resources / vault workspace / SSO / billing / TUI iteration v2
items the prior multi-user and pi-tui PRs deferred.

#### Web

- **Workspace + org pickers.** `WorkspaceProvider` now wraps the
  app under `AuthProvider`. Header gets a workspace combobox that
  lists the user's workspaces, supports inline "Create
  workspace…", and (for admins) shortcuts to `/admin/orgs`. The
  picker writes the active workspace id to `localStorage` under
  `octipus.activeWorkspace` and tells the API client the active
  *slug*, which is sent on every request as `X-Octipus-Workspace`.
- **Admin orgs page** at `/admin/orgs`: list, create, expand to
  view members. Uses the existing `/api/admin/orgs` surface; gated
  on `multiuser.orgWorkspaces` (returns 404 → page renders an
  inline "feature is disabled" hint).
- **Secrets page** wires the active workspace through: GET `/vault`
  passes `?workspaceId=<id>`, the Add modal exposes a Scope select
  (User / Workspace) when a workspace is active, and workspace-scoped
  secrets are listed alongside user-scoped ones.

#### Backend

- **`org_id` on `model_config` and `skills`** (migration `0042`).
  Visibility rule `org_id IS NULL OR user_id = U OR org_id IN
  org_members(U)` lives in `src/services/org-membership.ts` and is
  applied by `SkillRepository.findAll`, the `/api/skills` GET, and
  the new `ModelRegistry.getModelsForUser` (admins still see
  everything via the existing `getAllModelsIncludeDisabled`). New
  endpoints: `POST /api/admin/orgs/:id/{models,skills}` to assign
  rows to an org, `DELETE` to unassign.
- **Vault `scope=workspace` on the route.** POST accepts `scope`
  (`system | user | workspace`) + `workspaceId`; GET accepts
  `?workspaceId=` and forwards it to `vault.list`. The DEK
  derivation, encryption, and read path landed in Phase 4
  follow-up; this is the route surface that exposes them.
- **SCIM 2.0** at `/api/scim/v2`: List / Get / Create / PATCH /
  DELETE Users + List Groups, RFC-7643/7644 shapes. Per-org Bearer
  auth — the token is stored in vault under `scope='system'` and
  referenced by `org_sso_config.scim_token_vault_ref`. Auth-guard
  exempts `/api/scim/`; the routes do their own bearer check.
- **SAML SSO** at `/api/saml/:orgSlug/{metadata,login,acs}`,
  fully implemented via `samlify`. Migration `0043_org_sso_config`
  adds the per-org config (entityId, ssoUrl, x509Cert, attributeMap,
  plus the SCIM token ref). On a successful ACS the handler
  verifies the assertion signature, maps attributes via the org's
  `samlAttributeMap` (defaults match Okta/Azure AD/OneLogin),
  upserts the user, ensures `org_members` membership, and mints
  the same `session_token` HttpOnly cookie the password-login
  path uses. RelayState is honored but sanitized to same-origin
  paths. New `GET/PATCH /api/admin/orgs/:id/sso` endpoint and
  admin web page at `/admin/orgs/[id]/sso` for IdP paste-in
  config (entity ID, SSO URL, x509 cert, attribute map, SCIM
  toggle + vault-ref). Schema validator defaults to a noop;
  operators wanting strict XSD validation can install
  `@authenio/samlify-xsd-schema-validator` and set
  `SAML_SCHEMA_VALIDATOR=strict`.
- **Billing hooks.** `BillingProvider` interface
  (`src/services/billing/provider.ts`) with `noop` (default) and
  `stripe` (stub) implementations, env-gated by `BILLING_PROVIDER`.
  `CostTracker.logUsage` fires `recordUsage` after every cost-log
  insert — fire-and-forget so a billing outage never blocks chat.
  New `GET /api/admin/orgs/:id/usage` aggregates spend per org
  (joins `cost_log` to `org_members`).

#### TUI

- **Tree-sitter highlighter.** `web-tree-sitter` +
  `tree-sitter-{typescript,python,rust,go,java}` are dependencies;
  grammar `.wasm` files load directly from `node_modules/` via
  `Bun.resolveSync`. `setHighlighter()` is hooked at startup; the
  buffer-oriented adapter parses on `setSource(lang, text)` (called
  on every `openFile`) and caches per-line tokens. Falls back to
  the regex highlighter on grammar-load failure or for languages
  without a grammar (markdown, yaml, …).
- **Workspace-switch instant reconnect.** `GatewayAdapter` gained
  `reconnectWithWorkspace(slug)` — closes the WS, swaps the slug,
  reuses the exponential-backoff reconnect. New `/workspace
  <slug>` slash command (or `/workspace -` for the default).
- **Scrollable messages pane.** PageUp / PageDown move
  `scrollOffset` in 30-row pages; an `↓ N newer messages`
  indicator surfaces when the user is reading history. New
  messages auto-pin to the bottom *only* when the user is
  already there, so a long agent reply mid-scroll doesn't yank
  history away.
- **Vim named registers + IME-aware INSERT.** `VimState.registers`
  is a `Record<string, string>` keyed by register name. `"x` in
  NORMAL mode selects the register for the next `y` / `d` / `p`,
  then resets to the default `"` register. New `VimKey.composing`
  flag suppresses leader matching during IME composition so a
  multi-byte CJK / dead-key sequence can't fire `gg` / `dd` /
  `yy` mid-compose.

#### Migrations

- `0042_org_scoped_models_skills.sql` — adds `org_id` columns + indexes.
- `0043_org_sso_config.sql` — per-org SAML + SCIM config.

Both are additive and idempotent (`IF NOT EXISTS`); single-user
installs see no behavior change.

### Multi-user is the default

Multi-user isolation (`multiuser.enabled`, `enforcePermissions`,
`orgWorkspaces`) flipped from opt-in to default-on. The
`MASTER_KEY` Bearer fallback is suppressed by default — every
HTTP and WebSocket request now must carry either a real session
token (cookie, after logging in) or a personal `octi_…` api
token. Existing installs that want the legacy single-user path
can set `MULTIUSER=false` in `.env`.

#### Master key role
- Stays as the **vault encryption root** (HKDF derives per-user
  DEKs from it). Rotating the master key still goes through
  `scripts/rotate-vault-keys.ts`.
- No longer authenticates HTTP / WS clients on its own. The
  Bearer fallback remains only when `multiuser.enabled=false`.

#### MCP / CLI clients — automatic bootstrap token
- On startup (when multi-user is on), the backend mints a
  personal api token named `mcp-bootstrap` for the first active
  admin user and writes the plaintext to `~/.octipus/mcp-token`
  (mode 600). Idempotent — a second restart keeps the existing
  token if the file + DB row are still valid.
- `bin/octi` now reads `~/.octipus/mcp-token` first when
  regenerating `.mcp.json` and the user-scope `gemini mcp`
  registration. The .mcp.json regen is called twice during
  `octi start` — once before launching the backend (so legacy
  installs still work) and once after backend health (so the
  freshly minted bootstrap token lands in the file). Rotating
  the MCP key is now `rm ~/.octipus/mcp-token` then
  `octi restart`.

#### WebSocket gateway accepts api-tokens
- `connection-manager.ts:auth_method=api_key` previously matched
  only against `MASTER_KEY`. It now validates `octi_…` tokens
  against the `api_tokens` table (the same path the REST `.derive`
  middleware uses) and only honors `MASTER_KEY` when multi-user
  is off. The browser extension's WS connection now works with
  any personal api token from Settings → API Tokens.

#### Bug fixes from the QA exercise
See the previous Unreleased entries — this release rolls them in:
session 404 status leak, missing `multiuser.orgWorkspaces` registry
entry, env-var fallback dead in `settings-service.warmCache`, admin
sidebar nav, impersonation banner placement, and `session.token`
splicing for `/admin/impersonate/*`.



### TUI rewrite on pi-tui

Both terminal surfaces — the chat shell (`octi tui`,
`src/tui-pi/`) and the editor (`octi edit`, `src/tui-editor/`) —
were rewritten on top of [`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui),
replacing the previous Ink (React for the terminal) implementation.

#### Why
- Pi-tui's differential renderer is materially faster on long chats
  and large file buffers (only changed cells are written; no virtual
  DOM diff).
- The same `Editor` primitive backs **both** the chat composer and
  the file-buffer editor, so paste markers, undo, history nav,
  fuzzy file completion (`@…`, `./…`), and slash-command
  autocomplete behave identically across surfaces.
- Pi-tui exposes a small `KeybindingsManager` we extend with app
  ids (`app.palette.open`, `app.tree.toggle`, …) and let users
  override via `~/.octipus/keybindings.json`.

#### Chat shell (`octi tui`)
- Status bar + welcome + scrolling messages pane (markdown for
  assistant, plain wrap for user/system).
- Composer with slash command + fuzzy file autocomplete.
- Activity line (live tool spinner with hold-on-completion).
- Permission prompt overlay, command palette (`Ctrl+P` / `F4`).
- TUI-local commands `/exit`, `/quit`, `/cost`, `/project`
  short-circuit before hitting the gateway; everything else flows
  through the standard slash registry.

#### Editor (`octi edit`)
- Three-pane layout (file tree / buffers / chat) with `Ctrl+B`,
  `Alt+J`, `Ctrl+\` toggling and `Alt+,` / `Alt+.` cycling buffers.
- File picker (`Ctrl+O`) with case-insensitive substring filter on
  the relative path.
- Find / replace overlays, diff overlay (accept/reject agent edits),
  workspace picker, MCP server list, scrollable hotkeys overlay (`F5`).
- Vim mode toggle (`editorMode: 'modeless' | 'vim'`) covering
  hjkl / w / b / 0 / $ / gg / G / i / a / o / O / v / x / dd / yy
  / p / u / Ctrl+R, with VISUAL-mode delete + yank.
- Persisted layout / cursor / open-buffer state at
  `~/.octipus/tui-editor.json`.
- New `octi edit` command in `bin/octi`.

#### Key-binding rationale (defaults avoid terminal collisions)
- `Ctrl+M`, `Ctrl+H`, `Ctrl+J`, `Ctrl+I`, `Ctrl+[` are
  indistinguishable from `Enter`, `Backspace`, `LF`, `Tab`, `Esc`
  on terminals without the Kitty keyboard protocol — none are
  bound by default. (`Ctrl+H` was previously `app.replace.open`
  and `Ctrl+M` was `app.mcp.list`; both silently ate `Enter` /
  `Backspace` in overlays.)
- `Ctrl+Tab` doesn't reach most terminals — buffer cycle moved to
  `Alt+,` / `Alt+.` (also `F2` / `F3`).
- `F1` is hijacked by many terminals as a help key — hotkeys
  overlay rebound to `F5`.

#### Glyphs
- Tree / status emojis replaced with a glyph table that defaults
  to ASCII (`[+]`, `·`, `❯`) on terminals whose fonts lack the
  emoji subset, and switches to emoji only when a known
  emoji-capable terminal is detected (`kitty`, `wezterm`,
  `iterm.app`, `vscode`, `apple_terminal`, `ghostty`). Override
  with `OCTIPUS_TUI_ICONS=emoji|ascii`.

#### E2E tests
- New harness at `tests/tui/harness.ts` (spawn under fixed
  `COLUMNS` / `LINES`, send raw bytes, ANSI-strip, `waitFor`).
- Suites `tests/tui/chat.e2e.test.ts`, `tests/tui/editor.e2e.test.ts`
  cover launch, focus cycling, slash commands, the picker filter,
  the command palette, and `/quit` exit code. Skipped when the
  gateway isn't reachable.

#### Notable bug fixes during the rewrite
- Chat submit dropped to a no-op because the editor's
  `submitValue()` clears state *before* invoking `onSubmit`, and
  the host then read back the (empty) state via
  `getExpandedText()`. Now uses the `rawText` argument the editor
  passes through.
- Editor pane height collapsed to the floor (5 rows) via a
  feedback loop where `setHeight(N)` was sourced from the previous
  render's `editorLines.length`. Heights now derive from
  `tui.terminal.rows` directly.
- Markdown hyperlinks (`OSC 8`) leaked into the visible-width
  count so cursor moves shifted the editor↔chat divider in by ~7
  cells. `SplitPane.fitTo` uses pi-tui's `visibleWidth` (CSI + OSC
  + wide-char aware).
- Hotkeys overlay shrank instead of scrolling — it now reads the
  terminal height (matching the 85% `maxHeight` in
  `overlays/registry.ts`), reserves rows for chrome, and emits a
  fixed-size viewport every render with a position indicator.

## 2026-05 — Multi-user feature complete

The multi-user architecture has reached feature completeness across
five phased PRs (0–4 + Phase 4 follow-ups). Every behavioral change
is gated behind a feature flag that defaults off; existing single-
user installs see byte-for-byte unchanged behavior until an operator
flips a flag.

Full design + per-phase rationale lives in
[`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md).
Manual validation steps in
[`docs/QA.md` §7](docs/QA.md#7-multi-user--full-feature-exercise).

### Added

- **Identity primitives.** `Principal` type + `principalFromUser` /
  `principalFromMasterKey` / `ANONYMOUS_PRINCIPAL` /
  `SYSTEM_PRINCIPAL`. Server `.derive()` produces it on every
  request alongside the legacy `user`.
- **Scoped repositories.** `scopedRepos(principal)` factory wraps
  eight entities (sessions, messages, agents, documents,
  notifications, trajectories, hooks, pipelines). Cross-tenant
  reads collapse to `null`/`[]` so attackers can't enumerate UUIDs.
- **Vault scoping.** `scope` enum (`system`/`user`/`workspace`),
  per-user data-encryption keys via
  `HKDF(masterKey, salt=userId, info=scope:userId)`, opportunistic
  v1 → v2 re-encryption on read,
  `scripts/rotate-vault-keys.ts` for batch rotation, master-key
  rotation tooling (`scripts/rotate-master-key.ts`).
- **Per-user workspace filesystem.** `WorkspaceFS.forAgent(ctx)`
  with traversal / absolute-path / symlink-escape blocks.
  Filesystem tools rewired through it so single-user (flat) and
  per-user (nested) layouts share one call site.
- **Personal access tokens.** `octi_<43-char-base64url>` Bearer
  format with SHA-256 hash storage. `/api/auth/api-tokens` CRUD
  + web UI under `/settings/api-tokens`. Lets CI / MCP /
  scripted clients authenticate as a real user.
- **Admin console.** `/admin/users`, `/admin/audit`,
  `/admin/quotas`, `/admin/impersonate`. User CRUD, audit log
  viewer with filters, per-user quota dashboard, "Act as" with
  banner.
- **Channel binding.** `channel_identities` table + manager with
  O(1) `(channel_type, external_id)` lookup. JSONB fallback +
  lazy backfill for legacy bindings. Web `/link-account` page
  + 6-character one-time codes.
- **Postgres Row-Level Security.** 19 user-owned tables get
  `enable rls + policy` with the "bypass on missing GUC" pattern.
  `withRlsPrincipal(principal, fn)` / `withRlsBypass(fn)`
  wrappers. Defense-in-depth alongside the application-layer
  scoping.
- **Quotas.** Per-user concurrent-agents / daily-tokens /
  API-rate caps. Admin REST + web; runtime enforcement in
  `agent-manager.spawn()`, `agent-worker` pre-LLM-call, and the
  rate-limit middleware. `QuotaExceededError` returned as `429`.
- **Admin impersonation.** `impersonation_sessions` table +
  `ImpersonationManager`. Server `.derive()` swaps the request's
  identity to the target user but stamps `principal.actorUserId`
  so audit can dual-tag (every state-changing request writes one
  row keyed under the actor and one under the target).
- **Shell sandbox.** bubblewrap / firejail wrapper
  (`security.shellSandbox = 'off' | 'auto' | 'required'`) for the
  shell tool. Pairs with WorkspaceFS for filesystem-level +
  process-level isolation.
- **Docker tool isolation.** Per-user `octipus.user_id=<uuid>`
  label + `octipus_user_<short-uuid>` bridge network.
  `list_containers` filters; targeted ops verify ownership via
  `docker inspect` and surface mismatches as "container not
  found" so attackers can't enumerate.
- **Org / workspace scaffolding.** `organizations` +
  `org_members` + `workspaces` tables.
  `OrgWorkspaceManager` with admin-gated org CRUD, per-user
  workspace CRUD, atomic default-promotion via tx, "cannot
  delete default" guard.
- **Workspace_id adoption.** Nullable `workspace_id` on every
  user-owned table (sessions, documents, hooks, agents,
  notifications, trajectory_runs, pipelines, embeddings,
  agent_events, swarm_nodes, vault). FK `ON DELETE SET NULL`
  so workspace deletion falls back to user-level rather than
  cascading. ScopedRepos filter on
  `(workspace_id = $1 OR workspace_id IS NULL)` and stamp the
  principal's workspaceId onto new rows.
- **Workspace resolver.** `X-Octipus-Workspace` request header
  (slug / uuid / `all` / `default`) maps to a workspace owned by
  the principal. Cross-tenant headers collapse to default.
- **Backfill script.** `scripts/backfill-workspace-id.ts` walks
  every user, ensures a default workspace, and updates rows
  with NULL `workspace_id` across all 11 user-owned tables.
  Idempotent (`--dry-run`, `--user=<uuid>`).
- **REST surface.** `/api/me/workspaces` + `/api/me/orgs`
  (caller-scoped) and `/api/admin/orgs` (admin) surface the
  org/workspace data.

### Configuration

New feature flags (all default off):

| Flag | Env | Default | Effect |
|------|-----|---------|--------|
| `multiuser.enabled` | `MULTIUSER` | `true` | Master switch. Strict scoped reads, audit logging, and MASTER_KEY bypass disabled. Opt out with `MULTIUSER=false` for the legacy single-user / MASTER_KEY path. |
| `multiuser.auditShadow` | `MULTIUSER_AUDIT_SHADOW` | `true` | Writes one `audit_log` row per state-changing API request (no behavioral effect). |
| `multiuser.enforcePermissions` | `MULTIUSER_ENFORCE_PERMISSIONS` | `true` | Orchestrator gate: every tool call goes through `checkToolCall`. The legacy `isSystemUser` bypass is honored only when this is `false`. |
| `multiuser.rlsEnabled` | `MULTIUSER_RLS` | `false` | Sets the RLS GUC on every authenticated query. PGlite ignores. Requires a non-superuser app role; opt-in. |
| `multiuser.orgWorkspaces` | `MULTIUSER_ORG_WORKSPACES` | `true` | Enables `/api/me/workspaces`, `/api/me/orgs`, `/api/admin/orgs`, the workspace resolver, and scopedRepo workspace filtering. |
| `security.shellSandbox` | `SHELL_SANDBOX` | `off` | `off` / `auto` / `required` — wraps shell-tool spawns in bubblewrap/firejail. |
| `security.dockerIsolation` | `DOCKER_ISOLATION` | `off` | `off` / `enforce` — Docker tool per-user labels + networks. |

### Tests

- 11 new test files added under `src/security/` and
  `src/db/repositories/` covering the multi-user changes
  (scoped repos, vault DEK + isolation, RLS gating, quotas,
  impersonation, shell sandbox, docker isolation, orgs,
  workspace resolver, workspace-scoped repos, channel
  bindings).
- 6 isolation test files under `src/api/routes/` for
  cross-tenant 404 collapse on every changed route.
- Total impact: ≈ +130 multi-user tests.

### Documentation

- [`docs/architecture/MULTI-USER.md`](docs/architecture/MULTI-USER.md)
  — design doc, threat model, per-phase implementation notes.
- [`docs/QA.md` §7](docs/QA.md#7-multi-user--full-feature-exercise)
  — manual validation steps for the full multi-user feature.
- This `CHANGELOG.md`.

### Out of scope (future)

- Web UI workspace + org pickers (REST surface is in place).
- Org-shared resources (system models, shared skills) routed
  through `org_members` — needs `org_id` on `models` and
  `skills` first.
- SCIM provisioning + SAML SSO.
- Per-user billing hooks.
