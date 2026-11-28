# What to take from T3 Code, Orca, OpenBot, OpenMausBot and Hermes Agent (2026-11)

Date: 2026-11-25, updated 2026-11-28
Status: planned, queued after the backend port to Rust. 0.8.0 is the last
Node.js release; this work starts on the Rust backend
([roadmap](../../ROADMAP.md#big-break-the-backend-moves-to-rust)). Nothing here is started.
File references (`src/...`) point to the Node.js backend as of 0.7.0. They move
with the port; the behaviour they describe remains the requirement.

Decided 2026-11-25:
- Codex moves to the app-server and Antigravity to ACP, through a generic ACP
  adapter.
- Claude subscription logins serve their owner only.
- Other subscription logins get an information bubble and documentation
  (section F).
Companion plan: [steering-v2-2026-11.md](steering-v2-2026-11.md).

We read the code of four projects that are close to Octipus, plus their most
reacted issues and public reviews: T3 Code (pingdotgg/t3code), Orca
(stablyai/orca), OpenBot (nightly-labs/openbot) and OpenMausBot
(milind-soni/OpenMausBot). All four drive vendor CLIs on the user's own
subscriptions. This plan keeps only what Octipus lacks or does worse, checked
against the Octipus code on 2026-11-25. Ideas that only one project has rank
lower than ideas several projects converged on. Section G adds Hermes Agent
(NousResearch), checked on 2026-11-28 for product direction and adoption.

## Licences

| Project | Licence | What we may do |
|---|---|---|
| T3 Code | MIT (plus trademark policy) | Reuse code with attribution |
| Orca | MIT | Reuse code with attribution |
| OpenMausBot | Apache-2.0; `enterprise/` is source-available | Reuse core code with NOTICE; never `enterprise/` |
| OpenBot | PolyForm Noncommercial | **Ideas only.** No code, no plugin catalog data |

## Rules for this plan

- Build on existing foundations (quota tracker, schedule `watch`, Companion
  reports and basis rules, inline UI, marketplace signing, presence reducer).
  No parallel systems.
- Honest status over optimistic status: a feature reports what actually
  happened (DESIGN.md).
- Anything that interrupts the user (overlay, desk pet, sound) is opt-in and
  dismissable.
- No automatic rotation between subscription accounts to dodge limits; it
  likely breaks provider terms.
- Each item lands as its own PR with tests and a review pass.

## Already in Octipus (no work needed)

Multi-repo projects (top request at Orca #1099 and T3 #1453), a headless
server with a web client (Orca #4280, #10687), Telegram/Teams/WhatsApp
channels (Orca users still ask), Tauri instead of Electron (Orca's memory and
GPU leaks #19831, #38108, #42961), Docker execution environments, explicit
send modes (`auto | queue | steer | restart`), and schedule gates for
url/file/tasks/inbox/github_prs (`src/hooks/schedule-watch.ts`).

---

## A. Cost and continuity

### A1. Wait for a usage-limit reset, then resume

Seen in: T3 `UsageLimitRecoveryWorker.ts`, Orca `bot-item-usage-limit-wait.ts`.

Exists: `src/models/quota-tracker.ts` stores `exhausted` and `resetsAt`;
`cli-agent-worker.ts` falls back to another provider when one is bound.

Change:
1. When a CLI run fails on a usage limit and no backup lane is bound (or the
   user turned fallback off for the session), record the session or Companion
   goal as `waiting_for_reset` with `resetsAt`.
2. Schedule a durable wake at `resetsAt` (+ small jitter) through the existing
   monitor/Companion scheduling; resume the same vendor session.
3. Companion reports "Resumed after the Claude limit reset" once, through the
   normal report gate. Without a known `resetsAt`, probe hourly, at most 24 times.
4. The session header shows "Waiting for the limit to reset at 14:05" with
   Resume now / Cancel.

Acceptance: a fake CLI that fails with a limit error and a reset time; the run
resumes after the reset without a user message; a restart in between keeps the
wait.

Effort: low–medium.

### A2. Compact idle sessions before the prompt cache expires

Seen in: T3 `IdleCompaction.ts`, OpenBot `cache-expiry-compaction.ts`.

Exists: `src/core/cli-compaction.ts`, `src/core/agent/session-compaction.ts`.

Change:
1. Measure first: log, per CLI session, idle gaps against the cache TTL
   (5 min API key, 1 h subscription) and context size. Decide from data whether
   it saves money for Octipus usage patterns.
2. If yes: when a session goes idle with context above a threshold (default
   100k tokens), arm a timer at ~90 % of the TTL; compact if still idle.
3. Record the estimated saving in spend budgets; setting per session and
   global (OpenBot #10521, #9309 ask for a per-agent threshold).

Effort: low.

### A3. Cheap gates before scheduled AI runs

Seen in: Orca `--precheck`, OpenMausBot proactive routines, OpenBot
`no_update` / `report_failure`.

Exists: schedule `watch` sources (url, file, tasks, inbox, github_prs);
Companion report gate.

Change:
1. New watch kind `command`: runs in the schedule's execution environment,
   non-zero exit records `skipped_precheck`, no tokens spent.
2. Tools for scheduled and Companion background runs: `no_update` (the run ends
   quietly, no unread count, no notification) and `report_failure` (the turn
   succeeded but the task did not; notify once per failure streak).
3. Backoff on consecutive failures (15 min → 4 h) and a per-day cap on model
   runs per schedule (default 24).
4. "A blip is no news": a degraded probe notifies only if it lasts 10 minutes.

Effort: low.

---

## B. Companion

### B1. Animated avatar

Seen in: OpenMausBot `CursorAvatar.tsx`, `mascot-motion.ts`, `mascot-clock.ts`,
vendored engine `packages/phone-protocol/src/open-bot-avatar/` (reported MIT,
verify before use).

Exists: `web/components/companion/companion-avatar.tsx` renders a static
image with a pulse; `data-state` is set; `followPointer` is accepted but unused.

Change:
1. Motion per presence state (working, waiting, done, interrupted, sleeping,
   idle) with spring motion and per-state blink timing.
2. One-shot beats on presence moments (done → celebrate, failed → alert,
   needs input → curious), 1.4 s over the current state.
3. Eyes follow the pointer when `followPointer` is set.
4. One shared animation clock that sleeps until the next blink and skips
   hidden tabs and off-screen avatars. Budget: idle CPU under 1 % (OpenMausBot
   #4116 measured 16 % without it). Respect `prefers-reduced-motion`.
5. Optional custom picture per state, falling back to the main one
   (OpenMausBot #7165, #4793).

Effort: medium.

### B2. Hold-to-talk quick-ask panel

Seen in: OpenMausBot `electron/talk-panel.mjs`, `talk-session.mjs`. Planned
as item 4 of [companion-presence](companion-presence.md).

Change: Tauri `global-shortcut`; a frameless, transparent, non-focusable
400 px window at the bottom centre of the display under the cursor. States:
Listening… → Sending… → Thinking… → reply preview (markdown stripped) /
"needs you · Open chat" / "Still working · Open chat" after 2 min. Hides after
12 s unless hovered; a click opens the conversation. Typed input when voice
is off. Speech uses a spoken register (no file paths read aloud).

Effort: medium.

### B3. Answer approvals from the companion surface, then the desk pet

Planned as items 1 and 6 of companion-presence. Seen in: OpenBot dynamic
island and agent dock, OpenMausBot tray "lending" indicator.

Change:
1. Tray menu lists pending approvals and Companion decisions with Approve /
   Deny / Open.
2. The quick-ask panel (B2) can show one pending approval.
3. Desk pet (opt-in, later): the B1 avatar in an always-on-top window; badge
   when waiting; sleeps in a corner when idle; hidden in full-screen apps; no
   window exists while hidden (OpenMausBot #6959).

Effort: medium.

### B4. Look-around suggestions

Seen in: Orca `bot-look-around-prompt.ts`, `bot-look-around-policy.ts`.

Exists: `src/hooks/suggestions.ts` is a static, integration-based list.

Change:
1. A read-only Companion sweep (existing `companion/tool-policy.ts`; read
   tools only, enforced at the tool layer) once or twice a day.
2. Output cards `{title, why, ask, link}`; `ask` is written as the owner's own
   request. Cards appear on Today and, if enabled, in linked chats.
3. Accepting sends `ask` as the owner's message, which satisfies the
   "Because you said" basis rule. Dismissed titles are stored and fed back
   ("never suggest again in any wording"); accepted ones as positive signal.
4. At most five cards per sweep, never posted empty.

Effort: low–medium.

### B5. Visible self-changes with Undo, and decision salvage

Seen in: OpenBot `instructions-changes.ts`, `memory-changes-message.ts`;
Orca `bot-memory-journal.ts`, `bot-memory-salvage.ts`.

Change:
1. When a turn changes memory, standing instructions, a persona or a skill, the
   transcript gets one line ("Remembered: …", "Updated its instructions") with
   View and Undo. Undo refuses if the item changed again since.
2. Code (not a model) writes a journal line for each closed Companion goal.
3. Consolidation never drops owner decisions: lines matching decided /
   approved / rejected that a prune would remove are kept or offered back word
   for word.

Effort: medium.

### B6. Small Companion improvements

- Away detection (Tauri idle and lock state): choose between a toast and the
  "while you were away" digest.
- The daily brief is one card edited in place, never empty, shown on the first
  open of the day or after 3 h away.
- Time-saved estimate per outcome kind (mail read, draft, report), always
  labelled as an estimate.

Effort: low each.

---

## C. Connectors and plugins

### C1. OAuth for remote MCP servers

Seen in: OpenBot (`docs/architecture/integrations.md`), Orca
(`bot-mcp-apps.ts`). OpenBot's biggest pain cluster is here (#8726, #5817,
#13492, #9184).

Exists: OAuth for Google and Microsoft (`src/api/routes/oauth.ts`);
streamable-HTTP MCP with static headers; a definition-driven connector OAuth
path with client registration was built and later removed
(`docs/plans/daily-driver-gaps.md:230`).

Change:
1. MCP authorization: 401 challenge → protected resource metadata (RFC 9728)
   → authorization server metadata (RFC 8414) → dynamic client registration →
   PKCE S256 → tokens encrypted in the vault, with refresh.
2. Manual client ID/secret fallback for servers without dynamic registration
   (OpenBot #6198).
3. Callback that works on localhost, LAN and behind a reverse proxy; clear
   error states ("redirect URI rejected", "registration refused").
4. Per-workspace connection, revocable from the Connections page.

Effort: medium.

### C2. Curated catalog of hosted MCP servers

Change: entries in the marketplace repository (PatriceA/octipus-plugins) with
vendor URL, auth kind, starter prompts and required scopes. A weekly CI job
probes each entry (401 challenge, metadata, registration). Built from vendors'
public documentation, not from OpenBot's catalog. Start with ~30 entries that
match the daily-driver and business-os needs.

Effort: medium (after C1).

### C3. Render MCP Apps in chat

Seen in: T3 `html-renders.md`, OpenBot.

Change: render `ui://` resources from the MCP Apps standard through the
existing inline UI frame. Network denied in the frame; every non-read-only
call from the app goes through the normal permission check.

Effort: medium.

### C4. Agent and team packages

Seen in: Orca `bot-package.ts`, `bot-text-scan.ts`; OpenMausBot team packages;
OpenBot agent templates.

Exists: signed skill bundles, persona YAML, plugin packages, marketplace
signing.

Change:
1. One package format: persona, role, skills, required connectors, schedules
   (shipped paused), and first-chat offers.
2. Export scan: secrets, invisible characters, risky setup commands; no
   memory, no credentials.
3. Install review screen listing every capability; connections start off.
4. Published through the marketplace with the existing signatures.

Effort: medium.

### C5. Secret references and a private request card

Seen in: T3 `packages/secret-provider-*`, `request_secret`.

Change: store `op://…` (1Password) or Bitwarden references instead of values
where the user prefers; a `request_secret` card in the web UI and channels lets
an agent ask for a key without the value entering the transcript.

Effort: medium.

### C6. Deep links and skill example prompts

Change:
1. `octipus://new?prompt=&role=&skill=&workspace=` (desktop) and the matching
   web URL. Never auto-run; strip zero-width and tag characters and say so.
2. Skills may declare `example-prompt:`; a "Try skill" button fills the draft.

Effort: low.

### C7. Smaller connector items

- ICS feed of schedules, goals and Today items (OpenBot routine feed).
- Discord and Mattermost channels (Orca #45757, #46844).
- Importers that run inside the other product and produce a zip (OpenClaw
  first).
- Generic ACP adapter: decided, see F3.

---

## D. UI and UX

### D1. "Needs you" inbox and session lifecycle

Seen in: T3 thread sidebar, Orca work items.

Change: sessions move between Active, Pinned, Snoozed and Settled. Auto-settle
after 7 days idle or when the linked PR merges. Optional settle actions per
project (clean worktrees, stop dev servers). One "Needs you" list (approvals,
questions, failed goals) shared by Today, the tray and the bell.

Effort: medium.

### D2. Review changes line by line

Seen in: Orca annotate-AI-diff.

Change: line comments on `diff-view.tsx` and documents; send them to the agent
as one batch. AI vs human line attribution later.

Effort: medium.

### D3. Smaller UI items

- Browser extension element picker: HTML, styles, selector and a screenshot
  into the chat.
- Claude and Codex plan-usage meters, tightest limit first, warning at 80 %
  (extend `src/core/cli-plan-usage.ts`, today zai and moonshot only).
- Side chat (`/btw`) that does not enter the main thread's future context.
- Large pastes (32 KiB or more) become attachments.

---

## E. Business

### E1. Optional hosted relay

All four monetize the same layer: hosted pieces a self-hosted app can't do
alone. OpenMausBot Cloud ($15/$49/$99 a month), OpenBot hosted servers, Orca
Cloud connector service, T3 Connect.

Proposal (needs an owner decision):
1. One shared official Telegram and Slack bot; a chat links with a one-use
   link, no BotFather or Slack app setup.
2. Web push for the PWA and phones.
3. A public webhook ingress for instances behind NAT.

Self-hosting without the relay stays fully functional. The relay sees as little
as possible (routing metadata; message bodies end to end where the platform
allows).

### E2. Team policy and managed policy file

Seen in: Orca team policy flags, T3 managed policy.

Change: an admin policy file that locks settings, caps the permission mode, and
can turn off bots, computer use, community plugins and the relay; `octi policy
check` validates it. Fits the "Octipus goes enterprise" track.

Effort: low–medium.

### E3. Guest links for sessions

Seen in: T3 guest links.

Change: a read-only link to one session, expiring after 24 h; a guest's
messages wait for the owner to send or dismiss. Useful for consultants and
agencies.

Effort: medium.

### E4. "Report a problem" from inside the app

Seen in: T3 triage, OpenBot feedback.

Change: Companion or a menu item drafts a GitHub issue with version, provider,
recent errors and redacted diagnostics; the user reviews and submits it.

Effort: low.

### E5. Trust as positioning

Complaints at all four: telemetry on by default (T3 #4123), full access by
default (OpenBot, Orca), "open source" claims under a noncommercial licence.
Check Octipus's defaults against each, then say so on octipus.cc.

---

## F. Agent runtimes and credentials (decided 2026-11-25)

Decisions:
- Codex moves to `codex app-server`.
- Antigravity moves to `agy acp`.
- A generic ACP adapter is built.
- A Claude subscription login serves only its owner.

### F1. SDKs give little; the vendors' interactive protocols give the most

What each option offers, from the vendors' docs and source as of 2026-11-25:

| Vendor | Today | Vendor SDK | Interactive protocol | Decision |
|---|---|---|---|---|
| Claude | `claude -p` stream-json | TS/Python Agent SDK, which bundles and spawns the same binary. Adds in-process MCP tools, callbacks and typed `interrupt`/`setModel`/`priority` | stream-json control requests (not formally documented) | Stay on the CLI (F6) |
| Codex | `codex exec` | `@openai/codex-sdk` (TS) spawns `codex exec`; nothing gained | `codex app-server`: `turn/steer`, `turn/interrupt`, approval requests, rate limits, ChatGPT login | App-server (F2) |
| Antigravity | `agy -p` stream-json, buffered | `google-antigravity` (Python, preview): API key or Vertex only, **no Google-account login** | `agy acp`: second `session/prompt` steers (≥1.5.0), `session/cancel`, `session/request_permission`, `oauth-personal` | ACP (F4) |
| Cursor, Copilot, OpenCode, Kimi, Cline, Devin… | not supported | assorted SDKs, mostly API-key auth | ACP | Generic ACP adapter (F3) |

Sources: code.claude.com Agent SDK, headless and legal pages; codex
`sdk/typescript/src/exec.ts`; learn.chatgpt.com app-server docs;
antigravity.google SDK, headless, ACP and FAQ pages; t3code
`AntigravityAcpSupport.ts`; openbot `acp-flavor-antigravity.ts`.

### F2. Codex through the app-server

Implementation lives in the steering plan, S3. This plan decides the
direction only: `codex exec` stays as a fallback until the acceptance
workflows pass, then it is removed. The TS Codex SDK is not used.

### F3. Generic ACP adapter

One adapter for agents that speak the Agent Client Protocol. Octipus is the
ACP client; the agent runs as a child process over stdio JSON-RPC.

Scope:
1. **Session lifecycle:**
   - `initialize`: capabilities, auth methods, the agent's `_meta`;
   - `authenticate`;
   - `session/new` with Octipus's scoped MCP server as the only MCP server;
   - `session/load` or `session/resume`;
   - `session/prompt`, `session/cancel`.
2. **Events:** map `session/update` (message chunks, thoughts, tool calls,
   plans, usage) onto the existing worker events. Activity is a structured
   stream, not buffered.
3. **Approvals:** `session/request_permission` enters Octipus approvals,
   like Claude's control requests. Unattended runs deny.
4. **Client capabilities:** Octipus does not offer `fs/*` or `terminal/*` to
   the agent. File and shell work goes through Octipus tools, so the locked
   mode for spaces and personal rows holds.
5. **Flavors.** Per-agent overrides live in a small table: auth methods,
   minimum and recommended versions, steering strategy (steering plan S10),
   compaction support, model listing and quirks. Start with Antigravity
   (F4), then Cursor (`cursor-agent acp`) and Copilot (`copilot --acp`), then
   OpenCode.
6. **Capabilities** are declared through the steering plan's S2 contract
   (`midTurn`, `steerAcceptsImages`, `readReceipts`…), never inferred from the
   agent's name.
7. **Runtime.** The agent's binary path is configurable per adapter, with a
   version check at start. Managed downloads are optional and later.
8. **Tests:** replay fixtures recorded from real agents, plus a fake ACP
   agent for unit tests.
9. **Library.** Use the official TypeScript ACP library if its licence fits;
   otherwise write a small JSON-RPC client.

Not in scope: Octipus as an ACP *agent* for editors (separate item if wanted).

Effort: medium–high.

### F4. Antigravity on ACP

Replaces the `agy -p` stream-json adapter.

1. Run `agy acp` with agy ≥1.5 (t3code recommends 1.5.12). Pass Octipus's
   instructions through the system-prompt append Antigravity reads from
   `_meta`.
2. Spike: can the private `octipus-managed` custom agent (no native tools, no
   subagents) still be selected under ACP? If not, deny native tool requests
   at `session/request_permission` and record that limit.
3. Steering: a second `session/prompt` on the running session (≥1.5.0),
   serialised; `midTurn: native` from 1.5.0, `none` below.
4. **Auth: offer both methods.**
   - The sign-in method picker offers the personal Google login
     (`oauth-personal`) and AI Studio or Gemini Enterprise / Vertex keys.
   - The personal login carries the information bubble from F7. Nothing is
     blocked.
5. Keep the current private HOME and settings isolation.
6. Remove the stream-json adapter once ACP passes the live opt-in test
   (`OCTIPUS_LIVE_CLI=antigravity`).

Effort: medium, on top of F3.

### F5. A Claude subscription login serves only its owner

Anthropic's legal page forbids routing requests through Free/Pro/Max/Ultra
credentials on behalf of other users, and forbids developers from
collecting, storing or intermediating Claude.ai credentials. It allows an end
user to sign in to the unmodified binary with their own subscription, also
where a platform hosts it.

**Rule:**
- A Claude subscription credential runs only turns requested by the account
  that owns it.
- This covers a Claude Code CLI login and a `CLAUDE_CODE_OAUTH_TOKEN`.
- An install with one user is unaffected.

**Rooms are unaffected:** each member's turn runs on that member's own model
and credentials. Verify that a room turn resolves the requester's model, never
the room creator's or the host's.

Which logins count:
- Any Claude Code login counts as a subscription unless the row explicitly
  supplies an API key (`sk-ant-api…`, `inheritApiKeys`, Bedrock, Vertex or
  Foundry).
- When unsure, apply the rule.
- GLM and Kimi rows use their own vendors' keys and are not affected.

Enforcement, at the place every CLI spawn already passes (the install-models
check in `agent-manager.ts` / `resolve-model.ts`):
1. **Install CLI rows record their owner.** That is the account whose login is
   in the install's config dir; the setup wizard sets it, or an admin picks it.
   A Claude subscription row with no owner is refused until one is set.
2. **Install-models flag:** other accounts with the flag on can no longer run
   on the owner's Claude subscription row; they get API rows only.
3. **`sharedUse: true`** is refused for Claude subscription rows. A migration
   turns it off and tells the admin why.
4. **Sponsored space turns and remote/federated turns** never run another
   person's request on the sponsor's Claude subscription.
5. **Group channels** (Telegram, Slack and Teams groups): a message from anyone
   other than the owner does not run on the owner's Claude subscription.
6. **Requests through the Octipus API** (`/v1`, `octipus_chat`, the MCP
   server) and future guest links run on it only with the owner's own token.
7. **Allowed:** the owner's own background work (Companion, hooks,
   schedules, monitors, webhooks the owner set up).

Refusals name the reason and the fix ("This Claude login belongs to Ana. Add
your own Claude login under Settings → My models, or pick an API model"). There
is never a silent fallback to another model.

UI and docs:
- The Models page and the personal-model form say "Your Claude login serves
  only you".
- CLI-AGENTS.md and SPACES.md get the rule and the legal page link.

Tests: one per enforcement point; single-user install unchanged; room turns
by two members each use their own row.

Effort: medium. Comes first in this section: it is a compliance fix.

### F7. Other subscription logins: inform, don't enforce

Decided 2026-11-25: only Claude logins are enforced (F5). Every other vendor
subscription login gets an information bubble in the UI and a section in the
documentation. That covers Codex with a ChatGPT login, Antigravity with a
Google login, Grok Build, Muse Code and Mistral Vibe.

The concern is one install serving several people, for example an Octipus
hosted for colleagues or a company. A private install where each person
signs in their own account is the low-risk case.

**Where the bubble appears:**
1. **On every subscription CLI row** (install and personal), a small ⓘ next
   to the login. One or two sentences plus a link to the docs section.
2. **More visibly when other accounts can use the row:**
   - the install-models flag is on for other accounts;
   - `sharedUse` is on;
   - the row serves a sponsor, a remote turn or a group chat.

   The notice is shown where an admin makes that choice, and on the Users
   page next to the install-models flag.
3. **In Antigravity's sign-in method picker**, next to the personal Google
   login (F4.4).

**Behaviour:**
- Dismissable per user and row; dismissal is remembered.
- It never blocks, never changes routing, and sends nothing anywhere.

Draft texts. These describe the providers' terms; they are not legal advice.
- **Generic:** "This model runs on a personal subscription login. Providers'
  terms usually cover your own use. If other people use this install, check
  the provider's terms first. → Subscription logins and provider terms"
- **Shared row:** "Other accounts on this install can run on this login.
  Subscription plans are usually for one person; sharing them can break the
  provider's terms and get the account suspended. Prefer an API key, or let
  each person add their own login under Settings → My models."
- **Antigravity personal login:** "Google's Antigravity FAQ says wrapping
  `agy` inside third-party applications is not supported under consumer
  plans. An AI Studio or Gemini Enterprise key avoids that question."

**Documentation:**
- New section "Subscription logins and provider terms" in `docs/CLI-AGENTS.md`.
- Linked from `docs/SPACES.md`, `docs/INSTALLATION.md` and the setup wizard's
  model step.

Contents of the section (written in our own words; OpenBot's page is a model
for structure only, its licence is noncommercial):

1. **Opening statement:** "Octipus does not sell, resell or pay for model
   usage. Each CLI signs in with your own account or key, and your agreement
   with that provider covers all use through Octipus. Octipus enforces one
   rule, that a Claude subscription serves only its owner. Beyond that it does
   not check whether your use fits a provider's terms. A provider can limit or
   close an account that breaks them. This page is not legal advice."
2. **Per vendor:**
   - how Octipus runs the CLI (unmodified binary, the vendor's own sign-in
     flow, where the credential stays);
   - what the provider says, quoted, with link and "read on" date;
   - what Octipus enforces.
3. **Risk by use**, one table for all vendors:

   | How the install is used | Risk with a personal subscription | What Octipus does |
   |---|---|---|
   | Only you, on your own machine or server | Low. You sign in to the unmodified CLI through the vendor's page. Antigravity: Google's FAQ says wrapping `agy` in third-party apps is not supported under consumer plans, whoever uses it | Information bubble only (Antigravity: its specific text) |
   | Private or family install, each person signs in their own account | Low. Each request uses its requester's own plan | Information bubble only |
   | Automations running for you (Companion, schedules, webhooks, many parallel agents) | Moderate. Plans assume ordinary individual use; heavy unattended use can exceed that | Information bubble; spend and turn limits apply as usual |
   | Others run on one person's login (install models, `sharedUse`, sponsor, group chat) | High. One person's plan serves other people's requests | Claude: refused (F5). Others: visible warning where the admin enables it |
   | Hosted for colleagues or a company | High with shared logins | Recommend API keys, or each person their own login |
   | Several logins of one vendor to get past usage limits | High. Providers name account rotation explicitly | Refused (F8) |

4. **Recommended setups:** API key, Bedrock, Vertex or Foundry for Claude; AI
   Studio or Gemini Enterprise keys for Antigravity; each person their own
   login otherwise.
5. **Terms change.** Every quote carries a "read on" date, and re-checking
   the page is part of each release checklist.

Tests: the bubble renders for each case. It is absent for API-key rows,
dismissal persists, and routing is unchanged.

Effort: low.

How the others handle it (checked 2026-11-28 in their repositories):

| App | Approach |
|---|---|
| OpenBot | A dedicated `docs/provider-terms.md`: the "we don't check your use" disclaimer, "not legal advice", Anthropic quoted with a read date, "Anthropic has not confirmed…", a risk-by-use table, an API-key recommendation. Linked before a Claude sign-in on a server. No in-app warning found |
| OpenMausBot | Short in-app wording ("your own Claude subscription… no password sharing"). The self-hosting doc says the bots share the subscription's limits. A failover never rotates to another login of the same subscription (`server/limit-failover.ts`) |
| t3code | FAQ "Will I get banned?": "No… within the TOS of Claude Code, Codex, and Google Antigravity… If it works in T3 Code, you can trust it is safe." Partnerships not verifiable. Refuses an auto-switcher, yet links a subscription-pooling guide ("Early apologies if it gets you banned") |
| Orca | Silent: "bring your own subscription". Offers one-click account hot-swap for Claude, Codex and Antigravity |

We take OpenBot's honesty and structure and OpenMausBot's rule in code. We
avoid t3code's guarantee, which Octipus cannot give and Google's FAQ
contradicts for Antigravity.

### F8. Never rotate subscription logins to get past a limit

Seen in: OpenMausBot `server/limit-failover.ts`. Providers' terms name account
rotation explicitly (Google's Antigravity FAQ; OpenMausBot's code comment;
t3code's FAQ).

Rule: a backup for a run that hit a usage limit may be:
- a different vendor;
- an API key, Bedrock, Vertex or Foundry credential of the same vendor.

It may never be another subscription login of the same vendor.

Enforcement:
1. **Saving a topic backup binding:** a binding whose backup is another
   subscription login of the primary's vendor is refused, with the reason and
   the alternatives.
2. **At run time:** when the quota tracker reports a limit, fallback skips
   such a backup. With no allowed backup, the run waits for the reset (A1)
   instead of rotating.
3. **Account switching is not offered.** There is no "switch account" action
   for a single person's model rows beyond signing out and in again, which
   stays possible.
4. **Separate purposes are allowed.** A person may keep a personal and a work
   login of one vendor as two rows, each bound to its own sessions or spaces;
   only automatic fallback between them is refused.

The UI copy at a refused backup reads: "A second login of the same
subscription can't be a backup: rotating accounts past a usage limit breaks
the provider's terms. Pick another vendor or an API key, or let the run wait
for the limit to reset."

Tests: binding validation; runtime fallback skips; A1 waits instead.

Effort: low.

### F6. Claude stays on the CLI

The Agent SDK bundles and spawns the same binary under the same terms. Octipus
keeps `claude -p` stream-json. Revisit the TS Agent SDK only if the
undocumented control requests (`interrupt`, `priority`, `set_model`) break
between CLI versions. The SDK documents them; that is its only gain for
Octipus.

---

## G. From Hermes Agent (checked 2026-11-28)

Source: NousResearch/hermes-agent at `29bbd2d9` (2026-11-28), releases
v0.23.1–v0.23.5, issues. This section covers product direction and adoption.
Architecture and caching are in
[the 11-08 study](../reports/architecture-review-2026-11-08/hermes-agent.md).

**Where Hermes is going:**
- **Consumer desktop first:** onboarding is a scripted chat that ends with a
  real first task. A desktop redesign is announced: one agent sidebar, central
  Routines, one page for skills, plugins and tools.
- **Bots as the unit of value:** a "Bots Market" of templates is announced
  but not yet in the repository.
- **Proactivity only with consent:** #158538 rejects a background scanner.
  Every proactive run is a job the user approved on a card (#158289), and
  results land in an inbox you can reply to (#158555).
- **Hosted and paid:** Hermes Cloud, a shared "Team Gateway" bot, a free tier,
  Portal plans (Free / $20 / $100 / $200).
- **Plugins over core:** 2,686 catalog entries, in tiers Official, Verified
  and Community.

**Kanban vs team:**
- There is no single choice. "Team" is Bot Mode: persistent per-profile
  chats, Routines, group chats of 2–6 bots with round caps. Kanban is a
  separate durable board whose workers are profiles, with Auto/Manual
  decomposition of a Triage column.
- Both are on by default, and their docs never mention each other. A
  community post supplies the missing model: "Bot Mode organizes your agents,
  Kanban organizes their work".
- The seams produce bugs: `message_agent` kills a kanban worker (#144635);
  board notifications can't reach a bot chat (#148321); identity and progress
  are unclear across both (#157641, #157823).
- #81405 proposes a Team entity where the user explicitly picks Quick Chat
  or Managed Work. It is open with no reactions.

Lesson for Octipus: it already has four ways to get work done:
- chat with swarm;
- pipelines;
- to-dos with role agents;
- Companion goals.

The risk is Hermes's: parallel surfaces with no map between them. Don't add a
fifth; connect the four (G4).

### G1. Proposed schedules behind a consent card

Change: when a conversation reveals recurring or owed work ("remind me
before the trip", a reply the user owes), the agent proposes a schedule
through an inline UI card with "Schedule this job?" and the time, the
delivery target and the permissions it would use. Nothing is scheduled
without a click. New schedules start paused until a time is picked, and a
setting turns proposals off. Joins B4 (look-around) and A3 (gates).

Octipus has hooks and schedules, a seeded Daily Briefing and Companion
standing instructions; no proposal card.

Effort: low–medium.

### G2. Onboarding ends with a first real task

Seen in: `session_rules/onboarding_first_tasks.py` (up to 4 picks, gated by
facts of this install, plus "name your own").

Change: the setup guide's last step offers up to four first tasks that fit
what was just set up:
- mailbox connected → "Brief me on today";
- project folder → "Map this repository";
- notes or Obsidian vault → "Turn my notes into a wiki";
- CLI agent → "Fix one open issue".

Each runs as a normal session, so the first thing a user sees is a result, not
an empty chat. Today ONBOARDING.md ends at "Try your first chat".

Effort: medium.

### G3. Import from the agents people already use

Seen in: `hermes setup` detects OpenClaw, Claude Code, Codex, Cursor, Grok
Bot and OpenBot, and asks "Import your setup from …?" with a plan per item and
`--dry-run` (`website/docs/user-guide/import-from-other-agents.md`).

Change: in the setup guide and `octi setup`, detect:
- `~/.claude` (skills, `CLAUDE.md`, MCP servers);
- `~/.codex` (`config.toml` MCP servers, `AGENTS.md`);
- OpenClaw and Cursor configurations.

Show a plan per item:
- skills go to the skill library;
- MCP servers to the MCP configuration, disabled until reviewed;
- instructions to a persona or note.

Never copy credentials. A dry run comes first. Replaces the "importers" line
in C7.

Effort: medium.

### G4. One map of the ways to get work done, and promote actions

Change:
1. A decision table in the docs and in the app's help:

   | You want | Use |
   |---|---|
   | An answer or a bounded change now | Chat (the root delegates if useful) |
   | Fixed stages with approvals | Pipeline |
   | Work picked up later or by a role | To-do with a role agent |
   | An outcome owned until verified, across sessions | Companion goal |

2. Promote actions in a chat: "Make this a to-do", "Make this a goal" and
   "Run as a pipeline". Each carries the conversation's request and evidence.
   No retyping.
3. One status vocabulary across the four, shown in "Needs you" (D1).

Effort: low for the table, medium for the actions.

### G5. Auto or manual breakdown on the board

Seen in: Hermes Kanban `kanban.auto_decompose`, capped per tick.

Change: an optional Triage column on the To-dos board.
- **Auto:** the `pm` role breaks a dropped item into a task graph assigned to
  roles by their descriptions, with at most N items per heartbeat.
- **Manual:** the item waits for the user.

The parent item closes only when its children are done and the `pm` role
judges the result. Octipus already has the `pm` role writing a backlog in one
call.

Effort: low–medium.

### G6. Reply to a routine's result to continue it

Change: a schedule or role-agent result in the inbox or a linked chat can be
answered directly, and the reply continues that run's session with its
context.

Check first what the inbox and away digest already allow.

Effort: medium.

### G7. Role templates with a trial run

Fits C4 (packages). Installing a role or team template offers a sample task
to try it on before anything is scheduled. Its schedules stay off until a
time is picked.

Effort: low on top of C4.

### Not taken from Hermes

- A catalog of thousands of community plugins: curated quality over count.
- Persistent per-role "forever" chats and bot group chats: high effort. Revisit
  with the workroom plan (`docs/plans/workroom-and-swarm-federation.md`).
- Hosted Cloud and a shared team bot: already E1.

---

## Lessons from their bug trackers

- Images stored inline in the database (T3 #26591: 1.4 GB).
- Delete that does not delete (T3 #17845).
- Git checkpoints time out on large repositories (T3 #26227).
- Idle animations burn CPU (OpenMausBot #4116).
- Overlay windows block the screensaver (OpenMausBot #6959).
- Agent-reported token overhead far above the native CLI (T3 #7338): measure
  Octipus against the native CLI for the same task.

## Order

1. **Compliance:** F5 (Claude login serves only its owner), F7 (information
   bubble and documentation for the other subscription logins) and F8 (no
   login rotation past limits).
2. **Quick wins:** A1, A3, E4, C6, G4 (the decision table), then A2 once
   measured.
3. **Adoption:** G2 (first real task), G3 (import), G1 (consent cards), G4
   promote actions.
4. **Runtimes:** F2 (with steering S3), then F3, then F4.
5. **Connectors:** C1, C2, C5.
6. **Companion:** B1, B2, B4, B5, then B3.
7. **Packages and business:** C4 with G7, E2, E3; E1 after an owner decision.
8. **Later:** C3, D1, D2, D3, B6, C7, G5, G6.

## Not doing

- Automatic rotation between subscription accounts (now enforced, F8).
- Copying OpenBot code or catalog data.
- Star, follow or referral nudges in the app.
- Per-worktree VMs (execution environments cover this).
- A model that decides between queue and steer.

## Open questions

1. Hosted relay: wanted at all, and who runs it?
2. Avatar: vendor the OpenMausBot engine (after a licence check) or write our own?
3. Should idle compaction run for sessions the user may not return to?
4. Which 30 hosted MCP servers come first?
Decided 2026-11-25: the owner-only rule stays limited to Claude (F5); Codex,
Antigravity and the other subscription logins get information only (F7). Multi-user
installs where each person signs in their own login are documented, not
confirmed with Anthropic in writing.

## Sources

- T3 Code: `apps/server/src/orchestration-v2/`, `docs/user/*.md`,
  `packages/provider-*`; issues #231, #4123, #7338, #26227, #26591, #17845.
- Orca: `src/main/bots/`, `src/shared/bots/`, `docs/site/content/docs/`;
  issues #1099, #19831, #38108, #42961, #45757.
- OpenBot: `docs/architecture/*.md`, `src/backend/agent/`; issues #8726,
  #6198, #10521, #2463.
- OpenMausBot: `src/lib/mascot.ts`, `src/components/mascot-clock.ts`,
  `electron/talk-panel.mjs`, `docs/proactive-routines.md`; issues #4116,
  #6959, #7165.
- Reviews: andrew.ooo (T3 Code, OpenMausBot), openreplay.com (Orca),
  explainx.ai and mindstudio.ai (OpenBot). No substantial Hacker News or
  Reddit threads were found for any of the four.
- Limit: for Orca and OpenMausBot only issue titles and bodies were read, not
  comment threads.
