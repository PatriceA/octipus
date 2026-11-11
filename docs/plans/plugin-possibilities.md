# What plugins can do, and what they could do next

Status: agreed (2026-11-11); decisions recorded under Decisions. Builds on
[plugins for everything](plugins-everything.md) and the
[marketplace](marketplace.md). For the current contract, see
[PLUGIN-PACKAGES.md](../PLUGIN-PACKAGES.md).

## The rule every proposal follows

The goal is to let people build and share any of their ideas, safely.

There are four hard boundaries:
- the sandbox;
- signatures;
- the listing has to match the downloaded plugin;
- runtime enforcement of exactly what was declared.

Everything else is guidance. Each declaration is shown in plain words at install, and the admin agrees to each item.

So every new capability below is:

1. **declared** in the manifest;
2. **shown** as a consent item in plain words;
3. **enforced** by the host at runtime: the plugin cannot do it without the declaration, and cannot do more than declared;
4. **capped** by protection levels wherever user data is involved;
5. **diffed** on upgrade: a new or wider capability needs a fresh tick.

The plugin never gets a credential, a database handle or a code path into the server. It only asks the host, and the host decides.

## What a plugin can do today

| Area | What it can do | How |
|---|---|---|
| **Tools** | Give agents tools, each declared `read`, `write` or `external` | An MCP server over stdio, in the sandbox |
| **Slash commands** | `/name args` runs one of its tools as the user | `commands` |
| **Schedules** | Run a tool on a cron, unattended, as the installing admin | `schedules` |
| **Events** | React to `chat.response`, `document.completed`, `document.failed` (ids only) | `events` |
| **Prompt and context** | Add static text to agents' system prompt; add turn context from a `read` tool | `prompt`, `context` |
| **Pages** | Its own pages in the sidebar, in a sandboxed frame, calling its own tools | `ui.pages` |
| **Octipus data** | Notes and tasks (read/write), documents (read/write), notifications | Host API scopes |
| **Mail** | Read the user's mailboxes and connected inbox; save drafts; send (external tools only, level 1) | `mail:read`, `mail:draft`, `mail:send` |
| **Calendar** | Read the connected calendars in a window; add events and change its own | `calendar:read`, `calendar:write` |
| **The web** | Fetch a page through the host's SSRF guard and extraction | `web:read` |
| **The model** | One completion on the user's lane | `model:complete` |
| **Background agents** | Start a host agent run (web search, knowledge, documents…) and read its result | `agent:run` |
| **Its own network** | Talk to declared hosts only, through its egress proxy | `network` |
| **Its own secrets** | API keys an admin sets, given to it as environment variables | `secrets`, `settings` |
| **Its own storage** | Files in a private folder only it can see (`OCTIPUS_PLUGIN_DATA_DIR`), and a per-user store its tools and pages reach | `store` |

## What a plugin cannot do, and why

| It cannot… | Why | Possible later? |
|---|---|---|
| Read your cases, contacts or knowledge | No scope for them yet | **Yes:** read scopes (proposal 1; mail and calendar are built) |
| Show a dashboard of sensitive data | A page can leak what it shows by navigating away, so pages are capped at protection level 1 | **Yes:** host-rendered dashboards (proposal 2) |
| Add an AI model provider | Only in-process plugins can (`registerProvider`), and the marketplace refuses those | **Yes:** a sandboxed provider (proposal 3) |
| Call your MCP servers or Octipus tools | A plugin reaches only its own tools and the host API | **Yes:** an allowlist of tool calls (proposal 5) |
| Use your connected accounts (Google, GitHub…) | It sees only the secrets declared for it, never the vault | **Yes:** credential injection (proposal 6) |
| Receive webhooks from outside | No public endpoint for plugins | **Yes:** inbound hooks (proposal 7) |
| Hook into the agent loop, or replace a core service | Only in-process code could, which runs with the server's full rights | **No** for sandboxed plugins: that is the trust line |
| Read another plugin's data or the database directly | It would break isolation between plugins and users | **No** |

## How other systems compare

DeepSeek Harness plugins run inside the server process with full rights:
- they write any file and open any database;
- they can even replace the storage layer ("persistence backends" are a plugin contribution) and the model adapters;
- there is no scoping, and its own docs say installed plugins run outside the sandbox.

That's maximal reach with no trust boundary. The proposals below aim for the same kinds of features, each as a declared, consented and enforced capability.

## Proposals

### 1. Read scopes for Octipus data

