# Roadmap

> **Note.** Directions, not promises. Items move, get reshaped, or get dropped as the project learns. If something here is interesting, open an issue and let's talk before you build.

This doc lists what we are exploring. Order inside each section is rough priority, not strict sequencing. PRs welcome on anything marked **Help wanted**.

---

## Now (in flight)

- **Auto-discovery for tools and channels.** Roles got the drop-folder
  pattern (`src/core/orchestrator/roles/<name>/`). Tools and channels are
  still wired manually because (a) the `BaseTool` / `BaseChannel`
  abstract surface is wider than `RoleConfig` (lifecycle hooks,
  reaction/typing methods, channel-specific webhooks) and a folder
  convention has to encode all of it, and (b) channels are conditionally
  enabled by env vars, so a discovery loop has to stay opt-in. Doable
  but needs a typed contract pass first; tracked here so the work isn't
  silently dropped.



- **Node-folder pattern for roles.** Move from a single `roles.ts` to `src/core/orchestrator/roles/<name>/{config.ts, prompt.md, tools.ts}` with auto-discovery. Lowers the barrier for contributing a new role. Inspired by [Weft](https://github.com/WeaveMindAI/weft)'s catalog pattern. **Help wanted** for migrating individual roles after the loader lands.
- **Pipeline DAG view.** Render pipeline stages as a graph in the web UI. Edit either view, the other updates. First step toward the two-view (graph ↔ code) abstraction described in [DESIGN.md](./DESIGN.md).
- **Source attribution everywhere.** Every assistant reply appends what it pulled from (profile facts, knowledge base hits, recent messages, classifier topic). Already in `directResponse` and the orchestrator path; expanding to expert sessions and pipeline stages.
- **Per-channel `/clear` semantics.** Webchat clears UI; Telegram/Slack/etc. preserve transcript but reset orchestrator context boundary. `clearedAt` boundary now respected by orchestrator + direct response.
- **Cross-session aggregation** for channel transcripts (telegram, slack, whatsapp, teams, discord). One continuous view per (user, channelType, channelId) instead of one row per restart.

## Next (months)

- **Dynamic role definition from the chat.** "Define a role that does X with tools Y" → orchestrator writes the three node-folder files, hot-reloads, and uses the new role on the next message.
- **Skill marketplace.** Export/import skills as signed JSON. Discover and install community skills from the web UI.
- **Pipeline templates from natural language.** Describe a multi-stage workflow, get a pipeline definition you can run, edit, and save.
- **Better human-in-the-loop.** First-class "wait for human input" node with form schema + replay across restarts. Today this works through approval gates; we want it to be a primitive any role can call.
- **Expert sessions with persistent threads.** Pin an expert to a thread; messages in that thread always go to it (per-channel). Today `/expert` is per-session.
- **Mobile clients.** Native iOS/Android via the gateway protocol. Today the web UI is responsive but not installable.

## Later (open directions)

- **Federation.** Multiple assistant instances coordinating — your home assistant talks to your work assistant talks to a friend's assistant, with explicit consent and audit trails.
- **Local-first sync.** PGlite + CRDTs for cross-device session continuity without a central server.
- **Voice as a first-class channel.** Today STT/TTS works through the gateway; we want full duplex voice with interruption handling and emotion-aware routing.
- **Sandboxed tool execution.** Today shell/code tools run in the same process. We want WASI / lightweight VM isolation per worker.
- **Plugin signing & permissions.** Today plugins in `extensions/` run with full host trust. Capability declarations + signature verification.
- **Cost-aware routing.** Router considers per-provider cost in addition to capability. Already partial; we want it tunable per user.
- **Embedded eval-driven prompt iteration.** Edit a role prompt in the UI, run the eval suite, see the diff in metrics, accept or revert. Closes the loop on prompt engineering.

## Done (recent)

- Gateway hub with typed Zod protocol, multi-client auth (session, local, HMAC, API key), connection budgets, rate limiting
- 16 roles + 15 expert personas + 20 domain skills, all DB-seeded for runtime editing
- 59+ MCP tools across 19 groups (filesystem, shell, git, browser, web search, Docker, Workspace, M365, GitHub/GitLab, knowledge base, profiles, scheduling, voice, cross-channel messaging, and more)
- Three-tier permission system (ALLOW / ASK / DENY) with rule matchers, pre/post hooks, audit trail
- Three-layer prompt-injection defense (system preamble + 39-pattern input guard + LLM output guard)
- Encrypted vault (AES-256-GCM) with per-tool access control
- Adaptive rate limiting with per-provider semaphores, token-bucket RPM, circuit breaker, automatic failover
- Provider conformance + quality eval suites with cross-model comparison
- Red-team test plugins (5 attacks, 49 cases) covering prompt injection, role confusion, tool misuse, data leakage, off-topic drift
- 112 E2E API tests, 535+ unit tests
- Pipeline templates DB-driven; QA retry loops; structured handoff context documents
- Browser extension for human-in-the-loop control of the user's real Chrome
- TUI with Ink, permission prompts, cost tracking, paste markers, file path completion
- WhatsApp Cloud API channel with HMAC verification and message dedup
- WebAuthn passkeys, TOTP 2FA, JWT sessions, HttpOnly cookies

---

## How to influence the roadmap

- **Open an issue.** Describe the problem first, then your proposed solution. We optimize for understanding the problem, not for the cleverness of the fix.
- **Send a PR.** For items marked **Help wanted**, jump in. For everything else, the issue-first rule from [CONTRIBUTING.md](./CONTRIBUTING.md) applies.
- **Argue.** If you think a roadmap item is wrong, say so with a real argument. The roadmap is a current bet, not a contract.
