# External OSS Integration Plan

**Status:** Draft — planning only, no implementation yet
**Created:** 2026-05-14
**Scope:** Evaluation of 8 external repos and phased integration roadmap

---

## Guiding principles

- **Clear usecase only.** No feature unless it serves "run your life or your company". Reject dev-tool padding.
- **Octipus owns the runtime.** Do not import foreign daemons, gateways, BYOK proxies, or CLI spawners — they duplicate gateway hub + CLIAgentWorker + vault.
- **Single runtime invariant.** Bun/TS. Python sidecars only as last resort.
- **Reuse Octipus primitives.** New capabilities ship as experts/skills/roles seeded into existing DB tables. Permissions, audit, vault, input/output guards apply uniformly.
- **License hygiene.** Vendored prompts/assets retain NOTICE/attribution.

---

## Repo verdicts (summary)

| Repo | License | Verdict | Phase |
|---|---|---|---|
| czlonkowski/n8n-mcp | MIT | Wire as optional MCP | P1 |
| Manavarya09/design-extract | MIT | Wire as MCP | P1 |
| pbakaus/impeccable | Apache-2.0 | Expert + steal detector | P2 |
| nexu-io/open-design | Apache-2.0 | Asset/prompt extraction | P2 |
| santifer/career-ops | MIT | Expert (steal prompts/rubrics) | P3 |
| browser-use/browser-harness | MIT | Engine (port pattern) | P3 |
| getagentseal/codeburn | MIT | Skip (lift waste heuristics only) | P4 |
| safishamsi/graphify | MIT | Skip | — |

---

## Phase 0 — Foundations (prereq for everything below)

No new external repos. Verifies existing Octipus surface is ready.

**Tasks**
- Audit MCP client bridge (`src/mcp/`) — confirm lazy discovery + per-server lifecycle works end-to-end
- Verify `mcp-servers.json` schema supports stdio + HTTP transports
- Verify permission system gates MCP write-tools (ALLOW/ASK/DENY per tool action)
- Verify vault holds external service credentials (n8n API key, portal logins, browser cookies later)
- Verify audit trail records MCP tool calls with full args
- Add MCP server enable/disable toggle in Settings → Integrations UI (Next.js)

**Exit criteria**
- Can wire arbitrary stdio MCP via `mcp-servers.json`, see tools in orchestrator, hit permission/audit/vault
- Settings UI shows MCP server list with enable/disable + per-tool permission

---

## Phase 1 — Quick-win MCPs (optional, additive)

Both wire as stdio MCPs. No new containers. Both **opt-in** in Settings.

### 1.1 design-extract (MCP)

**Goal:** Pull design tokens (DTCG / Tailwind / shadcn) from any URL on demand.

**Usecase**
- Frontend role / `designer` expert calls `extract_tokens(url)` before any UI work
- Web channel widget theming bootstrapped from reference site
- Pairs with existing `frontend-design`, `theme-factory`, `ui-ux-pro-max` skills

**Integration shape**
- Add entry to `mcp-servers.json`: `npx designlang mcp` (stdio)
- Pin version (v12.x has API churn)
- Run inside dedicated MCP worker process (Chromium ~300MB on first run) — not gateway
- Output landing dir: route to existing artifacts/file channel, never `./design-extract-output/` in cwd

**Tasks**
- Add MCP config entry (disabled by default)
- Add Settings toggle "Design Extraction" under Integrations
- Document Chromium disk cost in setup docs
- Add e2e test: enable → call `extract_tokens` against fixture URL → see artifact

**Risk**
- Vendor API churn — pin version, monitor releases
- Chromium memory if multiple parallel calls — single-flight queue if needed

### 1.2 n8n-mcp (MCP, optional)

**Goal:** Let users who run n8n author/deploy n8n workflows from Octipus. **Not** Octipus's default automation engine.