**Status: mail and calendar built** (2026-11-11), with their write scopes; see
[Mail and calendar](../PLUGIN-PACKAGES.md#mail-and-calendar). As built:
`mail:read` covers the Mail module's mailboxes (each message at its own
level) and the connected Gmail or Microsoft 365 inbox (level 4: it carries
none); `mail:draft` never sends; `mail:send` is for external tools only and
counts as egress (level 1), with the per-call tool approval as the send's
approval; the calendars count as the level an admin sets
(`plugins.calendarProtectionLevel`, default 3). Contacts, cases, records,
knowledge and sessions are still to come.

This is what makes "build your own view" possible.

| Scope | Gives | Consent item |
|---|---|---|
| `mail:read` | Messages (headers, text) from the user's connected mailboxes, with search and filters | "Reads your mail" |
| `calendar:read` | Events in a date range | "Reads your calendar" |
| `contacts:read`, `cases:read`, `records:read` | The business data, by type | "Reads your cases" … |
| `knowledge:search` | Search over the user's knowledge, returning passages | "Searches your knowledge base" |
| `sessions:read` | Session titles and summaries, not the full transcripts | "Sees the titles of your conversations" |

- **Protection levels:** every item carries its level. A plugin gets only items up to its `maxProtection`, and a plugin with network access, `web:read`, `model:complete`, `agent:run` or pages is capped at 1, as today. Mail and cases above level 1 therefore reach only a plugin with no way out. That is what proposal 2 is for.
- **Write scopes in the same round** (`mail:draft`, `mail:send`, `calendar:write`, `cases:write`) follow the `documents:write` pattern: as the user, a `write` effect (`external` for sending mail), the user's rules, and provenance on every item.
  - **Sending mail** keeps the host's existing approval for outgoing mail.
- **Effort:** medium. Each scope is a host API route on existing repositories, plus tests and wording.

### 2. Host-rendered dashboards

**The problem:** a page is the plugin's own HTML and JS, so it can leak what it shows by navigating to another site. The CSP can't block a frame navigating itself. So a page only ever sees level-1 data, which rules out a mail dashboard.

**The idea:** a new `dashboards` contribution. The plugin **declares** a dashboard and the **host renders it**, with no plugin JavaScript involved:

```json
"dashboards": [{
  "id": "inbox-overview", "title": "Inbox overview",
  "widgets": [
    { "type": "stat",  "title": "Unread",        "query": { "scope": "mail:read", "count": { "unread": true } } },
    { "type": "list",  "title": "From customers", "query": { "scope": "mail:read", "filter": { "fromTag": "customer" }, "limit": 10 } },
    { "type": "chart", "title": "Tasks by status", "query": { "scope": "tasks:read", "groupBy": "status" } },
    { "type": "tool",  "title": "Open invoices",  "tool": "list_open_invoices" }
  ]
}]
```

- **Queries:** widgets are a fixed set (stat, list, table, chart, calendar, markdown). Queries are a small declarative language over the read scopes, run by the host as the viewing user.
- **Plugin data:** a `tool` widget shows what one of the plugin's own `read` tools returns. It is rendered as data, never as HTML.
- **No egress:** the host draws everything with the app's own components, so nothing leaves. A dashboard can show data at **any** protection level the user may see, and the plugin never receives it.
- **Consent:** "Adds a dashboard: Inbox overview (shows your unread mail count and recent mail from customers)". Every query's scope must also be declared.
- **Who it's for:** most dashboards people want: a CRM view, a support inbox, a weekly-review board. Plugins that need their own UI keep pages, at level 1.
- **Effort:** medium to large: the widget set, the query language, the renderer, the editor wording.

### 3. A sandboxed model provider

```json
"providers": [{ "id": "my-llm", "models": ["my-llm/large"], "tool": "complete" }]
```

- **How:** the host routes chat completions for those model ids to the plugin's `complete` tool, streaming where possible.
- **Where it can be used:** only on lanes an admin explicitly binds to it. Never for the root agent, and never picked automatically.
- **Isolation:** the plugin stays sandboxed. It reaches only its declared network hosts, such as the provider's API, with its own API key as a secret.
- **Consent:** "Provides AI models: my-llm/large. Conversations sent to these models go to this plugin, and from it to api.example.com".
- **Protection:** it is egress by nature, so the host's routing treats it like a remote provider. Levels 3–4 stay local unless the plugin is declared `local: true`, meaning `network: []` and talking only to a local runtime through a declared socket.
- **Effort:** medium. The model router already has a provider abstraction, and this is one more kind of provider.

