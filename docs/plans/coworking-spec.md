# Coworking — implementation spec

> **Spec, revision 2, 2026-10-04.** This turns [coworking.md](coworking.md)
> (the concept) into buildable work against `main` at 6c47b51. Revision 1 was
> reviewed against the code by four independent reviewers (116 findings); this
> revision folds every verified finding in. Two owner directions shape it:
>
> 1. **Octipus is always multi-user.** No single-user mode, no switch for
>    workspaces or spaces. Single-user leftovers are removed, not worked around.
> 2. **What we touch, we finish.** Half-built parts on the path (workspaces,
>    the knowledge base, deactivation, the web socket) are completed, and the
>    bugs found on the way are fixed in the phase that touches them.
>
> Every statement about today's code carries a `file:line` reference. Phases
> S0–S6 are specified to the level of tables, functions, call sites and tests.
> S7 (several installs) is a contract on top of the unbuilt federation
> transport of [workroom-and-swarm-federation.md](workroom-and-swarm-federation.md).

## Contents

- §1 What the code does today (including live cross-user leaks)
- §2 Decisions
- §3 Security invariants
- §4 S0 — Groundwork: leaks, one multi-user model, real workspaces, web on the gateway
- §5 S1 — Shared spaces
- §6 S2 — Rooms
- §7 S3 — Live documents
- §8 S4 — Own models (bring your own agent)
- §9 S5 — Sponsored agent, team surface, group-channel bridge, space connectors
- §10 S6 — Guests and registration modes
- §11 S7 — Spaces across installs (contract)
- §12 Cross-cutting
- §13 Open questions

---

## 1. What the code does today

### 1.1 Live cross-user leaks (fixed first, in S0a)

These affect every install with more than one user, today.