**Octipus automation hierarchy (explicit)**
1. **Native task system** — one-off tasks, recurring (cron), planned (datetime), hooks
2. **Pipelines** — DB-driven templates, orchestrator-managed
3. **n8n** — only when user explicitly says "as an n8n workflow" or "deploy to n8n"

Native is default. n8n is escape hatch for SaaS-heavy multi-step glue that benefits from n8n's 400+ integrations or visual editor.

**Usecase**
- "Build me an n8n workflow that watches Gmail for invoices and posts to Slack"
- "Deploy this automation to my n8n instance" (after native automation hits an integration Octipus doesn't have)
- Workflow template discovery (2,352 templates) when user wants visual editing

**Routing rules (orchestrator)**
- Default: native task/hook/pipeline system
- Switch to n8n only when prompt contains explicit n8n intent OR target SaaS isn't in Octipus channels/MCPs
- `automations` expert role owns n8n decisions; refuses to auto-migrate native tasks to n8n
- Add SECURITY_PREAMBLE clause: never silently deploy to n8n

**Integration shape**
- Optional MCP entry, **disabled by default**
- Requires: user-supplied n8n URL + API key (vault-stored)
- Settings → Integrations → "n8n" with URL + API key fields + enable toggle
- Permission system: all `n8n_create_workflow`, `n8n_update_partial_workflow`, `n8n_test_workflow` → **ASK** by default; read-only docs tools → ALLOW
- Vault: store API key as secret; never log

**Hosting**
- Octipus does NOT host n8n. User brings own n8n (self-host or n8n.cloud)
- Setup doc: optional docker-compose snippet for self-host, link to n8n.cloud
- No new container in docker-services by default

**Tasks**
- Finish/test MCP wiring (already attempted per memory)
- Settings UI: n8n integration card (URL, API key, test connection button)
- Vault: register `n8n_api_key` secret type
- Permission defaults: write-tools ASK
- Orchestrator: routing heuristic + `automations` expert
- Audit: every n8n write tool logged with full workflow payload
- Setup docs: when to use n8n vs native
- E2e test: stub n8n API, exercise create/update/test flows

**Risk**
- Users may not know which to pick → mitigate with clear docs + orchestrator default to native
- Solo-maintained MCP → pin version, vendor docs cache
- API key leakage → vault-only, redact in audit display

---

## Phase 2 — Design quality lane

### 2.1 impeccable → `design-critic` expert + MCP tool

**Goal:** Static + LLM design-quality gate before frontend work merges.

**Usecase**
- Any role producing UI (frontend, designer, marketing landing pages) gets critiqued automatically
- QA pipeline stage runs `design.detect_antipatterns` before approval gate
- Surfaces concrete issues: overused fonts, gray-on-color text, excessive card nesting, outdated easing

**Integration shape**
- Port 27 deterministic rules (JS → TS) into `mcp-server/src/tools/design/` as `design.detect_antipatterns(html_or_url)`
- Seed 12 LLM-judge rules as skills in `skills` table (prompt-pack)
- New `design-critic` expert in `experts` table; QA role can hand off to it
- Apache-2.0: preserve NOTICE in `mcp-server/src/tools/design/NOTICE`

**Tasks**
- Port rules to TS (test parity with upstream fixtures)
- Add MCP tool
- Seed skills + expert
- Pipeline template: "frontend-with-design-review" (coding → design-critic → QA → merge)
- E2e tests for each rule

**Skip**
- Slash commands (`/polish`, `/animate`) — duplicate orchestrator
- Browser extension
- Astro site, demos, 6MB JS assets

### 2.2 open-design → asset extraction → `designer` expert

**Goal:** Produce decks, posters, landing pages, marketing one-pagers, OKR slides for company ops.

**Usecase**
- "Generate a seed-round deck from these bullet points"
- "Make a one-page invoice template branded for my company"
- "Design an OKR review slide"

**Integration shape**
- Vendor `apps/daemon/src/prompts/discovery.ts`, `directions.ts`, `skills/`, `design-systems/` (Apache-2.0 + NOTICE)
- Seed as Octipus skills + design-systems table
- New `designer` expert references these skills
- Sandboxed iframe preview pattern → reuse in Next.js artifact preview
- Image generation routes through existing provider system (Gemini, gpt-image, etc.) — do **not** import their BYOK proxy

**Tasks**
- Extract prompt corpus + design-system library (license review per file)
- Schema: confirm `skills` + `experts` can hold long prompts (likely yes)
- Seed file `seed-designer.ts`
- Artifact preview iframe in web UI
- E2e: generate sample poster end-to-end

**Skip**
- Their daemon, CLI spawn, BYOK proxy, SQLite store, Electron app
- Video gen (Seedance, HyperFrames) — deferred until concrete demand

---

## Phase 3 — Strategic surfaces

### 3.1 BrowserEngine (server-mode browser surface)

**Goal:** Server-side, autonomous, logged-in browser surface. Complements (not replaces) two existing surfaces.

**Existing browser surfaces (keep)**
1. **Browser extension** — installed in user's desktop browser. Best for: user-present interactive tasks (capture, highlight, annotate, manual save-to-vault). **Unavailable when Octipus is server-hosted or user offline.**
2. **Playwright** — already in repo. Used today for one-shot scripted automation. No per-user profile, no skill memory, no vault wiring.

**Why BrowserEngine is still needed**
- Octipus deployment shapes: local-laptop / self-hosted server / cloud SaaS. **Extension surface only works on local-laptop deployment.** Server + cloud deployments have no browser to install the extension into.
- Autonomous overnight ops (bill pay, portal scraping, fraud check, recurring scans) require server-side execution with persistent logged-in sessions.
- Playwright alone is just a driver — it has no profile management, vault integration, skill accretion, permission gating, or audit wiring.

**Routing (orchestrator decision)**
```
User present + interactive (annotate, capture)  → Extension
One-shot scripted, no per-site auth             → Playwright direct (existing)
Recurring / overnight / logged-in / autonomous  → BrowserEngine
```

**Integration shape**
- New `src/core/browser/` engine, Bun/TS
- **Driver: existing Playwright** (in CDP mode) — do not introduce a second browser library
- Per-user sandboxed Chrome profile (`--user-data-dir`), cookies isolated, never shared across users
- Self-writing skill loop: when agent solves a site task, persist playbook into `skills` table (DB-driven, reusable next time, versioned)
- Surface as MCP tools: `browser.open`, `browser.act`, `browser.observe`, `browser.save_skill`, `browser.run_skill`
- Vault: store per-site cookies/credentials as secrets, decrypted only in worker

**Extension ↔ BrowserEngine bridge (key integration)**
The hard part of browser automation is initial login (real captcha, MFA, device-trust prompts). The extension already lives in the user's real browser where these flows work natively. Pair them:

- Extension exports cookies + localStorage + IndexedDB for a site → Octipus vault (`site_session:<domain>`)
- BrowserEngine restores them server-side at start of each autonomous run
- Extension also captures "user did X, Y, Z on this page" → seed a draft skill in the skills table for review/promotion
- Effect: user logs in **once** in their normal browser; Octipus replays the session forever server-side

This avoids reimplementing auth per site and avoids stealth/captcha arms races.

**Tasks**
- Spike: Playwright persistent context with `--user-data-dir`, single-page navigation + screenshot
- Per-user Chrome lifecycle: spawn-on-demand, idle-kill, profile dir layout under per-user data dir
- Skill accretion loop: capture successful action sequences, prompt-template into skill record (versioned)
- Permission gates: every navigation outside allowlisted domain → ASK; every form submit → ASK; every credential use → audit
- Vault integration for cookie/credential storage (`site_session:<domain>` secret type)
- MCP tool surface (`browser.*`)
- Worker isolation (separate process, not gateway)
- **Extension bridge:**
  - Extension command: "Export session to Octipus" → POST cookies/storage to gateway
  - Extension command: "Record skill" → capture click/type sequence → draft skill row
  - BrowserEngine: hydrate session from vault before navigation
- E2e: scripted login via extension export + autonomous replay against test fixture site
- Setup docs: per-deployment-shape guidance (laptop / server / cloud)

**Deployment-shape matrix**

| Deployment | Extension viable? | BrowserEngine required? |
|---|---|---|
| Local desktop (TUI/web on laptop) | Yes | Nice-to-have (autonomy + reuse skills) |
| Self-hosted server (Docker) | No | **Yes** |
| Cloud-hosted SaaS | No | **Yes** |

**Hosting**
- Local: spawned Chrome per user — no container required
- Containerized: optional `chromium-headful` container per user (docker-services addition, opt-in for self-hosted)
- Cloud: future — Browserless / Browser Use Cloud as alternate backend behind same MCP surface

**Risk**
- HIGH security surface — full session/cookie access. Mitigations:
  - Per-user profile isolation (never shared)
  - Vault-gated credentials
  - Permission ASK for sensitive ops
  - Audit every action with screenshot + DOM snapshot
  - SECURITY_PREAMBLE: never auto-submit financial transactions
- Extension bridge ships cookies over gateway — must be HMAC-signed + transport-encrypted; never log payload
- Site changes break playbooks → skill versioning + retry-with-replan loop
- Effort: largest item in plan (~3-4 weeks), reduced slightly by reusing existing Playwright

### 3.2 career-ops → `career` expert

**Goal:** Personal career management as a worked example of "run your life".

Depends on Phase 3.1 BrowserEngine for portal scraping.

**Usecase**
- "Evaluate this job posting" → 10-dim A-F score
- "Tailor my CV for this role" → ATS-optimized PDF
- "Scan my Greenhouse/Ashby/Lever portals for new roles matching profile"
- "Prep STAR stories for an interview at X"
- "Negotiation script for this offer"

**Integration shape**
- Vendor prompts + rubrics (10-dim scoring, STAR+R bank, `portals.yml`, CV templates) — MIT, attribution comment
- New `career` expert + skills: `evaluate-offer`, `tailor-cv`, `scan-portals`, `negotiation-prep`, `interview-story-bank`
- Portal scraping via BrowserEngine (3.1) — Greenhouse/Ashby/Lever site skills
- PDF generation: small MCP tool wrapping existing PDF lib (pdf-lib or similar)
- User profile storage: extend `users` schema with `career_profile` JSONB (CV base, portals.yml equivalent, story bank)

**Tasks**
- Schema migration: `users.career_profile`
- Vendor + adapt prompts
- Seed `career` expert + skills
- PDF tool in MCP
- Browser skills for Greenhouse/Ashby/Lever (depends 3.1)
- Web UI: career profile editor in Settings
- E2e: evaluate fixture posting end-to-end

**Skip**
- Their Go TUI, multi-CLI abstraction, `claude -p` sub-agent batching — Octipus orchestrator already does this better

---

## Phase 4 — Cleanups

### 4.1 codeburn — heuristic lift only

Octipus owns its own audit/cost data via gateway spans. Codeburn's value is its waste-pattern heuristics, not its UI.

**Goal:** Surface "you're wasting tokens because X" insights inside Octipus usage view.

**Tasks**
- Port 3 heuristics into audit analysis layer:
  - Re-read waste (same file read N+ times in session)
  - Low read:edit ratio (read-heavy churn without changes)
  - Unused MCP servers (enabled but never called in last N sessions)
- Surface in `/usage` gateway command + Settings → Usage tab
- No external integration, no MCP, no vendor code

### 4.2 graphify — confirmed skip

Wrong domain, wrong stack, redundant with existing pgvector + tree-sitter outline. No action.

---

## Cross-cutting work

### Security
- Every new MCP write-tool defaults to permission ASK
- Every new external credential routed through vault
- New SECURITY_PREAMBLE clauses:
  - "Never deploy to n8n without explicit user instruction"
  - "Never auto-submit financial transactions via browser"
  - "Never share browser profiles across users"
- Input guard: extend patterns to cover prompt-injection via scraped page content (Phase 3.1)
- Audit: ensure full args captured for n8n create, browser actions, CV uploads

### Permissions matrix (new tools)

| Tool group | Default |
|---|---|
| design.extract_tokens (read) | ALLOW |
| design.detect_antipatterns (read) | ALLOW |
| n8n.docs_search (read) | ALLOW |
| n8n.create_workflow (write) | ASK |
| n8n.update_workflow (write) | ASK |
| n8n.test_workflow (write) | ASK |
| browser.navigate (allowlisted) | ALLOW |
| browser.navigate (other) | ASK |
| browser.act (form submit) | ASK |
| browser.use_credential | ASK + audit |

### DB migrations needed

- Phase 1: none (Settings flags only)
- Phase 2: `experts` rows for `design-critic`, `designer`; `skills` rows
- Phase 3.1: `skills` rows generated dynamically; possibly `browser_profiles` table (user_id, profile_dir, last_used)
- Phase 3.2: `users.career_profile` JSONB column

All migrations follow Drizzle journal rule.

### Settings UI additions
- Integrations tab: n8n card, design-extract toggle, browser engine toggle (when 3.1 ships)
- Experts tab: new experts visible/editable
- Usage tab: codeburn-style waste insights (4.1)
- Career tab (3.2): profile editor

### Contributing guidelines compliance
- All vendored code retains license + NOTICE
- New experts/skills seeded via existing `seed-*.ts` pattern
- All new MCP tools exposed in `mcp-server/src/server.ts` registration
- Tests: Bun test, follow existing patterns (`bunfig.test.toml`)
- TypeScript strict, no `any` introductions

---

## Sequencing & estimates

| Phase | Items | Effort | Depends on |
|---|---|---|---|
| 0 | MCP foundation audit | 1-2 days | — |
| 1.1 | design-extract MCP | 0.5 day | 0 |
| 1.2 | n8n-mcp optional integration | 2-3 days | 0 |
| 2.1 | impeccable design-critic | 3-5 days | 0 |
| 2.2 | open-design designer expert | 3-5 days | 0 |
| 3.1 | BrowserEngine | 3-4 weeks | 0 |
| 3.2 | career expert | 1 week | 3.1 |
| 4.1 | codeburn heuristics | 1-2 days | — |

Total: ~6-8 weeks if sequential; ~4-5 weeks with parallelism (P2 items run while P3.1 is being built).

---

## Open questions

1. n8n hosting story in docs — recommend n8n.cloud or self-host docker-compose snippet?
2. BrowserEngine: local Chrome (simpler) vs containerized (safer, more setup)? Default per OS?
3. design-extract: single shared Chromium pool or per-call ephemeral?
4. career expert: store CV base as Markdown in `users.career_profile`, render PDF on-demand?
5. Should `automations` (n8n) expert be visible even when n8n integration is disabled? (lean: no — hide expert until enabled)

---

## Out of scope (explicitly rejected)

- Importing open-design or career-ops runtimes (duplicate gateway)
- Python sidecars (single-runtime invariant)
- graphify (wrong domain)
- codeburn UI / Swift menubar / Ink TUI
- impeccable slash commands / browser extension / Astro site
- Auto-migrating native tasks to n8n
- Octipus hosting n8n by default
- Video generation (Seedance, HyperFrames) until concrete demand

---

## Definition of done (per phase)

Each phase ships only when:
- All tasks complete with tests (Bun test)
- 0 TypeScript errors (both backend + frontend)
- Security review of new tool permissions
- Docs updated (relevant of: API.md, MCP.md, INTEGRATIONS.md, README.md)
- Migration journal updated (if DB changes)
- Audit confirms new actions logged
- Settings UI exposes user controls
- E2e test exercises happy path