### 4. A per-plugin store

**Status: built** (2026-11-11). Per user only, as decided; see [Store](../PLUGIN-PACKAGES.md#store).

Scopes `store:read` and `store:write`:
- small JSON values per key;
- scoped **per user only**: no store shared across users;
- a quota, e.g. 5 MB per user;
- reachable from the plugin's tools, and from its pages through the bridge, which gives page state between visits.

**Consent:** "Keeps up to 5 MB of its own data per user".

**Effort:** small. It is a table, a host API route and quotas.

### 5. Calling Octipus tools and MCP servers, by allowlist

A `tools:call` scope with an explicit list:

```json
"calls": [{ "tool": "mcp.github.list_issues" }, { "tool": "knowledge", "action": "search" }]
```

- **How it runs:** each call runs as the user through the normal tool executor, with that tool's own effect, the user's permission rules and protection levels.
- **Unattended calls:** inside schedules and events, an ASK is refused as usual.
- **Consent:** one item per listed tool, with its effect: "Can use GitHub: list issues (read)".
- **Limits:** no wildcards. An MCP tool that isn't connected for the user simply fails.
- **Effort:** medium. Mostly the executor path and the consent and diff.

### 6. Using your connected accounts without seeing the credentials

Declare `connections: [{ "kind": "google", "hosts": ["gmail.googleapis.com"] }]`:
- The host's egress proxy **injects the user's existing OAuth token** for exactly those hosts.
- The plugin calls Gmail's API directly but never sees a token. Network secrets already work this way for cloud sessions.

**Consent:** "Uses your Google account to reach gmail.googleapis.com".

This lets plugins build on what the user already connected, without a vault read.

**Effort:** medium. The token lookup is per user and per call, through the per-call host token.

### 7. Inbound webhooks

Declare `hooks: [{ "id": "invoice-created", "tool": "on_invoice" }]`:
- the host exposes `/hooks/plugin/<name>/<id>` with a per-install secret, and verifies a signature when the sender supports one;
- it forwards the body to the declared tool, unattended, as the installing admin, with the same rules as schedules.

This covers plan point C2b: a new invoice in DATEV opens a case.

**Consent:** "Accepts calls from outside at a private web address".

**Effort:** small to medium. The webhook machinery already exists for the core.

### 8. Windows sandbox runner

**Status: built** (an AppContainer runner, merged separately).

**Why plugins did not run there before:** the sandbox is a hard boundary, and the runners exist only for Linux (bubblewrap, firejail) and macOS (`sandbox-exec`).

**Works today:** run Octipus in WSL2 or Docker Desktop, which are Linux underneath, so bubblewrap works.

**A native runner:** a small helper (`octipus-sandbox.exe`) starts the plugin in an **AppContainer** inside a **Job object**:
- **Files:** no access except ACL grants on the plugin's package folder (read) and data folder (read/write).
- **Network:** the AppContainer gets no `internetClient` capability. A loopback exemption allows only the plugin's egress proxy, which keeps declared hosts enforced.
- **Limits:** the job object kills the process tree on stop and caps memory and processes.

Node can't create AppContainers itself, so the helper is native, e.g. Rust or C# shipped with the Windows build.

**Effort:** medium to large, plus Windows CI to test it.

## Suggested order

| # | Proposal | Why first |
|---|---|---|
| 1 | Store (4), **built** | Small; unblocks page state and real plugin data |
| 2 | Read and write scopes (1), mail and calendar first, **mail and calendar built** | The base for "build your own view" |
| 3 | Host-rendered dashboards (2) | The safe way to show sensitive data |
| 4 | Credential injection (6) | Plugins build on accounts users already connected |
| 5 | Tool allowlist (5) | Lets plugins compose with MCP servers |
| 6 | Inbound hooks (7) | Integrations that react to the outside world |
| 7 | Sandboxed provider (3) | Smaller audience; the router change is contained |

The Windows runner (8) is built: an AppContainer runner, merged separately.

## Decisions

1. **Dashboards and pages side by side.** Host-rendered dashboards for sensitive views; pages for custom UI, capped at level 1 as today.
2. **The store is per user only.** There is no store shared across users.
3. **Mail and calendar write scopes come in the first round**, together with the read scopes.
4. **A sandboxed provider serves only lanes an admin binds to it**, never the root agent.
5. **The Windows runner** is built (merged separately).