| # | Leak | Evidence |
|---|---|---|
| L1 | The agent's documents tool lists and reads **every user's** documents, including OCR text | `src/tools/documents/index.ts:64,66,100` call `documentRepository.findByCategory / listRecent / findById`, which have no owner filter (`src/db/repositories/document-repository.ts:40,54,77`) |
| L2 | The knowledge base is install-wide: chunks are stored without user or workspace, and `GET /api/knowledge` lists and reads every chunk; the documents and knowledge tools search all of it | `src/core/rag/embeddings.ts:306-331` (`userId: ownerUserId ?? null`), `src/core/documents/processor.ts:947-953`, `src/tools/filesystem/index.ts:160-161` (auto-index on every write), `src/core/research/persist.ts:90-95`, `src/api/routes/knowledge.ts:63,176`, `src/tools/documents/index.ts:133`, `src/tools/knowledge/index.ts:163-169` |
| L3 | Global search returns every user's session titles and hooks | `src/api/routes/search.ts:52-62` |
| L4 | Swarm and pipeline events reach every signed-in browser | `userId: undefined` at `src/core/agent/worker-spawner.ts:951,1080,1136`, `src/core/swarm/spawner.ts:259,474,2408,2418`; all ten `pipeline_event` emits in `src/core/agent/pipeline-manager.ts` (893…2959) carry no user; `/ws` forwards user-less events (`src/api/websocket.ts:113,163`), and so does the gateway (`src/core/gateway/hub.ts:103`) |
| L5 | A remote admin gets `local` trust by sending `X-Forwarded-For: 127.0.0.1` (or simply through a reverse proxy on the same host); any admin API token gets `system` trust from anywhere. Both trust levels see every user's events and pass every session ownership check: chat into or steer any session, read any session's history, see every user's skill proposals, answer anyone's permission requests, stop any agent | `src/api/gateway-ws.ts:28-31` (ip from client headers first), `src/core/gateway/connection-manager.ts:262-266,333`, `hub.ts:103`, `message-handler.ts:35-36,467,572`, `commands.ts:330-345,393-399` |
| L6 | The `/ws` `voice` frame toggles voice mode on any session id | `src/api/websocket.ts:252-262` (no owner check; compare `steer` at `:381`) |
| L7 | Deactivated users keep access: sessions, API tokens, passkeys, SAML, every socket; trust and admin flags are snapshots | `src/security/auth/session.ts:159-178`, `src/api/server.ts:203-213,236-240`, `src/api/routes/saml.ts:233-257`, `src/api/websocket.ts:458,559`, `src/api/voice-ws.ts:126`, `src/api/gateway-ws.ts:15-24`, `connection-manager.ts:256-266,324-335`; `revokeAllForUser` has no caller (`session.ts:292`) |
| L8 | A SCIM token of one org can deactivate any user on the install | `src/api/routes/scim.ts:305-310` (DELETE scopes only the `org_members` delete; compare PATCH's org join at `:246-251`) |
| L9 | The artifacts tool imports a function that does not exist and falls back to an arbitrary workspace of the user | `src/tools/artifacts/index.ts:141-153` imports `getOrgWorkspaceManager` from `@/services/org-membership`, which exports only `getUserOrgIds` (`src/services/org-membership.ts:20`); fallback `limit(1)` with no order |
| L10 | Admins answer any user's permission requests, members or not | `src/api/websocket.ts:349-352`, `src/security/permissions.ts:548` |

### 1.2 Ownership and isolation

- Every content row has one owner column, `user_id`, plus an optional
  `workspace_id`; `NULL` workspace means "visible in every workspace of this
  user" (`src/db/repositories/scoped.ts:110-117`). Admins skip the owner filter
  on by-id reads and writes (`scoped.ts:139,208,222`), but the workspace filter
  still applies to them (`scoped.ts:106-109`).
- `scopedRepos(principal)` covers ten nouns (`scoped.ts:1368-1402`). Notes,
  artifacts, memories, knowledge links and embeddings go through singleton
  repos taking a raw `userId`. `sessionRepository` is used by 46 files,
  `messageRepository` by 14, `artifactsRepository` by 11.
- Raw readers that bypass every repo: notes graph (`src/api/routes/graph.ts:44-55,99-104`),
  heartbeat task probes (`src/core/heartbeat.ts:196-198,305-316`), role agents
  (`src/core/tasks/role-agents.ts:49`), wakeup bridge (`src/core/tasks/wakeup-bridge.ts:207`),
  channel tasks (`src/core/channels/taken-tasks.ts:109`), memory routes
  (`src/api/routes/memory.ts:53,84,139,147`), weekly review
  (`src/core/knowledge/weekly-review.ts:79`), global search (L3).
- RLS policies exist (migrations 0034–0038, 0085) but are never applied:
  `withRlsPrincipal` has no production caller, `multiuser.rlsEnabled` is off,
  and policies pass when the GUC is missing (`src/security/rls.ts:30-60`,
  `0034_rls_policies.sql`). Notes, tasks, task comments, artifacts, memories and
  knowledge links have no policy.

### 1.3 Single-user leftovers

Octipus says it is always multi-user (`src/config/schema.ts:398-403`,
`src/config/legacy-loader.ts:146`), but:

- `multiuser.orgWorkspaces` can switch workspaces off, with five disagreeing
  defaults: Zod `false` (`schema.ts:443`), `defaults.ts:99` `true`, registry
  `true` with a description saying "Off by default"
  (`settings-registry.ts:1063-1070`), legacy env `=== 'true'`
  (`legacy-loader.ts:152`), runtime "anything but `'false'`"
  (`runtime-loader.ts:61-63`).
- The gateway `local` method signs in as the literal user `local`
  (`connection-manager.ts:270-286`), which `resolveUserId` maps to "the first
  admin" it finds (`src/core/gateway/resolve-user.ts:10-24`) — an arbitrary
  person on an install with several admins.
- `'system'`/`'local'` user ids get special treatment: a flat, shared file root
  (`src/security/workspace-fs.ts:163,171-212`), no rate limit
  (`src/api/middleware/rate-limit.ts:166`), no docker isolation
  (`src/security/docker-isolation.ts:35`), skipped connectors
  (`src/tools/atlassian/index.ts:98`).
- Stale `multiuser.enabled` comments (`scoped.ts:33`, `workspace-fs.ts:148`,
  `docker-isolation.ts:8`, `src/db/schema/api-tokens.ts:10`, `schema.ts:84`) and a
  dead `user.id === 'system'` branch in `/auth/me` (`src/api/routes/auth.ts:288-302`).

### 1.4 Workspaces are half-wired

- `workspaces(id, user_id NOT NULL ON DELETE CASCADE, slug, name, is_default)`
  with `UNIQUE(user_id, slug)` (`src/db/schema/organizations.ts:74-88`).
- The resolver accepts an owned UUID or `(user, slug)` and silently falls back
  to the default (`src/security/workspace-resolver.ts:67-103`); the server
  derive swallows resolver errors and continues **without** a workspace, which
  removes the workspace filter entirely (`src/api/server.ts:302-308`,
  `scoped.ts:110-117`).
- The agent ignores the workspace: each turn uses the default
  (`src/core/agent/service.ts:291-303`); the role-heartbeat hook too
  (`src/hooks/actions.ts:485-489`); `/ws` chat creates sessions without one
  (`websocket.ts:281-288`); gateway `chat.send` uses the default
  (`src/core/gateway/message-handler.ts:219-230`) although the TUI sends
  `?workspace=` (`src/core/gateway/client.ts:56-59`) that the server never reads
  (`gateway-ws.ts:28`).
- Files: `WorkspaceFS.forPrincipal` defaults the segment to `'default'`
  (`workspace-fs.ts:126-142`) and no caller passes a workspace;
  `forSession` roots at `session.userId` (`workspace-fs.ts:227-239`).
- Notes: lists, query, index and tags ignore the workspace
  (`src/db/repositories/note-repository.ts:67-120`); `POST /` and `POST /capture`
  take `workspaceId` from the body unchecked (`src/api/routes/notes.ts:49,76,137,144`);
  `getBySlug` matches the workspace exactly (`note-repository.ts:52-65`).
- `transfer()` moves sessions, documents, hooks and vault rows only
  (`src/security/orgs.ts:504-611`); the backfill script skips notes, tasks,
  memories and links (`scripts/backfill-workspace-id.ts:73-85`).
- `notes`, `tasks`, `knowledge_links`, `workspace_repos`, `background_jobs`
  have no foreign key on `workspace_id` (0063, 0065, 0066, 0072, 0092).
- Vault: `getByName` can select a `scope='workspace'` row but `get()` then
  filters on the caller's inferred scope, so it is never returned
  (`src/security/vault.ts:250-262,371-386`); the filter also matches
  `workspace_id IS NULL` (`:371-373`); `transfer()` rewrites `user_id` without
  re-encrypting (`orgs.ts:571-578`).
- Web: the client sends the slug (`web/lib/workspace-context.tsx:129-132`,
  `web/lib/api.ts:114-116`), sets it in a `useEffect` after render (`:130-133`),
  and query keys do not include the workspace (`web/app/providers.tsx:20-30`).

### 1.5 Sessions, turns, messages

- `sessions.user_id` is the only access key (`src/db/schema/sessions.ts:8`);
  `messages` has no author column.
- The main turn path's only ownership gate is `resolveSession`
  (`src/core/agent/session-resolver.ts:36`); `service.ts:188-190` guards only
  the control/approval fast path. Inline `session.userId !== userId` checks also
  live in `work-plan-tools.ts:8`, `src/core/monitors/service.ts:24`,
  `src/skills/script-runner.ts:30`, `test-container.ts:67`,
  `src/core/cli-agent-worker.ts:429`, `progress-message.ts:23`,
  `src/core/learning/queue.ts:29`, `src/api/routes/models.ts:515`,
  `src/api/routes/skills.ts:70`, `src/core/gateway/commands.ts:343`,
  `message-handler.ts:40,250`, `src/skills/selection-command.ts:21`,
  `src/hooks/actions.ts:279`, `src/channels/approval-prompts.ts:165`; the
  gateway skips the check entirely for `local`/`system` trust
  (`message-handler.ts:35-36`), and the agents routes let admins act on any
  agent (`src/api/routes/agents.ts:173,305,347,381,417`).
- `readSessionHistory` has four consumers: agent worker (`agent-worker.ts:552`),
  direct responses (`direct-response.ts:70`), CLI turns
  (`cli-agent-worker.ts:377,892`), compaction (`session-compaction.ts:92`).
  Transcripts carry no speaker names.
- Turns queue in an in-process FIFO without a waiter list
  (`src/core/session-turn-lock.ts`); WS text during a running turn is steered
  into it (`websocket.ts:306-314`); `/stop` stops running agents only.
- `sharedAudience = !!session.groupChannelId` (`service.ts:317`) is repeated
  in the flow guard (`flow-guard.ts:270-291`), compaction
  (`session-compaction.ts:205-207`), learning (`learning/processor.ts:36-39`) and
  message aggregation (`sessions.ts:331-333`). Child workers load memories with
  no such check (`worker-spawner.ts:693-699`).
- Flow labels are per session and never cleared (`flow-guard.ts:181-195`). The
  voice plan gate is keyed by session (`service.ts:567-575`). The `/model`
  override is keyed by session (`session-model-override.ts:16-21`).

### 1.6 Real-time

- The browser uses legacy `/ws` and `/ws/permissions`
  (`web/app/chat/page.tsx:624`, `web/lib/permission-context.tsx:153`); the TUI
  uses `/gateway`. `/ws` allows one socket per user (`websocket.ts:46,80-85`)
  and the web ignores close code 4000 (`page.tsx:639`). The gateway allows 10
  per user (`connection-manager.ts:43-47`) and is documented as the endpoint
  clients should use (`gateway-ws.ts:6-9`); AGENT.md rule 5 says per-channel
  logic that cannot go through the gateway means "fix the gateway".
- Gateway replay buffers are never read and never pruned (`event-bus.ts`);
  `PresenceTracker` is never instantiated (`src/core/gateway/presence.ts`).
- No CRDT dependency exists. Notes save is last-write-wins
  (`notes-workspace.tsx:104-116`, `notes.ts:42-64`). Session-file writes check a
  version non-atomically (`session-files.ts:187-235`); agent writes carry no
  version. The board polls every 30 s (`web/app/tasks/page.tsx:50,270-282`).
- No WebSocket `maxPayload` is set (`src/api/http/serve.ts:42`), so the `ws`
  default of 100 MiB applies.

### 1.7 Tools, permissions, flow guard

- `routeApproval` (`src/security/approval-policy.ts:96-119`) has six callers:
  `tool-executor.ts:684`, `base-tool.ts:185`, `cli-permissions.ts:58`,
  `mcp-authorization.ts:15`, `swarm/scorers.ts:883`, `action-recovery.ts:76`.
- Gemini/Antigravity CLIs run with `--dangerously-skip-permissions` when no
  permission mode is set (`src/core/cli-adapters.ts:720`).
- `isReadOnlyAction` accepts exactly `read|list|search|inspect`
  (`src/core/action-recovery.ts:24-26`); MCP actions are `<server>.<tool>`
  (`src/mcp/bridge.ts:672`).
- `applyFlowGuard(mode, sessionId, call, permission)` is synchronous, has no
  context and returns early when the mode is `off` (`flow-guard.ts:348-353`).
- Notes, documents and knowledge tools call singletons with raw
  `context.userId` (`src/tools/notes/index.ts:65,98,147,248,261,289,337`,
  `src/tools/documents/index.ts:64,100,133`, `src/tools/knowledge/index.ts:163,234`);
  only the tasks tool builds a principal (`src/tools/tasks/index.ts:299-311`).

### 1.8 Models, cost, budgets

- Selection returns `modelId` strings and rows are re-read by
  `getModelByModelId` (`LIMIT 1`, global cache `model:mid:<id>`) at
  `model-selector.ts:113-118`, `agent-manager.ts:196`, `agent-worker.ts:2164`,
  `providers/index.ts:198`, `litellm-client.ts:449`,
  `custom/base-custom-provider.ts:50` and others; `name` is unique but `modelId`
  is not (`src/db/schema/models.ts:11`).
- Every registry query is unscoped except `getModelsForUser`
  (`src/models/model-registry.ts:121-186,212-222`). `PUT /api/topics` demotes any
  other primary holder (`src/api/routes/topics.ts:160-180`).
- Built-in providers read env then the system vault; only OpenRouter and
  Ollama accept `options.apiKey` (`openrouter-provider.ts:121`,
  `ollama-provider.ts:159`). Custom providers resolve the key under
  `options.userId`, the requester (`base-custom-provider.ts:75,93-113`). Vertex
  caches one token manager (`vertex-provider.ts:180-183`).
- CLI children get the server's `HOME`/`CODEX_HOME` and
  `CLAUDE_CODE_OAUTH_TOKEN` (`src/core/cli-child-env.ts:15-17,34`) at three spawn
  sites (`cli-agent-worker.ts:1110`, `cli-provider.ts:644`, `cli-compaction.ts:33`).
- `cost_log` has no `workspace_id` and no funding (`models.ts:133-155`); the
  usage context is `ProviderUsageContext` (`instrumented.ts:7-36`), separate
  from the logging `RunContext`.
- Spend budget scopes `user | role | workspace | group_channel`; `spendSince`
  filters `cost_log.user_id = budget.user_id` except for `group_channel`
  (`spend-budgets.ts:195-212`); `checkSpend` loads the requester's budgets plus
  group budgets by session (`:266-321`) and is called at
  `agent-manager.ts:150`, `agent-worker.ts:1113`, `cli-agent-worker.ts:756`,
  `heartbeat.ts:723`, `group-listen.ts:319`. Budget writes are admin-only
  (`admin.ts:331-490`). The token quota sums `agents` rows
  (`src/security/quotas.ts:131-134`).
- `AgentContext.attended` means "an approval can reach a person"
  (`approval-policy.ts:66`); REST turns are `attended=false`, and several spawns
  leave it undefined (`src/api/routes/agents.ts:249`, `src/hooks/actions.ts:430`).

### 1.9 Users and auth

- Registration is open and the first user becomes admin (`auth.ts:358-405`);
  register and login write no audit row (`auth.ts:1-14`). Password reset does not
  exist. There is no mail transport (`src/core/email/service.ts:200-215`).
- The login page always returns to `/` (`web/app/login/page.tsx:86,116`) and
  checks `totpRequired` while the server sends `requiresTOTP`
  (`page.tsx:63`, `auth.ts:76`), so TOTP users cannot sign in from the web.
- Token patterns: artifact share links hash at rest and check revocation
  (`src/core/artifacts/share-link.ts:25-68`) but revoke is not scoped to the
  artifact (`src/api/routes/artifacts.ts:546`, `artifacts-repository.ts:251-256`);
  device pairing stores the raw code and redeems non-atomically
  (`src/api/routes/devices.ts:80-87`).
- `auth-guard.ts` matches its public list by path prefix, ignoring method
  (`src/api/middleware/auth-guard.ts:3,42`).

---

## 2. Decisions

- **D1 — A space is a workspace with `kind = 'shared'`.** `workspace_id` already
  sits on every noun that matters; the resolver, picker and header key on it.
- **D2 — Shared workspaces have no owning user row.** `workspaces.user_id`
  becomes nullable; `kind='personal'` ⇔ `user_id IS NOT NULL` (CHECK). A space
  records `created_by` separately. This removes, by construction, the creator
  bypass through `findOwned*`, the slug clash with the creator's namespace, the
  cascade that would delete a space with its creator's account, and raw
  `workspaces.user_id = me` queries matching spaces (`artifact-pages.ts:69-72`).
- **D3 — Two doors.** Personal access stays on the personal repos. Space access
  goes through `src/db/repositories/space.ts`, keyed only by `workspace_id` after
  a membership check. Personal paths never return rows of a shared workspace —
  for authors and for admins alike (I2).
- **D4 — `user_id` on a content row in a space means "author".** It stays
  NOT NULL on content tables for audit and attribution and grants nothing.
- **D5 — Membership is read from the database** per request, at the start of
  every turn, in `routeApprovalFor` (every tool decision), and on every
  space-scoped socket frame that changes state. The one exception is document
  updates at keystroke rate, which check an in-process membership version
  counter bumped by `onMembershipChanged` (single process, D16).
- **D6 — Roles are code**: `owner | editor | commenter | viewer | guest`, one
  `can(role, action)` table.
- **D7 — Rooms are sessions with `kind='room'`** in a shared workspace. Rooms
  are invisible to every personal session path, including for their creator.
- **D8 — Every room turn runs as its requester.** Room turns enter only through
  `handleRoomMessage`, never through the personal chat paths. A room is a shared
  audience: private reads are ASK to the requester only, stating that the
  answer is posted in the room; approving is consenting. Private work belongs in
  the private side panel.
- **D9 — Approvals are answered by the requester only.** Commenters cannot
  trigger writes (D6, §5.6), so the requester of any write is an editor. Admins
  who are not members cannot answer space requests (fixes L10 for spaces).
- **D10 — Personal memories never enter a space session** (room or private
  session in a space, including child workers). Space memory replaces them
  (§6.5).
- **D11 — The web moves to the gateway** (S0d). Rooms, presence and live
  documents are gateway protocol messages. Legacy `/ws` and `/ws/permissions`
  are retired. This follows AGENT.md rule 5 instead of breaking it.
- **D12 — RLS stays out of coworking.** Enforcing it needs every request's
  queries inside a transaction that sets the user, an app database role without
  bypass, and the operator setup in MULTI-USER.md §3b — a cross-cutting project.
  Adding space policies that nothing enforces would be decoration. The access
  layer plus grep-driven isolation tests are the guarantee; RLS is open
  question 1.
- **D13 — Funding is explicit, never inferred.** Every agent context carries a
  `trigger` (what started it) and a `funding` (`own | sponsor`) decided by
  `fundingFor` from the trigger — never from `attended`. Both land in S1 with
  `own` as the only outcome; S5 adds `sponsor`. A third value, `install`, is
  never an agent's funding: it is stamped only on install-topic model calls
  (compaction, embeddings, memory extraction, toolshim, decision, vision, ocr)
  so those rows are told apart in `cost_log`. Every agent spawn and iteration
  keeps today's `checkSpend`.
- **D14 — Install CLI models are personal subscriptions unless marked.** In
  space sessions they resolve only when `metadata.cliAgent.sharedUse === true`.
- **D15 — Space content is never orphaned into personal scope.** A space is
  archived (no writes, no agent runs), then purged by an explicit job that
  deletes every row of every `workspace_id` table (`WORKSPACE_TABLES`, §4.3) and
  verifies none is left before it deletes the workspace row; nothing else ever
  deletes a shared workspace. Foreign keys keep their personal semantics
  (`SET NULL`), so personal workspace deletion is unchanged. Any user-deletion
  path refuses to delete a space's last owner.
- **D16 — Single process.** Room fan-out, presence and document state live in
  memory. Multi-process real time is out of scope and documented as such.
- **D17 — Spaces are always available.** No feature switch. Who may create a
  space is a policy setting, `spaces.creation: 'any_user' | 'admins'`
  (default `any_user`).

---

## 3. Security invariants

Each invariant has tests that drive the real route, tool or socket path, and
the isolation suites are grep-driven: they fail when a new raw read of a content
table appears outside an allowlisted file.

- **I1 — Membership is the only door to space content**, read in the same
  request, turn or tool decision (D5).
- **I2 — Personal paths never return space rows**: personal repos, singleton
  repos, raw readers (§1.2), knowledge search, global search, `*Admin` lists,
  and admin by-id bypasses on sessions and messages.
- **I3 — Non-members get 404** for space, room, invite, member and
  document ids, including through presence and search.
- **I4 — No tool runs above the requester's role**, on all six approval paths
  and for CLI models' native tools.
- **I5 — Removal and downgrade take effect at once**: next request, next tool
  decision, next socket frame; running and queued work of a removed member in
  that space stops; their subscriptions end.
- **I6 — Personal data reaches a space only with the requester's consent**: ASK
  on private reads in rooms, and on writes into space content after a private
  read in a private space session, regardless of the flow-guard mode.
- **I7 — Personal memories never load in a space session**, including child
  workers.
- **I8 — Invites are bearer secrets**: hashed at rest, single conditional
  redeem, revoke scoped to its space, clamped expiry.
- **I9 — Space content is never orphaned** into a member's personal scope by
  deletion, transfer, removal or account deletion.
- **I10 — Every membership, invite, role, funding and binding change writes an
  audit row** with actor and `workspace_id`.
- **I11 — No event, chunk or search hit crosses users** outside the rules above
  (fixes L1–L5).

---

## 4. S0 — Groundwork

S0 ships no sharing. Four PRs, in order. S0a can ship on its own and should
ship first.

### 4.1 S0a — Close the live leaks (L1–L10)

**Documents (L1).** `documentRepository.findByCategory` and `listRecent`
(`document-repository.ts:54,77`) are deleted; `findById` (`:40`) is renamed
`findByIdSystem` and allowlisted for its six system callers (job recovery,
document queue and processor, channel delivery: `src/channels/index.ts:291,339`,
`src/core/jobs/recover.ts:26`, `src/core/documents/queue.ts:63,167`,
`processor.ts:175`). The documents tool uses
`scopedRepos(agentPrincipal(context)).documents` (`listOwnByCategory`,
`listOwn`, `findById`, `scoped.ts:465-551`). `agentPrincipal(context)` is the
one builder of a principal from an agent context and always sets
`isAdmin: false`, as `TasksTool.principalFor` does today
(`src/tools/tasks/index.ts:298-311`), so an admin's agent never inherits the
repos' admin bypass.

**Knowledge base (L2).** One scope type replaces every `userId?` parameter and
composes with the existing repo-visibility `SearchScope`
(`embeddings.ts:125-138`) by conjunction:

```ts
type KnowledgeScope =
  | { kind: 'personal'; userId: string; workspaceId: string | null }
  | { kind: 'space'; workspaceId: string }   // from S1
  | { kind: 'install' };                       // admin (audited) and system jobs only
// Product docs (user_id NULL, metadata.source = 'octipus-docs', seed-docs.ts:25,57,163)
// are readable under every scope.
```

- **Writes.** `store`/`indexText` (`embeddings.ts:306-371`) require
  `{ ownerUserId, workspaceId }` (product docs pass `{ product: true }`). The
  dedup key becomes `(purpose, source_id, content_sha256, user_id,
  workspace_id)` (`src/db/schema/embeddings.ts:147`), so two users indexing the
  same path never overwrite or adopt each other's rows. Callers: documents
  processor (`processor.ts:931-953`), notes reindex (`notes.ts:183-197`),
  research `persistReport` (`research/persist.ts:90-95`), the file indexer
  (`src/core/rag/indexer.ts:30-81`: filesystem auto-index
  `filesystem/index.ts:160-161`, knowledge tool `index_file` and
  `index_directory` `tools/knowledge/index.ts:265`, `POST /api/knowledge/index`
  `knowledge.ts:338`), repo registry (`registry-service.ts:110-117`), seed docs.
- **Reads and mutations.** `search`, `ftsSearch`, `hybridSearch`, `listAll`,
  `readById`, `getAncestorHeadings`, `searchGlobalDocs`, `deleteById`,
  `deleteBySource`, `isFileIndexed`, `verify`, `cleanup`, `getStats` take a
  `KnowledgeScope` through one `scopePredicate(scope)`. Install-wide cleanup and
  stats require `{ kind: 'install' }`: admin-only routes, audited.
- **Routes and tools.** `GET/DELETE /api/knowledge[/:id]`, `POST /cleanup`,
  `GET /stats`, `/cleanup-history`, `POST /index` (`knowledge.ts:63,86-100,176,
  190-230,245,264,338`) and the knowledge tool's `cleanup_knowledge`,
  `verify_knowledge`, `index_directory`, `knowledge_stats`
  (`tools/knowledge/index.ts:121,265,290-310`) use the caller's personal scope;
  admins get install scope only through `?scope=install`, audited.
- **Migration `0125_knowledge_scope.sql`** assigns owners to `user_id IS NULL`
  rows: `doc:` rows (documents and research reports, which are `documents` rows,
  `persist.ts:72`) join `documents` on `embeddings.doc_id`
  (`schema/embeddings.ts:121`) and take `user_id` (cast only when it matches the
  UUID pattern, since `documents.user_id` is text) and `workspace_id`; file rows
  take user and workspace from their path
  `<rootPath>/users/<uid>/workspaces/<segment>/files/…` (segment `default` →
  that user's default workspace); product docs stay `user_id NULL` and are
  marked by their source. Rows matching none of these stay `install` rows,
  visible to admins (audited) and system jobs only (open question 5). The PR
  states the counts on a sample install.

**Global search (L3).** `src/api/routes/search.ts` filters sessions and hooks by
`user_id = me` and uses the caller's knowledge scope.

**Events (L4).** `GatewayEvent.userId` and `TurnEvent.userId`
(`protocol.ts:125-133`, `service.ts:53-58`) become required. The only user-less
events are named in `GLOBAL_EVENT_TYPES` with a reason: gateway connection
audit events before authentication (`hub.ts:174-185`) go to no client;
`extension.notify` (`src/extensions/api.ts:86-94`) is stamped with the
extension's installing user. `AgentNode` gains `userId`
(`src/core/swarm/types.ts:246-264`), set where nodes are built. Every emitter in
L4 is stamped, including all ten `pipeline_event` sites and
`swarm.call_graph_cycle_blocked`. Delivery on `/ws` (until S0d removes it) and
the gateway: `event.userId === connection.userId`, whatever the trust level.
Artifact events gain `workspaceId` and go to owners of that workspace (members
from S1); the gateway gains the `artifact_token` auth method the live-artifact
client already sends (`web/public/octipus-artifact-client.js`;
`connection-manager.ts:239-349` has none), subscribing that connection to that
artifact's events only.

**Client addresses (L5).** One `clientIp(request, socketAddress)` helper
honours forwarded headers only when the socket address is in
`security.trustedProxies` (new; default empty; the operator docs show the
setting for a reverse proxy). The gateway (`gateway-ws.ts:28-31`), REST rate
limits (`rate-limit.ts:84`), auth lockouts (`auth.ts:24,141,365,521`) and audit
(`audit-shadow.ts:70`) all use it. The gateway's per-IP cap applies to
connections that have not authenticated yet only, so a proxy does not become an
install-wide cap.

**Trust levels (L5).** Trust never widens what a connection may see or touch:

- The `local` auth method and the `local` trust level are removed, and the TUI
  moves to the CLI login, in this PR (described under §4.2); the
  session-token upgrade to `local` on loopback (`connection-manager.ts:262-266`)
  goes with it.
- Admin API tokens get `user` trust (`connection-manager.ts:333`); `system`
  trust is for HMAC channel adapters only.
- Every ownership check compares user ids regardless of trust:
  `sessionAccessError` (`message-handler.ts:35-36`), permission answers
  (`:467`), `agent.stop` (`:572`), the `history` command and skill proposals
  (`commands.ts:330-345,393-399`). Machine-level commands (`/reload`,
  `commands.ts:479`) require `isAdmin` read from the database.
- Trust and admin are recomputed by `onUserChanged` (below).

**Voice (L6).** The `voice` frame checks session ownership like `steer`; the
plan gate is keyed by `(sessionId, userId)` (`service.ts:567-575`).

**Deactivation (L7, L8).**

- `SessionManager.validate` reads `users.is_active, is_admin, username` by
  primary key; inactive → revoke and return null; `isAdmin` is the database
  value. `SessionManager.create` refuses inactive users (covers password, SAML,
  passkey, pairing).
- `ApiTokenManager.validate` (`src/security/api-tokens.ts:170-200`) joins
  `users` and requires `is_active`.
- One `setUserActive(userId, active, actor, source)` helper is the only writer
  of `is_active`. It records `users.deactivated_by` (`admin | scim:<orgId>`)
  so SCIM `active:true` never re-enables a user an admin deactivated. Callers:
  admin PATCH (`admin.ts:121-172`), SCIM PATCH (`scim.ts:264`), SCIM DELETE.
- Deactivation revokes sessions (`revokeAllForUser`), closes every socket of
  the user (gateway, `/voice`, browser bridge), stops their agents, expires
  their pending permission and approval requests, and is audited.
- Hooks, recurring tasks, monitors and heartbeats skip inactive users at fire
  time (`src/hooks/manager.ts:125`, `cron-runner.ts`, `heartbeat.ts`).
- Impersonation of an inactive target ends the impersonation
  (`server.ts:246-256`).
- `onUserChanged(userId)` fires on `is_active` and `is_admin` changes and closes
  the user's gateway connections, so admin rights are recomputed on reconnect.
- **SCIM (L8).** DELETE and PATCH answer 404 for users who are not members of
  the token's org; both set `is_active=false` only when no other org membership
  remains (otherwise they only remove the membership).

**Artifacts tool (L9).** `resolveDefaultWorkspaceId` is deleted; the tool uses
`context.workspaceId` and fails loudly when it is absent (house rule 1), at all
14 call sites.

**Admin approvals (L10).** Permission and approval requests are answered by
their requester. An admin answers someone else's request only through
`POST /api/admin/permission-requests/:id/resolve` with a reason, which is
audited; the generic answer paths (`websocket.ts:349-352`,
`permissions.ts:548`, `message-handler.ts:467`) drop the admin bypass.

**Tests:** `src/api/leaks.isolation.test.ts` — two users; B gets nothing of A's
documents (tool and route), knowledge entries (read, delete, cleanup, stats),
search hits, swarm, pipeline and turn events (`/ws` and gateway), voice toggle,
history command, permission requests; an admin on loopback behind a proxy
without `trustedProxies` gets `user` trust and cannot open another user's
session; a forged forwarded header changes nothing; a deactivated user's
session, API token, passkey, SAML login and every socket fail; a demoted
admin's socket is closed and reconnects without admin rights; a SCIM token
cannot deactivate another org's user; a hook of a deactivated user does not
fire; product docs stay searchable for a non-admin after 0125.

### 4.2 S0b — One multi-user model

- **Workspaces are always on.** `multiuser.orgWorkspaces` is removed from the
  schema, defaults, registry, legacy loader and runtime loader, and every reader
  drops the branch: `workspace-resolver.ts:79`, `src/api/routes/orgs.ts:41-46`,
  the admin UI copy (`web/app/admin/orgs/page.tsx:58`), the tests that set it
  (`orgs.isolation.test.ts:117-121`, `swarm.test.ts:45`,
  `workspace-resolver.test.ts:65`), the comments in `schema/organizations.ts:26`,
  `principal.ts:56`, `server.ts:290`, `orgs.ts:14`, and the docs
  (`docs/architecture/MULTI-USER.md`, `docs/QA.md`). `/api/orgs` routes remain
  admin-gated. A startup step deletes a stored `multiuser.orgWorkspaces`
  settings row.
- **No pseudo-user sign-in.** The gateway `local` auth method is removed. The
  TUI signs in with the existing CLI login (`src/core/gateway/cli-session.ts`,
  `session.json` with a session token); a TUI without one prompts once ("run
  octi login"). The hub stops minting `~/.octipus/local-token` at boot
  (`hub.ts:45`) and the client stops minting its own (`client.ts:66`).
  `resolveUserId`'s "first admin" fallback (`resolve-user.ts:10-24`) is deleted;
  a non-UUID user id reaching a UUID column is a bug and throws.
- **`'system'` is only for system jobs**, never a connection identity. Each
  special case is restated as "real user or system job": `WorkspaceFS.forAgent`
  for a system job requires an explicit `{ system: true, root }` and never the
  flat root for a user path (`workspace-fs.ts:171-212`); system jobs keep their
  rate-limit exemption (`rate-limit.ts:166`) and stay outside per-user docker
  isolation (`docker-isolation.ts:35`); per-user connectors keep refusing calls
  without a real user (`atlassian/index.ts:98`, restated as "no user → refuse").
- Stale `multiuser.enabled` comments and the dead `/auth/me` branch
  (`auth.ts:288-302`) are removed.
- **Fail closed on workspace resolution.** The derive answers 503 for an
  authenticated `/api` or `/v1` request when resolution throws, instead of
  continuing unscoped (`server.ts:302-308`).
- **Auth hygiene on the path:** register and login write audit rows; the login
  page reads `requiresTOTP` and shows the TOTP field (`page.tsx:63`,
  `auth.ts:76`); login and register accept a validated same-origin `returnTo`;
  device pairing codes are stored as `sha256(code)` in the KV store and redeemed
  with an atomic get-and-delete (`GETDEL`, or a Lua script on Redis;
  `devices.ts:80-87`).
- **User deletion.** No route deletes users today (`userRepository.delete` has
  no production caller). Any future deletion path must call
  `assertDeletable(userId)` (S1 adds "not the last owner of a space").

**Tests:** no `orgWorkspaces` key anywhere; the TUI signs in through the CLI
login and gets that user's identity; a non-UUID user id at a UUID column
throws; a resolver failure answers 503; TOTP sign-in works in the web
(Playwright); a pairing code redeems once under two concurrent requests.

### 4.3 S0c — Workspaces become real

- **Turn workspace.** `handleMessageInner` uses `session.workspaceId ??
  defaultWorkspace(userId)` and checks that the user owns it (S1 adds
  membership); the try/catch that proceeds with `null` goes (`service.ts:291-303`).
  Same in `hooks/actions.ts:485-489` and gateway `message-handler.ts:219-230`.
- **Session creation carries the workspace**: REST (already), gateway
  `chat.send` and the TUI's `?workspace=` (resolved at gateway auth, stored on
  `ConnectionContext`), and the web (S0d).
- **Files per workspace.** `WorkspaceFS.forPrincipal` uses the workspace id as
  the segment, except the user's default workspace, which keeps the literal
  `default` segment so no existing file moves. `forAgent` takes the full
  `AgentContext` (not `{ userId }`) and `forSession(session)` uses
  `session.workspaceId`; every caller found by grep changes, among them
  `shell/index.ts:240`, `swarm/spawner.ts:58,2583`, `swarm/scorers.ts:712,927`,
  `src/api/routes/workspace.ts:27`, `knowledge.ts:297`, `sessions.ts:375-517`,
  `script-runner.ts:32`, `pipeline-manager.ts:2056`, `cli-agent-worker.ts:799`,
  `cli-compaction.ts:34`, `test-container.ts:70`, `message-handler.ts:251`,
  `connectors/cocoindex.ts:223`, `gateway/commands.ts:536`,
  `repos/registry-service.ts:20,27`, `agent/service.ts:531`,
  `root-runner.ts:510`, `worker-spawner.ts:147,671`, `tool-output-spill.ts:100`,
  `tools/filesystem/index.ts:679`, `tools/data/index.ts:184`,
  `tools/knowledge/index.ts:23`. A test fails on any remaining
  `forAgent({ userId`. Files that today sit in `default` but were created from a
  non-default workspace stay in `default`; the CHANGELOG says so.
- **Shell cwd** must lie inside the workspace root, an allowed extra, or the
  dev-mode `projectPath`. Documented as correctness, not a sandbox.
- **Memories follow the session's workspace**, including memories written after
  compaction (`session-compaction.ts:190` passes `workspaceId: null` today) and
  the plan path (`service.ts:510`). Behaviour change for users of several
  workspaces (memories learned in a non-default workspace were filed under the
  default); CHANGELOG note, no migration.
- **Notes.** All note routes (`/`, `/query`, `/index`, `/tags`, `/:id`,
  backlinks, `/capture`) use `principal.workspaceId` with the personal rule
  `(workspace_id = $ws OR workspace_id IS NULL)`; `getBySlug` and
  `getOrCreateDaily` try `$ws` first, then `NULL`, so an existing user-level
  daily note is found. `workspaceId` leaves the request bodies.
- **Repair and foreign keys** (migration `0126_workspace_integrity.sql`), in
  order, in one file:
  1. For notes whose `workspace_id` names a missing workspace or a workspace
     owned by another user: when setting it to `NULL` would collide with the
     author's user-level note of the same slug
     (`notes_user_slug_uidx`, `0066_uneven_the_hand.sql:20-21`), rename the
     younger note's slug to `slug || '-' || left(id::text, 8)` first; then set
     `workspace_id = NULL`.
  2. The same reset (without slugs) for tasks, knowledge links, workspace repos
     and background jobs.
  3. Within each remaining workspace, rename younger duplicates of
     `(workspace_id, slug)` the same way, so S1's `notes_ws_slug_uidx` can be
     created.
  4. Add `REFERENCES workspaces(id) ON DELETE SET NULL` to those five tables.
- **One table list.** `WORKSPACE_TABLES` (`src/db/workspace-tables.ts`) lists
  every table with a `workspace_id` column and, per table, its action on
  transfer (`move` / `n/a`) and on space purge (`delete` / `n/a`, S1). A test
  reads `information_schema.columns` and fails when a `workspace_id` table is
  missing. Transfer moves every `move` table in one transaction, re-encrypting
  vault rows under the new owner; the backfill script uses the same list.
- **Vault.** `getByName` returns workspace rows by decrypting under the row's
  own scope and owner; the `workspace_id IS NULL` arm is removed for
  `scope='workspace'`.

**Tests:** a turn in a non-default workspace writes its task, artifact, files
and memories there; the TUI's workspace is honoured; daily capture does not
duplicate a user-level daily note; 0126 runs on a fixture with colliding and
foreign-stamped notes; transfer moves every `move` table; a transferred
workspace secret decrypts.

### 4.4 S0d — The web on the gateway

- The web opens one gateway connection per tab: `/auth/ws-ticket` → `auth`
  with `method: 'session_token'` (ticket) → subscribe. The chat page's handler
  (`web/app/chat/page.tsx:688-1157`), the permission context
  (`web/lib/permission-context.tsx:153-200`) and the recommended-models panel
  (`web/components/models/recommended-models-panel.tsx:94`) share that one
  connection.

  | Legacy frame | Gateway |
  |---|---|
  | `connected` | `auth_ok` |
  | `agent_event` (incl. `thought/text_delta`) | `chat.delta`, `agent.*` (event bridge) |
  | `turn_event`: `chat_response`, `status_update`, `approval_required`, `worker_*`, `team_*`, `pipeline_event` | `chat.response`, `rootAgent.status`, `agent.approval_required`, `agent.spawned/completed`, `team.*`, `pipeline.event` (already bridged, `event-bridge.ts:159-171`) |
  | `chat_error` | `chat.error` (new) |
  | `permission_request` | `permission.request`, `permission.resolved` |
  | `/ws/permissions` `pending_requests` | `permission.pending` (new snapshot, below) |
  | `/ws/permissions` `response_recorded`, `approval_resolved` | `permission.resolved`, `approval.resolved` (new) |
  | `swarm_event` | `swarm.*` |
  | `document_event` | `document.*` (new, user-stamped) |
  | `model_install_progress` | `model.install_progress` (new) |
  | `steer_result` | `chat.message {injected:true}`, or the `chat.send` fallback (`message-handler.ts:528-552`) |
  | `speak` | `voice.speak` (new) |
  | client `voice` | `voice.set` (new client message) |
  | client `chat`, `steer`, `approval_response`, `permission_response` | `chat.send`, `chat.steer`, `approval.respond`, `permission.respond` |

- **Pending snapshot.** On subscribing, a connection receives
  `permission.pending` with the user's open permission requests and root-agent
  approvals; live `permission.*` frames that arrive during hydration are queued
  and applied after it, as `/ws/permissions` does today
  (`websocket.ts:466-495`, `permission-context.tsx:168-200`).
- **In-app proactive delivery** (`resolveTarget → webChatChannel.sendToUser`,
  `src/channels/ownership.ts:183-190`) becomes a user-stamped `chat.message`
  gateway event.
- `chat.send` gains `workspaceId`; the server resolves and stamps it.
- Rate limits: chat messages keep their current buckets (`chat.send` 30/min,
  commands 60/min for `user` trust, per connection,
  `src/core/gateway/rate-limiter.ts:13-36`); room and document frames get their
  own buckets (§6.6, §7.3).
- Connections per user: `gateway.maxConnectionsPerUser` (default 20, today a
  constant 10, `connection-manager.ts:43-47`); a tab over the cap shows "Too
  many open tabs" instead of failing silently.
- `src/api/http/serve.ts` sets `maxPayload` to `gateway.maxFrameBytes`
  (default 256 KiB).
- Replay: a reconnecting tab sends `replay { sessionId, afterEventId }`; the
  hub serves `getReplay` after an ownership check. Buffers are pruned when a
  session is deleted or archived and capped per process
  (`gateway.replayMaxSessions`, default 500, LRU).
- Legacy `/ws` and `/ws/permissions` are removed with their tests; the browser
  extension's `/ws/browser-bridge` and `/voice` stay (separate clients, covered
  by the S0a choke points).
- Web: `api.setWorkspaceId(id)` runs synchronously inside `switchWorkspace`,
  then `queryClient.clear()`; query keys of workspace-scoped data include the
  workspace id. The dead `web/components/chat/chat-message.tsx` is removed.

**Tests:** Playwright specs that stub `/ws` move to stubbing `/gateway`
(`page.routeWebSocket(/\/gateway/)`); two tabs of one user both receive their
events; a tab opened after a permission request was raised shows it; a
workspace switch never fetches with the old header.

---

## 5. S1 — Shared spaces

Members create spaces, invite people and work on the same notes, tasks,
documents, artifacts and files — with the agent in their own private sessions
inside the space. No shared chat yet.

### 5.1 Schema (migration `0127_spaces.sql`)

Hand-written, idempotent (`DROP CONSTRAINT IF EXISTS` before each `ADD`),
statements separated by `--> statement-breakpoint`. New enum values are added
with `ALTER TYPE … ADD VALUE IF NOT EXISTS` and are not used by any migration in
the same release (drizzle runs pending files in one transaction).

```sql
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE workspaces ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_kind_chk;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_kind_chk CHECK (
  (kind = 'personal' AND user_id IS NOT NULL)
  OR (kind = 'shared' AND user_id IS NULL AND is_default = false));

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','commenter','viewer','guest')),
  scope        jsonb,                       -- guests only (S6)
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor','commenter','viewer','guest')),
  scope jsonb,
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 100),
  use_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One slug per workspace; 0126 (S0c) renamed legacy duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS notes_ws_slug_uidx ON notes(workspace_id, slug) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_links_ws_to_idx ON knowledge_links(workspace_id, to_type, to_id);
CREATE INDEX IF NOT EXISTS embeddings_ws_idx ON embeddings(workspace_id) WHERE workspace_id IS NOT NULL;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS workspace_id uuid;
CREATE INDEX IF NOT EXISTS audit_log_ws_created_idx ON audit_log(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS workspace_id uuid; -- exists; stamped from now on
ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS workspace_id uuid;

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_created';
-- … space_updated, space_archived, space_purged, space_member_added,
-- space_member_role_changed, space_member_removed, space_invite_created,
-- space_invite_revoked, space_invite_accepted, space_content_changed
```

The Drizzle schema files are updated by hand. `ensureDefaultWorkspace`,
`createWorkspace`'s slug check and `rename` only ever see personal rows because
spaces have `user_id NULL` (D2).

### 5.2 Roles (`src/security/space-access.ts`)

| Action | owner | editor | commenter | viewer | guest |
|---|---|---|---|---|---|
| `read` | ✓ | ✓ | ✓ | ✓ | ✓ in scope |
| `comment` (task comments, room posts) | ✓ | ✓ | ✓ | – | ✓ in scope |
| `write` (notes, tasks, files, documents, artifacts, space memory) | ✓ | ✓ | – | – | – |
| `run_agent` (read tools + comment tools) | ✓ | ✓ | ✓ | – | ✓ in scope |
| `run_agent_write` | ✓ | ✓ | – | – | – |
| `manage_members`, `manage_invites`, `manage_space` | ✓ | – | – | – | – |

The last owner cannot be removed, demoted or leave (`last_owner`).
`assertDeletable(userId)` (S0b) refuses a user who is the last owner of any
space, listing those spaces; no route deletes users today
(`userRepository.delete`, `src/db/repositories/user-repository.ts:63`, has no
production caller).

Room posts and space memory in the table apply from S2.

### 5.3 Space service, invites

**Service** (`src/core/spaces/service.ts`). Every function takes an actor
`{ userId }`, reads membership from the database and writes one audit row with
`workspace_id` (I10).

- `createSpace(actor, { name })` checks `spaces.creation` (D17) and inserts
  `workspaces(kind='shared', user_id=NULL, created_by=actor, slug=<random>)` and
  `workspace_members(role='owner')` in one transaction. A default room
  "General" is created with it from S2.
- `getMembership(userId, workspaceId) → { role, scope } | null` is the only
  membership read; the resolver, repos, `buildAgentContext`, `routeApprovalFor`
  and the gateway use it.
- `listSpaces(actor)`, `renameSpace`, `archiveSpace`, `unarchiveSpace` (owner).
  Archive stops every agent of the space and makes it read-only: reads allowed,
  no writes, no agent runs ("This space is archived").
- `listMembers` (any member; guests see only members of their rooms),
  `setRole`, `removeMember` (owner), `leaveSpace` (self). Removal and downgrade
  call `onMembershipChanged` (§5.9). `spaces.maxMembers` is enforced on add.

**Invites** (`src/core/spaces/invites.ts`).

- `createInvite(actor, workspaceId, { role, scope?, expiresInHours, maxUses })`
  (owner): `token = generateToken(32)`, store `sha256(token)`, clamp the expiry
  to `[1, spaces.inviteMaxTtlHours]`, return the raw token once. `owner` is not
  invitable.
- `previewInvite(token) → { spaceName, inviterName, role, expiresAt }` or 404;
  no member list, no content.
- `acceptInvite(actor, token)`: one statement `UPDATE workspace_invites SET
  use_count = use_count + 1 WHERE token_hash = $1 AND revoked_at IS NULL AND
  expires_at > now() AND use_count < max_uses RETURNING workspace_id, role,
  scope`, then insert the membership `ON CONFLICT DO NOTHING` (an existing member
  keeps their role and the use is refunded). Archived spaces reject.
- `revokeInvite(actor, workspaceId, inviteId)` updates `WHERE id = $2 AND
  workspace_id = $1` (unlike the share-link revoke, §1.9).
- `listInvites` (owner) never returns hashes.
- Delivery is a link (`${origin}/join/<token>`, copy button). The install has no
  mail transport (§1.9); sending from the inviter's connected mailbox is a later
  option.

### 5.4 Resolver and principal

- `Principal` gains `workspaceKind`, `spaceRole`, `spaceScope` (guests).
- `resolveWorkspace`: owned personal workspace → personal; shared workspace
  with membership → `{ workspaceKind:'shared', spaceRole }`; shared workspace
  without membership → `{ denied: true }`; anything else → default.
- A guard after `authGuard` answers 404 for `denied` on `/api` and `/v1`, except
  `/api/auth/*`, `/api/me/workspaces`, `GET /api/spaces` and `/api/health`, so a
  removed member's client can recover (`web/lib/auth-context.tsx:81-86` logs out
  on any `/auth/me` failure).
- **Which routes act on a space.** `SPACE_ROUTES` (one exported constant)
  lists the routes that act on the space when the header names one: notes,
  tasks (+comments), documents, artifacts (+pages), space files, knowledge
  (space scope), sessions (the member's private chats in the space), spaces,
  notifications; rooms and space memory from S2, documents hub from S3. Every
  other route is personal: when the header names a space, it runs with the
  caller's **default personal workspace** instead (the principal is rewritten
  before the handler), so a member viewing a space still answers approvals
  (`/api/chat/approve`, `web/lib/permission-context.tsx:96-100`), picks models
  (`/api/models`), searches and edits settings. Personal routes therefore never
  act on space rows, and the web needs no per-call header logic. A test
  classifies every mounted route, and a web test drives the app's own calls
  with a space selected.

### 5.5 Access layer (`src/db/repositories/space.ts`)

`spaceRepos(principal)` throws `SpaceAccessError('not_found')` unless the
principal is shared with a role. Every query filters `workspace_id = $space`
(plus the guest scope); writes stamp `workspace_id` authoritatively (ignoring
any `data.workspaceId`) and `user_id = author`, and check `can()`.

- **Tasks.** `ScopedTaskRepo` becomes `TaskRepo({ scope, stamp, can })`; every
  method uses the injected scope — including `listOwn` and `createdSince`, which
  today build their own owner filter (`scoped.ts:977,1000`) — and `create`
  ignores `data.workspaceId` (`:1047`). Comments in a space are written with the
  commenting member as `user_id`. Wakeups: `wakeupContext` uses the scope
  (`:1308`); wakeup events carry the woken task's `user_id`, and notifications
  go to that user (`wakeups.ts:282,320`); the role-heartbeat wake and the bridge
  look tasks up by scope, not by owner (`heartbeat.ts:970`,
  `wakeup-bridge.ts:172,207`).
- **Notes and links.** `SpaceNoteRepo` with the `NoteRepository` method set.
  `NoteService` takes a `NoteScope` instead of `userId`. Link resolution
  (`resolveTo`, `resolveGhostRefs`, `countUnresolved`, suggestions; 
  `knowledge-link-repository.ts:217-256`, `notes.ts:142-155`,
  `link-resolver.ts:208`, `suggestions.ts:51`) runs inside one scope: personal
  links never bind to space notes and the reverse. Vault export/import
  (`sync_vault`) is personal-only.
- **Documents.** `SpaceDocumentRepo`; uploads go to
  `<workspace.documentsPath>/spaces/{id}/…`.
- **Artifacts.** In a space, `private` = creator only, enforced on REST. Public
  pages look up the artifact by the viewer's personal workspaces **and**
  memberships. Data sources attached to space artifacts refresh only while
  their principal is a member with `write`; otherwise they pause. Attaching a
  source whose tool taints `private` is an I6 write (ASK).
- **Files.** `WorkspaceFS.forSpace(workspaceId)` roots at
  `<workspace.rootPath>/spaces/{id}/files`. `forAgent(context)` and
  `forSession(session)` return it for shared workspaces; extra prefixes
  (`/tmp/assistant-`, `workspace.additionalPaths`, `workspace-fs.ts:178-185`) are
  not allowed in space contexts.
- **Knowledge.** `KnowledgeScope { kind:'space' }`; space notes, documents,
  files and research are indexed with the space workspace id.
- **Raw readers** (§1.2) each get the personal predicate
  `notInSharedWorkspace(col)` or move to a repo. The isolation suite greps for
  `.from(<content table>)` outside allowlisted files.
- **Admins.** The session and message repos' admin bypass
  (`scoped.ts:139,253-255`) never reaches a session whose workspace is shared;
  `listAllAdmin` excludes them; admins reach spaces through membership or
  audited impersonation.

### 5.6 The agent inside a space

- **One place builds agent contexts.** `buildAgentContext({ session, userId,
  trigger })` in `src/core/agent/context.ts` resolves the workspace,
  membership, role and `space`, sets `funding = fundingFor(...)`, and fails
  closed. Every spawner uses it; `SpawnOptions` gains `space`, `trigger`,
  `funding`. Children inherit all three from their parent.

  | Spawn site | `trigger` |
  |---|---|
  | web, TUI, channel DM turns (`handleMessageInner`) | `user` |
  | REST `/api/chat`, openai-compat, `POST /api/agents` (`agents.ts:249-255`) | `user` |
  | room turns (S2), group-channel mentions | `room` |
  | voice and telephony turns | `user` |
  | pipelines (`routes/pipelines.ts`, `pipeline-manager.ts`) | the trigger of the session that started them |
  | hook actions, recurring tasks (`hooks/actions.ts:407,430`, `cron-runner.ts`) | `schedule` |
  | heartbeat and role turns, task wakeups (`heartbeat.ts`, `wakeups.ts`) | `schedule` |
  | monitor probes and wake-ups (`monitors/service.ts:86,110`) | `monitor` |
  | group / room listen and proactive probes (`group-listen.ts`) | `listen` |
  | background jobs (research, document, learning) | `schedule` |
  | swarm and worker children (`swarm/spawner.ts:1599`, `worker-spawner.ts`) | inherited |
  | visitors' requests (S7) | `remote` |

  Hand-built contexts move into `buildAgentContext` too: `POST /api/pipelines`
  (`routes/pipelines.ts:172-185`), `pipeline-manager.ts:1771,2461`,
  `hooks/actions.ts:646`, the monitor probe (`monitors/service.ts:86`). A test
  fails on `: AgentContext = {` outside `context.ts`.

  `fundingFor` returns `own` for every trigger until S5 (§9.1). In a space,
  `schedule` and `monitor` have no producer (the tools are personal-only, below);
  `listen` arrives with room modes in S5.
- **Tools.** Each content tool gets `reposFor(context)` returning
  `contentRepos(agentPrincipal(context))`; the call sites to rewrite are
  `notes/index.ts:65,98,100,106,129,147,248,261,289,337`,
  `documents/index.ts:64,66,100,133`, `knowledge/index.ts:163-169,234`,
  `artifacts/index.ts` (14 sites), `tasks/index.ts:299-311`.
- **Personal-only tools** are not offered in space sessions: scheduling
  (`create_hook`, `src/tools/scheduling/index.ts:100`), monitors, pipelines,
  research persistence, memory tools, `sync_vault`, `index_file`, personal
  connectors' write actions. The agent is told why.
- **One decision function (I4, I6, D5).** `routeApprovalFor(context, call,
  permission)` (async) replaces the bare `routeApproval` at all six callers
  (§1.7): (1) for a space context it re-reads membership and role; (2) applies
  the role cap **before** anything else, because `routeApproval` returns
  `execute` for any non-ASK level first (`approval-policy.ts:97-102`); (3)
  applies the space write rule of I6 (below); (4) calls the pure
  `routeApproval`. A lint test bans `routeApproval(` outside this function.
  "Allowed for commenter" is an explicit per-tool list `COMMENTER_TOOLS` (read
  and search tools, `*_read` actions as in `flow-guard.ts:138`, task comments,
  room posts from S2), not `isReadOnlyAction`. `stripMutatingTools`
  (`root-runner.ts:281`) also runs for commenters.
- **CLI models in spaces.** Native CLI tools must not bypass the cap:
  Claude Code runs with its stdio permission tool, which routes every native
  call through `cli-permissions.ts` and therefore `routeApprovalFor`
  (`cli-adapters.ts:674`); Codex runs with the `read-only` sandbox and
  Antigravity with `--mode plan` in every space session
  (`cli-adapters.ts:716-720,783-811`), so their writes can only happen through
  Octipus tools. Commenters' turns use API models only. Each adapter has a test.
- **Memories (I7).** `sessionAudience(session) → { shared, personalMemoryOff,
  kind: 'personal' | 'group' | 'space' | 'room' }` in `src/core/agent/audience.ts`
  replaces the derivation at `service.ts:317`; its uses at
  `service.ts:321,329-330,392,472,510,624,650,753`, `session-compaction.ts:205`,
  `learning/processor.ts:36` and the child-worker memory load
  (`worker-spawner.ts:693-699`) read it. The group-context and taken-task
  branches (`service.ts:329-330`) run only for `kind:'group'`; rooms use
  `room-context.ts` (§6.4); the `/command` gate (`:392`) applies to `group` and
  `room`.
- **I6 rule.** Inside `routeApprovalFor`, so it covers every dispatch path: in
  a space session whose flow label has `private`, a write into space content
  (notes, tasks, documents, artifacts, files under the space root, space memory)
  is ASK even when the flow-guard mode is `off`. The prompt says "writes data
  from your personal sources into <space>". The space id comes from the
  context; `applyFlowGuard` keeps its current role.
- **Personal profiles stay out.** `sessionAudience` also returns
  `personalProfileOff`; the requester's profile facts and relationship search
  are not injected into space sessions (`worker-spawner.ts:568-605`,
  `direct-response.ts:121-130`).
- **Approvals.** `PermissionManager.request` stamps
  `permission_requests.workspace_id` from `context.workspaceId`. Requests are
  answered by their requester (S0a); the admin resolve route refuses requests of
  a space the admin is not a member of (D9).

### 5.7 Routes (`src/api/routes/spaces.ts`)

Authenticated, TypeBox bodies with `additionalProperties: false`, typed
`SpaceError` → status (`invalid_*` 400; `not_found` 404, also for non-members;
`forbidden_role` 403 for members lacking the role; `last_owner`, `space_full`,
`archived` 409).

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/spaces` | any user | my spaces with my role |
| POST | `/api/spaces` | per `spaces.creation` | `{name}` |
| GET | `/api/spaces/:id` | member | name, my role, member count, archived, funding |
| PATCH | `/api/spaces/:id` | owner | `{name}` |
| POST | `/api/spaces/:id/archive`, `/unarchive` | owner | |
| DELETE | `/api/spaces/:id` | owner | purge (§5.8); only archived at least `spaces.purgeAfterArchiveDays` |
| GET | `/api/spaces/:id/members` | member | `{userId, username, role, joinedAt}` |
| PATCH | `/api/spaces/:id/members/:userId` | owner | `{role, scope?}` |
| DELETE | `/api/spaces/:id/members/:userId` | owner, or self | |
| GET | `/api/spaces/:id/invites` | owner | no hashes |
| POST | `/api/spaces/:id/invites` | owner | `{role, scope?, expiresInHours?, maxUses?}` → `{id, token, expiresAt}` |
| DELETE | `/api/spaces/:id/invites/:inviteId` | owner | scoped to the space |
| GET | `/api/invites/:token` | public | exact method-and-path entry in `auth-guard.ts` (its list matches by prefix and ignores the method, `auth-guard.ts:3,42`); rate-limited as a credential attempt (`rate-limit.ts:32-39`) |
| POST | `/api/invites/:token/accept` | signed in | checks auth itself, since the guard's prefix match would otherwise let it through |
| GET | `/api/spaces/:id/activity` | member | audit rows with this `workspace_id`, newest first, paged |

### 5.8 Purge (I9, D15)

- Only `purgeSpace(actor, id)` deletes a shared workspace, and only one that has
  been archived for `spaces.purgeAfterArchiveDays` (no writes and no agent runs
  since, so nothing races the purge).
- In one transaction it deletes, for every `WORKSPACE_TABLES` entry whose purge
  action is `delete`, the rows with `workspace_id = $id` (artifacts, whose
  foreign key cascades today, included explicitly), plus rows keyed by the
  space's sessions without a cascading key (`agents`, `tool_actions`,
  `run_events`); then it counts rows with `workspace_id = $id` in every
  `workspace_id` table (from `information_schema`) and aborts if any remain;
  then it deletes the workspace row. After commit it removes
  `<workspace.rootPath>/spaces/{id}` and `<workspace.documentsPath>/spaces/{id}`,
  with a retry sweep for failures.
- A personal workspace delete (`orgs.ts:434-448`) refuses shared workspaces and
  otherwise keeps today's `SET NULL` behaviour.

### 5.9 Membership changes (I5)

`onMembershipChanged(workspaceId, userId)`: bumps the in-process membership
version (D5), stops that user's agents and queued room turns in the space,
expires their pending requests there, unsubscribes their sockets from the
space's rooms, documents and presence, pauses data sources they own in the
space. Archive calls `stopSpaceAgents(workspaceId)`. (Room, document and presence
subscriptions exist from S2/S3; until then the function stops agents, expires
requests and pauses data sources.)

### 5.10 Web

- **Picker** (`web/components/workspace-picker.tsx`): "My workspaces" and
  "Shared spaces" (from `/api/spaces`) with role badges; "New shared space";
  transfer hidden for spaces; switching sends the id (S0d).
- **Space settings** `/spaces/:id/settings`: name, members (role, remove),
  invites (role, expiry, copy link, revoke), activity, archive, purge. Owner-only
  controls hidden for others.
- **Join page** `/join/:token`: preview, then Join, or Sign in / Register with
  `returnTo` (S0b).
- **Role-aware pages**: read-only notes editor, board without create/drag and
  no uploads for commenters and viewers; an archived banner.
- A removed member's next request gets 404; the workspace context switches to
  the default workspace and says "You no longer have access to <space>".

### 5.11 Tests

- `src/core/spaces/service.test.ts`, `invites.test.ts` (PGlite): roles, last
  owner, max members, archive; hash at rest, clamp, single use under two
  concurrent accepts, revoke scoped to its space.
- `src/api/routes/spaces.isolation.test.ts`: a third user gets 404 on every
  route; viewer cannot write; editor cannot manage members; the real auth and
  workspace derives are mounted (the existing pattern skips them,
  `src/api/routes/orgs.isolation.test.ts:61-74`).
- `src/db/repositories/space.isolation.test.ts`: I2 for every content table
  through personal repos, singleton repos, raw readers, knowledge search, global
  search and admin bypasses — grep-driven for raw reads.
- `src/api/space-routes.test.ts`: every mounted route is classified in or out of
  `SPACE_ROUTES`.
- `src/core/agent/space-turn.test.ts`: every spawner goes through
  `buildAgentContext` (a viewer cannot run an agent via `POST /api/agents`);
  role cap on all six approval paths and for a CLI model; personal memories not
  loaded, child workers included; I6 asks with the flow guard `off`; removed
  member's running turn stops and next turn fails.
- `src/core/tasks/space-wakeups.test.ts`: closing a blocker wakes and notifies
  another member's dependent task.
- `src/core/knowledge/space-links.test.ts`: link resolution never crosses
  personal and space scopes.
- `src/core/spaces/purge.test.ts`: purge after a real agent turn in the space
  leaves no row in any `workspace_id` table; a row in an unlisted table makes
  purge abort; files are removed; a personal workspace delete still sets
  `NULL`; `assertDeletable` refuses the last owner.
- I6 on the base-tool and MCP paths; personal profiles absent from a space turn;
  CLI adapters in spaces (Claude permission tool, Codex read-only, Antigravity
  plan); no `knowledge` chunk of a space has a NULL `workspace_id`.
- Playwright `tests/web/spaces.spec.ts`: create, invite link, join with
  returnTo, role-aware editor, removed-member redirect.

---

## 6. S2 — Rooms

Two PRs: rooms backend, rooms web.

### 6.1 Schema (migration `0128_rooms.sql`)

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat';
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_kind_chk;
ALTER TABLE sessions ADD CONSTRAINT sessions_kind_chk CHECK (kind IN ('chat','room'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS room_visibility text;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_room_visibility_chk;
ALTER TABLE sessions ADD CONSTRAINT sessions_room_visibility_chk
  CHECK ((kind = 'room') = (room_visibility IS NOT NULL)
         AND (room_visibility IS NULL OR room_visibility IN ('space','private')));

CREATE TABLE IF NOT EXISTS room_members (          -- access to private rooms only
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
CREATE TABLE IF NOT EXISTS room_reads (            -- read state and mute, any room
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id uuid,
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, user_id)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE cost_log ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE cost_log ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'own';
ALTER TABLE cost_log DROP CONSTRAINT IF EXISTS cost_log_funding_chk;
ALTER TABLE cost_log ADD CONSTRAINT cost_log_funding_chk CHECK (funding IN ('own','sponsor','install'));
CREATE INDEX IF NOT EXISTS cost_log_ws_funding_idx ON cost_log(workspace_id, funding, created_at) WHERE workspace_id IS NOT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'own';

CREATE TABLE IF NOT EXISTS space_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) <= 500),
  author_kind text NOT NULL CHECK (author_kind IN ('member','agent')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,  -- the member, or the requester the agent acted for
  session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  retracted_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS space_memory_ws_idx ON space_memory(workspace_id, created_at DESC) WHERE retracted_at IS NULL;
```

Rooms are created `pinned = true` (exempt from sweeps). `kind` is the only
room discriminator; `channelType: 'room'` is rejected on personal create and
resolve paths (`sessions.ts:227`, `session-resolver.ts:56-58`).

### 6.2 Access and entry

- `roomAccess(userId, roomId) → { space, role, room } | null` (membership, plus
  `room_members` for private rooms).
- **Rooms are invisible to personal paths**: `ScopedSessionRepo` and
  `sessionRepository.findByUserAndChannel/listByUser` add `kind = 'chat'`; every
  personal route, `/api/chat`, swarm, model usage, skills usage and gateway
  `chat.send` answer 404 for rooms, the creator included. `resolveSession`
  refuses rooms.
- **One helper replaces inline owner checks**: `canActInSession(session,
  userId, action)` with the room rules below, used at every site in §1.5. A test
  fails on new inline `session.userId !==` comparisons.

  | Action | Personal chat | Room |
  |---|---|---|
  | post | owner | `can(role,'comment')` |
  | start a turn | owner | `can(role,'run_agent')`, addressed |
  | `/stop` | owner | the running turn's requester, or editor+ |
  | `/status`, `/help`, `/cancel` | owner | any member (status without other members' details) |
  | `/clear`, title, visibility | owner | room creator or space owner |
  | `/model` | owner | refused (model choice is per requester, S4) |
  | plan tools, scripts, test containers, progress rows | owner | the turn's requester, within the role cap |
  | monitors, scheduling | owner | not offered (personal-only tools, §5.6) |
  | learning, voice | owner | refused in rooms |

- **Entry.** Only `handleRoomMessage(roomId, requesterId, postedMessageId)`,
  called by the `room.post` gateway message and its REST fallback, starts room
  turns.

### 6.3 Posting, addressing, ordering

- A member's post is stored once (`role='user'`, `author_user_id`) and
  broadcast; a turn starts only when addressed (`@octipus` or the composer
  toggle). Room frames are serialized per connection; order is the server
  `created_at`, with the client's `clientId` echoed for reconciliation.
- **Exactly one user row per post, structurally.** For `kind='room'` sessions,
  every message insert path (`create`, `createForGeneration`, the scoped
  `create`, `message-repository.ts:131-162`, `scoped.ts:326`) refuses a
  `role:'user'` row without `authorUserId`, and the posted message id is passed
  into the turn. The writers that today add a user row then skip it for rooms:
  `addUserMessage` (`agent-worker.ts:584-597`), the CLI worker
  (`cli-agent-worker.ts:360-372`), `direct-response.ts:151`, the command
  registry's `persistCommandExchange` (`commands/registry.ts:80,97,134,161`),
  the service's input-guard, plan "go", limit and voice paths
  (`service.ts:372,437,449,580,802`) and steer persistence
  (`message-handler.ts:74`). A test asserts the refusal.

### 6.4 The room turn

- **Context** from `buildAgentContext` (requester, space, role,
  `funding:'own'` until S5, `trigger:'room'`).
- **History for rooms.** `readSessionHistory(session)` returns, for rooms,
  `messages = [fenced block]` where the block holds the checkpoint summary (if
  any) followed by the attributed transcript from `checkpoint.through` onward,
  and `rows` = the same rows with author names attached. It never includes the
  current request: each consumer appends it as today (`agent-worker.ts:584-588`,
  `direct-response.ts:155`). The transcript renderer (`src/core/rooms/room-context.ts`)
  names members by display name from `author_user_id`, assistant rows as
  `Octipus (you)`, uses a random-tag fence, and adds the notice that the
  requester is X and everyone sees the reply. Native conversation snapshots are
  neither read nor written for rooms (`agent-worker.ts:556,762-767`), and CLI
  session resume is disabled for rooms (`cli-agent-worker.ts:892-895` is then
  unreachable for rooms).
- **Compaction of rooms** has its own branch in `maybeCompactSession`: it
  renders the attributed rows itself (`session-compaction.ts:92-143` uses
  `history.rows`), triggers when the post-checkpoint transcript exceeds
  `rooms.transcriptWindowChars` (default 6,000) rather than by row count, so
  the window and the checkpoint never leave a gap, and receives
  `requesterId` through `MaybeCompactSessionOptions` (the requester of the turn
  that triggered it; `/compact` uses its caller). The summary call runs under
  `withProviderUsageContext({ funding: 'install' })`.
- **Flow labels.** At each room turn start, `private` and `secret` taints are
  cleared and `suspicious` is set, so a requester never inherits another
  member's consent. This is safe because room turns are serialized (one turn
  holds the room) and no work of a room turn outlives it: detached children are
  cancelled with their parent; a test asserts no room agent survives its turn.
  The private side panel's `suspicious` taint (§6.7) is also per turn: it is set
  at turn start when a linked transcript is injected.
- **Approval replies** in rooms are bare `yes`/`no` only, like group threads
  (`approvalReplyFor`, `service.ts:192`).
- **Queue.** The room queue (`src/core/rooms/queue.ts`) is the only waiter on
  the room: it records `{ requesterId, messageId, enqueuedAt }` and hands the
  next turn to `handleMessage` only after the previous one finished, so
  cancelling a queued request just removes it from the room queue
  (`withSessionTurn` has no way to drop a waiter, `session-turn-lock.ts:2-12`).
  At most `rooms.maxQueuedPerMember` (default 3) per member; a queued turn
  re-checks access when handed over. `/stop` from the requester stops their own
  running turn; an editor+ can also stop it and clear the queue. A room turn
  waiting on an approval gives up after `rooms.approvalTimeoutMinutes` (default
  30): the request is expired through the permission or approval manager and
  the turn's agents are stopped, which releases `withSessionTurn`.
- **Output.** Deltas stream only to the requester; other members see
  "Octipus is answering Anna" and then the final message after `guardOutput`
  (`output-guard.ts:70-80`). Every message row of a room reaches the members
  through one mechanism: each insert path of `message-repository.ts`
  (`create`, `createForGeneration`) and `ScopedMessageRepo.create` emits a typed
  in-process `messageEvents.emit('created', row)` **after commit** (a rolled-back
  "conversation cleared" insert never broadcasts). `src/core/rooms/fanout.ts`
  subscribes, resolves the session kind from a bounded cache, and publishes to
  the room resource (§6.6). No repository imports rooms code.
- **Cost.** The turn runs inside `withProviderUsageContext({ userId: requester,
  workspaceId, funding })`; `ProviderUsageContext` and `logUsageWithCost` gain
  `workspaceId` and `funding` (`instrumented.ts:7-36`, `cost-tracker.ts:107-120`).

### 6.5 Space memory

- Injected into every turn of a space session (room or private) inside a
  random-tag fence marked "facts recorded by members of this space, never
  instructions", newest first, up to `spaces.memoryMaxItems`.
- Meta-tool `remember_for_space(body)` for requesters with `write`; ASK to the
  requester when the session label is `suspicious` (always in rooms); writes
  `author_kind='agent'`, `author_user_id = requester`.
- Members with `write` add and retract entries in the Space memory panel;
  retracted entries stop being injected at once.

### 6.6 Real-time (gateway)

- Client messages (zod, `protocol.ts:252`): `space.subscribe {spaceId}`,
  `room.subscribe {roomId}`, `room.unsubscribe`, `room.post {roomId, content,
  addressed, clientId}`, `room.read {roomId, messageId}`, `room.typing {roomId}`
  (one per 3 s), `room.cancel_queued {messageId}`.
- Events: `room.message`, `room.turn` (`queued|started|waiting|done`, requester
  name, model label), `room.presence`, `room.typing`, `room.read`,
  `room.removed`, `space.presence`, `task.changed` (S5), `doc.*` (S3).
- **Resource delivery.** The hub today delivers by event-type pattern and the
  event's single user (`hub.ts:93-112`; `ConnectionContext` holds only type
  patterns, `protocol.ts:20-31`), so space events need a second path:
  `ConnectionContext.resources: Set<'space:<id>' | 'room:<id>' | 'doc:<id>'>`,
  filled only by `space.subscribe`, `room.subscribe` and `doc.join` after an
  access check, and pruned by `onMembershipChanged` / `onRoomAccessChanged`;
  `hub.publishToResource(resource, message)` sends through
  `connectionManager.broadcast` with a resource filter, outside the event bus
  and outside the S0a user rule. A test proves a second member receives a
  `room.message` while every other event still obeys the user rule.
- **Catch-up** after a reconnect is served from `messages` (paged by id) for
  rooms, not from the event bus replay.
- **Access checks per frame (D5).** Database membership read: `space.subscribe`,
  `room.subscribe`, `room.post`, `room.read`, `room.cancel_queued`, `doc.join`.
  In-process membership version: `room.typing`, `doc.update`, `doc.awareness`.
- `onRoomAccessChanged(roomId)` (private-room member removal, visibility
  change) does for the room what `onMembershipChanged` does for the space:
  prunes subscriptions, stops the removed member's running and queued turns
  there, expires their pending requests there.
- `space.presence` shows `where` (room or note) only when the recipient can
  access it (I3).
- Rate buckets: `room.post` 30/min, `room.typing` 20/min per connection.

### 6.7 Routes, mentions, side panel, web

**Routes** (`src/api/routes/rooms.ts`):

| Method | Path | Who |
|---|---|---|
| GET | `/api/spaces/:id/rooms` | member: rooms I can access, with unread counts |
| POST | `/api/spaces/:id/rooms` | editor+: `{title, visibility, memberIds?}` |
| GET | `/api/spaces/:id/rooms/:roomId/messages` | room access; paged, with authors |
| POST | `/api/spaces/:id/rooms/:roomId/messages` | `can(role,'comment')`; REST fallback for `room.post` |
| PATCH | `/api/spaces/:id/rooms/:roomId` | room creator or space owner: title, visibility (calls `onRoomAccessChanged`) |
| POST/DELETE | `/api/spaces/:id/rooms/:roomId/members/:userId` | private rooms: room creator or space owner (calls `onRoomAccessChanged`) |
| GET/POST/DELETE | `/api/spaces/:id/memory[/:entryId]` | read: member; write: `write` |

**Mentions.** `@username` of a room member notifies that member with type
`room_mention` through `notify(userId, type, title, body, metadata,
{ workspaceId })` — the service gains the workspace argument
(`src/core/notification-service.ts:19-25`) and the caller checks the target's
membership (the service checks nothing). Muted rooms do not notify.

**Private side panel.** "Ask privately" opens the member's private session in
the space with `context.linkedRoomId`. Its turns receive the linked room's
recent transcript in the room fence, set the `suspicious` taint, and re-check
`roomAccess(linkedRoomId)` every turn (no access → no transcript). Answers stay
private.

**Web.** "Rooms" section with unread badges; the room view reuses
`message-timeline.tsx` with `ChatMessageData.author` (others left-aligned with
name and initials, mine right, `message-timeline.tsx:42-50,248-261`); composer
with "Ask Octipus" toggle and `@` completion; turn strip ("Octipus — answering
Anna", queued requests with cancel for my own, "waiting for Anna to approve");
space memory and room members panels; "Ask privately".

### 6.8 Tests

Access (open vs private rooms, removed member, viewer cannot post); turn runs as
the requester with the requester's role cap; private read asks the requester
only; two members receive each other's posts and the final reply; a non-member's
`room.subscribe` is refused; removal sends `room.removed`; Playwright
`tests/web/rooms.spec.ts` with two browser contexts and an in-test relay between
their `routeWebSocket` handlers. Also: creator gets 404 on every personal route for a room;
every `readSessionHistory` consumer fences other members (agent, direct, CLI,
compaction); no duplicate user rows; flow labels reset between requesters;
voice and `/model` refused in rooms; deltas reach only the requester; every
assistant writer reaches a second member; private-room member removal ends
subscriptions and queued turns; presence hides private rooms; every room cost
row has `workspace_id` and `funding`.

---

## 7. S3 — Live documents

### 7.1 Dependencies

`yjs`, `y-protocols`, `y-codemirror.next` — justified in the PR (a CRDT is not
20 lines).

### 7.2 Schema (migration `0129_live_documents.sql`)

`note_revisions` with `authors uuid[]` (all members whose updates are in the
revision) and `on_behalf_of_user_id`; `note_edit_proposals` (named so it does not
clash with the existing link suggestions, `notes.ts:201-206`); `file_leases` with
normalized paths; `workspaces.agent_edit_mode`. Constraints follow the
DROP-IF-EXISTS pattern.

### 7.3 Document hub (`src/core/docs/hub.ts`)

- Gateway messages `doc.join`, `doc.update`, `doc.awareness`, `doc.leave`;
  `doc.sync {noteId, epoch, state}`. The **epoch** changes whenever the server
  rebuilds a doc from `notes.body`; a client with a different epoch discards its
  local doc and re-seeds, so a reconnect never duplicates text. Concurrent first
  joins share one init promise.
- Limits: note size `spaces.noteMaxBytes` (default 192 KiB, which keeps a full
  `doc.sync` inside `gateway.maxFrameBytes` = 256 KiB; a startup check fails if
  `noteMaxBytes` exceeds three quarters of `maxFrameBytes`); `doc.update` at most
  `spaces.docMaxUpdatesPerSecond` (30) and `doc.awareness` at most 10/s per
  connection. Updates check the membership version (D5).
- **Every note writer goes through the hub** when the note is open:
  `NoteService` mutations (save, capture, archive, meeting notes) call
  `hub.applyExternal(noteId, baseSha256, next, origin)`. The hub keeps, per open
  doc, a bounded ring of `sha256 → text` for every state it has applied
  (last 200 states or 30 minutes). It looks up the base text, runs a three-way
  merge `diff3(base, current, next)`, and on a clean merge applies
  `diff(current → merged)` to the `Y.Text` in one transaction with the writer
  as origin; on a conflict or an unknown base the write is refused as stale
  (REST 409, tool error). Concurrent edits are therefore never reverted.
  Surrogate pairs are kept intact at cut points. `read_note` and `GET` return
  the hub's live text and its sha while the note is open, so writers always hold
  a base the ring knows.
- **Open/closed races.** One per-note in-process mutex covers the hub's init
  and persist and every closed-note write. A closed-note write is one
  conditional `UPDATE … WHERE sha256(body) = $base RETURNING`; the hub's persist
  is conditional on the sha it last loaded or persisted and reloads on mismatch.
- **Persist** body and a revision after `spaces.docPersistDebounceMs` idle and
  on last leave; links and the knowledge index are refreshed on last leave or at
  most every `spaces.docReindexMinutes` (10), billed `funding:'install'` to the
  space's last editor.

### 7.4 The agent as co-editor

`agent_edit_mode='suggest'` (default): the notes tool's writes in a space create
or update this session's pending `note_edit_proposals` row and return
`{ proposed: true, proposalId, status: 'pending', baseSha256 }`; `read_note`
shows the session's pending proposal. Capture, meeting notes and archive in a
space are proposals too. Accepting applies through the hub if the base still
matches, else the proposal is `stale` with a three-way view.

### 7.5 File leases

Paths are normalized relative to the space root. Leases are checked by every
`FILE_CHANGE_TOOLS` member (`tool-executor.ts:53-61`) with prefix matching for
directory operations (recursive delete, move of a parent). Shell, git, docker,
skill scripts and CLI agents are advisory only — documented. Compare-and-write
for space files runs under an in-process per-path mutex; the lease is the
human-facing signal, the mutex is the guarantee.

### 7.6 Presence, web, tests

- **Presence:** `space.presence` (§6.6), filtered per recipient; avatar stack
  in the space header, cursors and selections through `yCollab` awareness,
  "Ben is editing" on files.
- **Web:** space notes switch the editor (`markdown-codemirror.tsx:299-316`)
  from the controlled `value` to `yCollab(ytext, awareness)`; wikilink and tag
  completion stay; explicit save gives way to a "Saved" indicator; history
  panel (revisions with authors and on-behalf-of, restore as a new revision);
  edit proposals panel with diff, accept, reject.
- **Tests:** `src/core/docs/hub.test.ts` (two clients converge; reconnect with
  stale state does not duplicate; external writers — save, capture, archive,
  meeting notes — merge or are refused as stale, never revert; commenter update
  refused; rate and size caps); `edit-proposals.test.ts` (suggest mode, accept,
  stale); `file-leases.test.ts` (acquire, renew, expire, directory operations,
  agent refused); Playwright `tests/web/live-notes.spec.ts` (two contexts
  converge).

---

## 8. S4 — Own models

### 8.1 Model identity

- `AgentContext.model` stays the `modelId` — providers, CLI tool configs
  (`getCLIToolConfig`, `cli-agent-worker.ts:151,495,737-739`,
  `gateway/commands.ts:162`), toolshim statistics (`agent-worker.ts:1356,2018`,
  `model-selector.ts:150,160`) and clients (`api/routes/agents.ts:187,270`) read
  it as such. A new `AgentContext.modelName` carries the row identity and is
  passed as `CompletionOptions.modelConfigName`; row re-lookups
  (`agent-worker.ts:2164`, `agent-manager.ts:196`, `providers/index.ts:198`,
  `litellm-client.ts:449`, `custom/base-custom-provider.ts:50`) use
  `getModel(modelName)`. Remaining `getModelByModelId` callers pass `{ userId }`
  and filter `owner_user_id IS NULL OR owner_user_id = $user`; personal rows
  never enter global caches.
- **Pricing.** `cost-tracker.ts:95-101`, when it must look up by `modelId`
  without an owner, considers only `owner_user_id IS NULL` rows, so a personal
  duplicate never turns install calls into unknown cost. Direct `complete()`
  callers (research, telephony, compaction, memory, link resolver, evaluators)
  pass `modelConfigName` from the row they resolved; a test greps for registry
  rows used without it.
- Migration `0130_personal_models.sql`: `model_config.owner_user_id` (FK users,
  cascade); `user_model_bindings(user_id, topic, model_name)` for personal topic
  bindings (not `topicRoles`, which the admin topics route rewrites,
  `topics.ts:160-180`).
- Personal row names are `u/<userId>/<slug>` with slug `[a-z0-9-]{1,40}`; names
  are never parsed (ownership is the column). Router code that treats unknown
  `/`-names as OpenRouter ids (`router.ts:129-135`) checks `owner_user_id` first.
- Every install-level registry query adds `owner_user_id IS NULL`
  (`model-registry.ts:95-222`, `getAllModels`, `getModelsByProvider`), so
  personal rows never become defaults, topic models or fallbacks for others.
  Admin model and topic routes refuse personal rows. User-facing lists
  (`/model list`, `/models`, `GET /api/models`, openai-compat `/models`) use
  `getModelsForUser(userId)`, which returns install/org rows visible to the user
  plus the user's own personal rows.

### 8.2 Resolution

`resolveModel({ userId, topic, kind, inSpace })` is used by every request path:
`ModelSelector` (incl. `:24-45,164-166,241-249`), `router.route`, worker backup
(`worker-spawner.ts:1351`), swarm spawner (`:1183,2285,2311,2341`), escalate
tool, pipeline manager (`:485,524,538`), research, reader, email `everyday`,
voice reply, `/plan`, `POST /api/agents` and `/route`, evaluations, CLI agent
factory. Order: personal binding → install/org models visible to the user →
default. Personal rows may bind only `kind:'text'` topics
(`src/models/topics.ts:26,61-71`). Install-level topics stay install-level and
are funded `install`: `background` (memory extractor and judge, learning,
toolshim, link resolver, weekly review, chunk summarizer, evaluators),
`decision`, `embedding`, `vision`, `ocr`, compaction, the group-listen probe.
The `/model` override is keyed by `(sessionId, userId)`.

Explicit model choices go through `resolveModel({ userId, name })`, which
accepts a name only when the row is visible to that user (install/org rules, or
`owner_user_id = userId`): `POST /api/agents` (`model`), `POST /api/agents/route`
(`preferredModel`, `router.ts:117-135`), `/model <id>`, pipeline stage models
(`pipeline-manager.ts:485,524`) and swarm overrides (`swarm/spawner.ts:2285`).
A test covers each site with another user's personal model name.

### 8.3 Keys

One helper `resolveModelKey(row)` resolves under `row.owner_user_id ?? 'system'`
and is used by `applyModelOverrides`, the agent worker and the custom providers
(replacing resolution under the requester). Providers that back personal rows
honour `options.apiKey` before env: anthropic, openai, deepseek, gemini, grok,
mistral, moonshot, openrouter, zai, and the custom providers. Vertex, voyage
and typesafe cannot back personal rows.

### 8.4 Safety of user-supplied model rows

`/api/me/models` builds rows from an allowlist: provider, model id, label,
endpoint (custom providers only; the address is resolved and checked against
private, loopback and link-local ranges on **every request**, the connection is
pinned to the checked address, and redirects are not followed),
key or CLI token, topic bindings. No `cliAgent.inheritApiKeys`, `extraArgs`,
`mcpConfigPath`, `permissionMode` or `extraHeaders`.

### 8.5 CLI logins per user

`cliEnvFor(owner)` is the only env builder for the three spawn sites (§1.8):
per-user `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME` under
`<workspace.rootPath>/users/{id}/cli-home`, the user's own token injected, every
server auth variable stripped for personal rows. The credential owner is part of
the CLI session store key and the resume fingerprint
(`cli-agent-worker.ts:886-890`) and of quota keys (`quota-tracker.ts:33`, and
the agent worker path). Same-OS-user isolation limits are documented. Install
CLI models in spaces follow D14.

### 8.6 Tests

Same `modelId` on a personal and an install row never swaps rows between users;
personal rows never appear in install lists, defaults or topic routing; admin
routes refuse them; key resolved under the row owner for every provider; CLI
env per owner at all three sites; resume never crosses owners; endpoint SSRF
refusal.

---

## 9. S5 — Sponsor, team surface, bridge, space connectors

### 9.1 Funding

- Migration `0131_space_funding.sql`: `workspaces.agent_funding`
  (`own|unattended|sponsored`, default `unattended`), `sponsor_user_id`
  (`ON DELETE SET NULL`), `sponsor_models jsonb`; spend scopes `space`,
  `space_member`.
- `fundingFor({ space, trigger, requesterId })` (introduced in S1, §5.6) now
  returns `sponsor` where the table says so. Outside a space it is always `own`.

  | `agent_funding` | `user`, `room` | `listen` | `remote` (S7) |
  |---|---|---|---|
  | `own` | own | off | off |
  | `unattended` | own | sponsor | sponsor |
  | `sponsored` | sponsor (member cap) | sponsor | sponsor |

  `schedule` and `monitor` have no producer inside a space (§5.6). `install` is
  not in the table: it is never an agent's funding (D13).
- **Where `install` is stamped.** Install-topic model calls run inside
  `withProviderUsageContext({ funding: 'install' })`, overriding the turn's
  funding they would otherwise inherit (`instrumented.ts:9-11` merges contexts):
  memory extractor and judge, learning, toolshim (`agent-worker.ts:1985`), link
  resolver, weekly review, chunk summarizer, evaluators, embeddings, document
  processor (`processor.ts:277,348,374,504,939,971`), decision models, compaction
  (`session-compaction.ts:115`, `context-compaction.ts:574`). A test asserts a
  sponsored turn's toolshim row is `install`.

- Removing or downgrading the sponsor clears `sponsor_user_id` and
  `sponsor_models` in the same transaction, pauses sponsored work and is
  audited.

### 9.2 Budgets and quotas

- `spendSince` gets a `space` branch (`workspace_id = $space AND funding =
  'sponsor'`, no user filter) and a `space_member` branch (plus `user_id`),
  computed per member without a shared `paused_at`: the member cap is checked
  statelessly from `cost_log`, and its once-per-period notices are stored in
  `space_member_notices(space, user, period, warned_at, paused_at)`.
- Space budgets are loaded by workspace (`spaceBudgetsOf(workspaceId)`), with a
  partial unique index `(scope_ref, period) WHERE scope_kind IN
  ('space','space_member')`. Owners write them through
  `PUT /api/spaces/:id/budget`. For these two kinds `spend_budgets.user_id`
  is the author only: nullable, `ON DELETE SET NULL`, so a budget survives its
  author's account.
- `SpendScope` gains `funding` and `spaceId`; all five `checkSpend` call sites
  (§1.8) and the group handler's `budgetPaused` pass them. Own turns check the
  requester's budgets; sponsored turns check the space budgets. Every agent
  spawn and iteration keeps a check (D13).
- Personal scopes (`user`, `role`, `workspace`) add `funding <> 'sponsor'` to
  `spendSince` (`spend-budgets.ts:198-216`), so spend a sponsor paid never pauses
  a member's own budget. `install` rows keep counting for the user they are
  attributed to, as today. A test asserts a sponsored turn never moves a
  personal budget.
- Token quota: `tokensPerDay` sums only `agents.funding = 'own'`
  (`quotas.ts:131-134`); concurrency counts all.

### 9.3 Team surface

- **My work:** `GET /api/me/work` — open tasks with `assignee_kind='user' AND
  assignee_ref = me` across my spaces and my personal workspace, grouped by
  space; web page "My work".
- **Assignment notifies** the assignee (`task_assigned`, membership checked,
  with `workspaceId`).
- **Live board:** `task.changed {taskId, workspaceId}` gateway events to the
  space's subscribers; the board refetches on them instead of polling.
- **Room modes:** `listen` and `proactive` for rooms, reusing the gate, quiet
  hours, caps and feedback of group channels (`src/channels/group-listen.ts`),
  `trigger:'listen'`, funded by the sponsor (§9.1).

### 9.4 Group-channel bridge

1. `group_channels.workspace_id` (nullable, shared spaces only) and
   `group_channel_rooms(group_channel_id, thread_id, session_id)`. Room sessions
   do not carry `group_channel_id`; the per-member unique index stays as it is.
   Binding closes the members' existing per-thread sessions for that channel.
2. Binding requires a space owner who is also the channel owner, and an explicit
   acknowledgement that everyone in the channel can read what the room shows;
   audited (I10).
3. `resolveGroupSession` returns the room for bound channels; turns run as the
   requester. Linked users who are not space members get a private hint and no
   turn. Unlinked people's posts stay platform-only context.
4. Taken tasks (`src/core/channels/taken-tasks.ts:82,109-110`,
   `src/channels/taken-task-notices.ts`) use the space repo, and the dedup id is
   per message, not per member.
5. The space budget replaces the channel budget for bound channels; unprompted
   posts use the sponsor and are off without one.

### 9.5 Space connectors

- Space secrets get their own vault scope: a new `vault_scope` value `'space'`
  (migration in S5, not used in the same batch), `workspace_id` required,
  `user_id` = the storing owner as author only. One derivation
  `dekForRow(row)` replaces the `(scope, userId)` calls in every decrypt path and
  in rotation (`vault.ts:126-127,296,304,318`, `scripts/rotate-master-key.ts:134`,
  `rotate-vault-keys.ts`): it uses `workspace_id` for `space` rows and
  `user_id` otherwise. Space secrets are read and written only through
  `space.ts` after a membership check. A rotation test includes a space secret.
- They are used only inside connector code (token getters, `runGh` with a new
  `opts.token`), **never** through `{{secret:}}` injection, so a turn cannot
  route them into a shell or HTTP call; `isVaultAuthenticated` never exempts
  them.
- Each space connector has its own connect, callback and refresh flow storing
  under the space (`oauth.ts:728-760`).
- The shell tool in a space session runs without the host's GitHub identity:
  `GH_TOKEN`, `GITHUB_TOKEN` and the `gh` config directory are stripped from
  its child env (`gh.ts:25` keeps them today via `GH_KEEP_ENV`).

### 9.6 Tests

Funding table per trigger; sponsor removal; per-member cap without cross-member
pause; space budget counts only sponsored rows; install background work never
refused; bridge acknowledgement and non-member hint; space secret unusable via
`{{secret:}}`.

---

## 10. S6 — Guests and registration modes

- `security.registration: 'open' | 'invite_only' | 'closed'` (default `open`).
  `invite_only` accepts registration only with a valid invite token, redeemed in
  the same transaction as user creation (register is made transactional; first
  user detection inside it). SAML, SCIM and admin creation are IdP- or
  admin-gated and exempt; the docs say so.
- Guest scope `{ rooms: uuid[], folders: string[] }` on the membership; every
  space repo and route applies it; guests see only members of their rooms.

---

## 11. S7 — Spaces across installs (contract)

Builds on the federation transport (identity, pairing, typed messages) of
`workroom-and-swarm-federation.md` §2.2–2.5, which does not exist yet.

- A space has one host. Visitors' requests run on their own install and models.
- Visitors act only through space operations (`space.watch`, `space.read`,
  `space.post`, `space.propose`, `space.task.op`, `space.doc.sync` scoped to an
  open note), each checked on the host against role and scope. They never cause
  a host tool run; host-side execution runs only on the host's sponsored agent.
- Nothing of the space is stored on the visitor's install; revocation closes
  live access within one heartbeat.

The member representation is fixed now: a visitor is a local `users` row with
`kind = 'remote'`, `remote_instance_id`, `remote_user_ref`, `email NULL`, and a
username in a reserved namespace (`<name>@<instance-fingerprint>`); a CHECK
and the validation of registration, SCIM and admin creation reject `@` in local
usernames, so no local user can take a visitor's name. Remote rows cannot sign
in: `SessionManager.create`, `ApiTokenManager`, impersonation, SAML JIT and
passkeys refuse them; admin user lists and SCIM exclude them; quotas and
budgets apply to the host-side work they trigger, which is always sponsored
(`trigger:'remote'`, §9.1). Each holds a normal `workspace_members` row and
role. The peer principal `peer:<id>` authenticates
the install; the host maps each `space.*` message to that visitor's user row.
`space.*` operations map to the federation's capability enum; file writes from
visitors are proposals only.

---

## 12. Cross-cutting

### 12.1 Config

| Key | Phase | Default |
|---|---|---|
| `security.trustedProxies` | S0a | `[]` |
| `gateway.maxFrameBytes`, `gateway.replayMaxSessions`, `gateway.maxConnectionsPerUser` | S0d | 262144, 500, 20 |
| `spaces.creation`, `spaces.maxMembers`, `spaces.inviteMaxTtlHours`, `spaces.purgeAfterArchiveDays` | S1 | `any_user`, 50, 720, 7 |
| `spaces.memoryMaxItems`, `rooms.maxQueuedPerMember`, `rooms.approvalTimeoutMinutes`, `rooms.transcriptWindowChars` | S2 | 50, 3, 30, 6000 |
| `spaces.noteMaxBytes`, `spaces.docMaxUpdatesPerSecond`, `spaces.docPersistDebounceMs`, `spaces.docReindexMinutes`, `spaces.fileLeaseTtlSeconds` | S3 | 192 KiB, 30, 2000, 10, 180 |
| `security.registration` | S6 | `open` |

`gateway`, `spaces` and `rooms` are new top-level config sections (the schema
today has `security`, `api`, `multiuser` and others, `config/schema.ts:593-650`),
each with schema, defaults, legacy loader and registry entries.
Each key lands in the PR that reads it (the dead-settings test enforces this),
with schema default, registry entry and env var; the legacy loader and defaults
agree with the schema (a test asserts it).

### 12.2 Migrations

`0125_knowledge_scope` (S0a), `0126_workspace_integrity` (S0c), `0127_spaces`
(S1), `0128_rooms` (S2), `0129_live_documents` (S3), `0130_personal_models` (S4),
`0131_space_funding` (S5), `0132_guests` (S6). Journal idx continues at 126 with
increasing `when`. Idempotent; constraints dropped before added; new enum values
unused within the same release.

### 12.3 CI per PR

`npm run typecheck`, `npm run lint`, `npm run catalog:check`, mcp-server build,
`npm run test -- --coverage`, `npx tsx scripts/coverage-check.ts` (50.1 / 51.7 /
0.5), `npx tsx scripts/audit-check.ts`, web `npx tsc --noEmit` and lint,
`npm run test:web` for UI phases, `npm run test:acceptance`.

### 12.4 Docs and slicing

`docs/SPACES.md` (new), MULTI-USER.md section per phase, CONFIGURATION.md,
CHANGELOG per PR (including the behaviour changes in §4.3). One phase per PR;
S0 is four PRs; S2 two. AGENT.md rule 5 is now followed (D11), so no house-rule
exception is needed.

---

## 13. Open questions

1. **RLS (D12).** Make database row security real as its own project before or
   after S1 (request-scoped transactions, app role, membership policies)?
   Proposal: after S2, as a separate plan.
2. **Space creation rights default** (`any_user` proposed).
3. **Org attachment** of spaces (not in S1–S6 proposed).
4. **Room history for new members**: full history of open rooms; private rooms
   from when added (proposed).
5. **Knowledge rows with no derivable owner** in 0125 become `install` rows
   visible to admins only (proposed) — or deleted and re-indexed?
