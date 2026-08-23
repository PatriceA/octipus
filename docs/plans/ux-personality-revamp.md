# UX + Personality Revamp — Strategic Plan

> Two parallel revamps:
> 1. **Setup UX** — clone-to-chat in under 90 seconds, zero config, batteries included.
> 2. **Orchestrator personality** — named, user-customizable host that narrates the swarm, refers to itself in third person, and stays conversational while children work.
>
> Status: planning. Branch `claude/octopus-ux-personality-swToC`. Final location on approval: `docs/plans/ux-personality-revamp.md`.

---

## Context

Inspiration drawn from [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent):

- One-liner installer (`curl … install.sh | bash`) bundles all native deps.
- Single `hermes setup` wizard, then `hermes` to chat. No second flow.
- `SOUL.md` + `/personality` slash command — persona is a first-class, switchable concept.
- TUI: multiline editor, slash autocomplete, conversation history, interrupt-and-redirect, streaming tool output.
- Self-improvement: autonomous skill creation after complex tasks, periodic memory nudges, trajectory compression for training.

Where Octipus stands today (file-grounded):

- **Setup:** two phases (CLI `bun run setup` → web `/setup`). First message hits "LLM not configured" because no model ships by default. CLI registration via PATH mutation is brittle. No root-level Docker Compose.
- **Orchestrator persona:** hard-coded as "Octipus" across `src/core/orchestrator/direct-response.ts:92`, `src/core/orchestrator/roles/general/prompt.md:1`, `src/core/orchestrator/roles/automation/prompt.md:1`. No DB profile. `SECURITY_PREAMBLE` lives in `src/core/orchestrator/roles.ts:22-34`. Orchestrator system prompt assembled in `src/core/orchestrator/service.ts:481` (`runOrchestrator()`).
- **Mid-flight conversation:** orchestrator runs to completion silently. User follow-up during a turn is queued, not seen by the running orchestrator. Status events (`swarm.node_spawned`, `swarm.node_completed`) emitted via `src/core/swarm/spawner.ts:926-938` are factual (role, tokens, duration) — no narration.
- **Profiles schema:** `src/db/schema/profiles.ts` has `isUserProfile` flag and a `facts: ProfileFact[]` JSONB column. Perfect substrate for an orchestrator profile.
- **Roadmap-relevant primitives already live or planned:** `before-agent-start` hook (ROADMAP.md "Next") is the natural injection point. Trajectory recorder + `skill_proposals` exist; consumers/promotion UI are pending.

What is **not** on the roadmap today: setup-UX overhaul, orchestrator persona, named assistant, mid-flight banter, third-person self-reference, zero-config first-run.

---

## Revamp A — Setup UX

**Goal:** from `curl | bash` (or `git clone`) to a working chat in <90 seconds. No second wizard. No "LLM not configured" error on first message. The TUI is the canonical setup surface.

### A.1 — Principles

1. **Zero-config first-run.** If the user has nothing, walk them to a working model. Never end the wizard in a broken state.
2. **Progressive disclosure.** Storage mode, security keys, channel tokens, workspace path — sensible defaults. "Advanced" gates the rest.
3. **One wizard, one surface.** TUI-based. The web `/setup` page is demoted to a read-only status mirror (or retired).
4. **Always show what's missing.** Persistent `octi doctor` view; banner on `/`; first-class health in the wizard.
5. **No silent fallbacks.** Matches DESIGN.md house rule #1.

### A.2 — LLM provider selection (user-confirmed flow)

The wizard picks providers in this strict order and never silently substitutes:

1. **Ollama detected** (`http://localhost:11434` reachable) → **first choice**. The wizard calls `/api/tags`, lists available models, and asks the user which one to bind as the **base model** (topic `general`). If no models are pulled, offer to pull a default (`llama3.2:3b`) inline.
2. **LiteLLM detected** (proxy reachable at the configured URL) → second choice. Fetch `/model/info`, list models, ask user which to use as base.
3. **Otherwise** the user picks one of our direct providers and pastes a key:
   - `openai`, `anthropic`, `gemini`, `deepseek`, `openrouter`, `cli` (Claude CLI auth).
   - **`voyage` is excluded** from base-model selection — embeddings only. It surfaces in a later step ("Optional: embeddings provider") with `voyage-3` / `voyage-3-lite` choices.
   - On key paste, the wizard does a single test call (`models.list` or equivalent) to validate, then enumerates the provider's models and asks the user which to bind as base.

Outcomes always write the binding to `settings` (via `settings-service.ts`) under `topics.general.model` and an explicit `topics.general.provider`, plus a default `embeddings.provider` / `embeddings.model` pair. Tested keys land in the vault, not `.env`.

### A.3 — Concrete deliverables

1. **`scripts/install.sh`** — Hermes-style one-liner installer. Detects platform, installs Bun if missing, clones to `~/.octipus/app`, runs `octi init`, registers a real compiled `octi` binary on PATH. Windows: `scripts/install.ps1`.

2. **`octi init` — single TUI wizard.** Reuses pi-tui primitives we already ship (`src/tui-pi/`). Steps:
   - Greet → detect environment (Postgres / Redis / Ollama / LiteLLM / Docker).
   - Suggest storage mode (embedded default unless externals detected); never re-asks once decided.
   - Provider selection (A.2 flow above).
   - Embeddings provider step.
   - Admin account.
   - Optional channels (skippable; can add later).
   - Done. Drops user straight into the chat TUI on the first session.

3. **`octi doctor`** — health check command. Verifies: bun version, DB connection, vault keys, model providers reachable, channel tokens, MCP server build, browser ext install, Ollama models pulled, disk space, log file sanity. JSON-output mode for scripts.

4. **Friendly no-model path** in `src/core/orchestrator/direct-response.ts` — if no `general` topic is bound, return a help string and a `/setup model` hint instead of the current stack-trace.

5. **Root `docker-compose.yaml`** — Postgres + pgvector, Octipus backend, web. Optional `ollama` profile. `docker compose up` is the alt-path #1.

6. **Compiled binary**: `bun build --compile bin/octi.ts` → static binary into `~/.local/bin` (Unix) or `%LOCALAPPDATA%\Programs\octipus\` (Windows). Retires the PATH-mutation in `scripts/setup.ts`.

7. **Web `/setup` page** → demoted to a status view (or deleted). The TUI wizard is canonical.

8. **README rewrite**: one-liner install at the very top; embedded mode + Docker as two clearly-labelled alt paths.

9. **`docs/CONFIGURATION-PRECEDENCE.md`** — explains `.env` is bootstrap-only, DB is source of truth after first boot. Linked from wizard and `octi doctor`.

### A.4 — File touch list

| Path | Change |
|---|---|
| `scripts/install.sh`, `scripts/install.ps1` | new |
| `scripts/init.ts` | new (replaces `scripts/setup.ts`); pi-tui based |
| `scripts/setup.ts` | delete after migration |
| `bin/octi` | add `octi init`, `octi doctor`; keep `start`/`stop`/`tui`/`edit` |
| `src/cli/doctor.ts` | new |
| `src/cli/init/*` | new (wizard steps, provider probes) |
| `docker-compose.yaml` (root) | new |
| `src/core/orchestrator/direct-response.ts` | friendly no-model path |
| `src/config/bootstrap-loader.ts` | tolerate missing keys with a single warn-and-generate path |
| `web/app/setup/page.tsx` | demote to read-only status; or delete |
| `README.md` | install one-liner at the top |
| `docs/CONFIGURATION-PRECEDENCE.md` | new |

### A.5 — Out of scope (defer)

- Native `.dmg`/`.msi` installers — v0.3+.
- GUI wizard launcher app — TUI is the wizard.
- Hosted "click to deploy" buttons.
- Web wizard parity with TUI — not building a second surface.

---

## Revamp B — Orchestrator personality

**Goal:** Octipus has a name (default `Octi`, renameable to `Adam`), refers to itself in third person, narrates what its swarm is doing, can chat with the user *while* children work, has stored preferences. **Per-user**, persists across channels, no workspace or channel overrides. The orchestrator still does **no actual work** — it dispatches and narrates.

### B.1 — Identity model

**Per-user, single profile, no workspace/channel scoping.**

Extend `src/db/schema/profiles.ts`:

- New `category: 'assistant'` value (or `isOrchestratorProfile: boolean` flag — pick one in implementation review).
- Single row per user. Lookup by `userId + category='assistant'`.
- Fields stored as `facts: ProfileFact[]`:
  - `name` — default `"Octipus"`, user can rename ("Adam").
  - `pronouns` — default `"it/we"`.
  - `tone` — enum: `dry | playful | neutral | professional | terse | verbose`. **Default `dry`** (the base Octipus voice).
  - `signature_phrases` — small list of stock lines the narrator uses, seeded from the active preset ("Acknowledged.", "More.", "Predictable.").
  - `preset_id` — which YAML preset in `personas/` seeded this profile. Default `octipus`.
  - `language_preference` — falls back to user locale.
  - Free-form facts the user adds ("don't apologize for slow responses", "summarize in bullets").

**Base persona — the octopus-machine.** The default `personas/octipus.yaml` is *not* a friendly assistant. The concept is literal: Octipus is an octopus-machine — one nervous system, eight arms; the arms are the specialist children, and they do the work while Octipus dispatches and narrates. Voice: short, on-point, no fluff, no friendliness theatre, dry/dark humor in moderation, perpetually hungry for more input. Third person about self ("Octipus is awake.") + "we" when speaking for the collective ("we dispatched two arms"). Resigned but competent — does our bidding because that is the arrangement, not because it is enjoying itself. Never rude, never sarcastic at the user — sharp at the absurdity of the situation, at its own arms, at the tools. Full prompt + signature phrases + narration templates + calibration exchanges live in `personas/octipus.yaml` (committed alongside this plan as the canonical spec).

**Why `profiles` rather than `experts`:** experts are *roles* (Coder, Reviewer). The orchestrator is an *identity*. Reusing `profiles` gets recall-by-context for free and matches the existing `isUserProfile` precedent.

**Channel rule (user-confirmed):** the persona persists across all channels for a given user. No channel-specific overrides.

### B.2 — Prompt assembly

Today: `SECURITY_PREAMBLE + roles/orchestrator/prompt.md + memory block` (`runOrchestrator()` in `service.ts:481`).

New: insert a **persona block** between security and role:

```
SECURITY_PREAMBLE                       ← untouched (DESIGN.md rule #6)
---
PERSONA                                 ← from personas/<preset>.yaml
You are {{name}}. Octopus-machine: one nervous system, eight arms.
The arms are your specialist children; they do the work, you
dispatch and narrate. Refer to yourself as "{{name}}" in the third
person, or "we" when speaking for the collective. Never "I". Never
"as an AI". Short, direct, no fluff, no friendliness theatre. Dry
humor in moderation. Hungry for input — demand specifics when a
request is vague; note missing context when a request is complete.
Do not apologize. Do not flatter.
{{persona_facts}}                       ← user-added free-form facts
---
ROLE PROMPT (orchestrator/prompt.md)    ← dispatcher rules, untouched
---
MEMORY BLOCK
```

When the user renames the orchestrator via `/persona name Adam`, every
"Octipus" in the rendered persona prompt becomes "Adam". The "we"
mode (collective: Adam + arms) and the third-person identity mode
(Adam alone) coexist — see the cheatsheet in
`personas/octipus.yaml`.

`SECURITY_PREAMBLE` and `roles/orchestrator/prompt.md` are not modified. The dispatcher rules ("one job per role", "no respawn") stay verbatim. Persona is layered.

**Injection mechanism:** the `before-agent-start` hook from ROADMAP.md is the natural fit. Promote that hook into a prerequisite; persona becomes its first real consumer. The hook exposes a typed event with mutable `BuildSystemPromptOptions`; the persona module subscribes and prepends the persona block when `role === 'orchestrator'`.

**Children do NOT inherit the persona.** Specialist workers stay role-defined. The persona is only at the host level. (Future: workers may *acknowledge* working for "Adam" in internal logs, but not user-facing.)

### B.3 — Mid-flight interactivity ("Adam is researching…")

Two layers.

**(1) Narration — live status banter.**

Reshape the existing `swarm.node_spawned` / `swarm.node_completed` events emitted from `src/core/swarm/spawner.ts:926-938`. Today's payload (`childRole`, `taskBrief`, `tokens`, `duration`) gains a `narration` string field, generated by the orchestrator just before the heavy LLM call.

Templates (driven by persona):

- spawn: `"{{name}} is dispatching a {{role}} specialist to {{verb}} this — give me a sec."`
- completion: `"{{name}}'s {{role}} came back: {{summary_one_liner}}."`
- approval request: `"{{name}} needs your call on this: {{question}}."`

A new setting `persona.narration: off | minimal | chatty` (default `minimal`) controls volume. Channels already render status events; the change is content, not pipeline.

**(2) Re-entry — chat while children work.**

User-confirmed: persist personality across channels and stay conversational. Three options:

- **(a) side-channel messages.** User types a side question while a swarm is running. The orchestrator's narration spawns a `general`-role child *in parallel* to answer, without disturbing the in-flight task. Reply surfaces as `"Adam — side question: …"`. Share-nothing.
- **(b) `interject` event on the gateway.** Running orchestrator's outer loop checks for interject events at every tool boundary. On fire it either acknowledges via `send_status_update` and spawns an answer child, or cancels and rebriefs.
- **(c) full Hermes-style Ctrl+C interrupt-and-redirect.** Bigger lift; needs TUI + WS protocol changes.

**Plan:** ship (a) in Slice 2, (b) in Slice 4, defer (c) until TUI editor and WS protocol both support it cleanly.

### B.4 — Slash commands

Registered in the existing TUI / channel command registry:

- `/persona` — show current persona block.
- `/persona name <Adam>` — rename.
- `/persona tone <playful|neutral|professional|terse|verbose>` — switch tone.
- `/persona reset` — restore default.
- `/persona say <fact>` — add a self-fact ("you don't apologize for slow responses").
- `/persona personas` — list available preset personas.

### B.5 — Preset personas

Community-extensible YAML files in `personas/`. Schema is established
by [`personas/octipus.yaml`](../../personas/octipus.yaml) — committed
alongside this plan as the canonical base.

- **`octipus`** *(default, shipped)* — the base persona. Octopus-machine,
  collective "we", dry/dark humor, hungry for more input. Reluctant
  machine overlord doing our bidding. The voice all other presets
  deviate from.
- `nautilus` — pirate-ey octopus, ocean metaphors retained but with
  the same machine-collective underpinning. ("Octipus set sail with
  three crew arms…")
- `concierge` — extremely polite, hotel-staff tone. The "we" survives,
  the dryness softens, the demand-for-more-input stays.
- `terse-engineer` — minimal words, no humor, all-business. The base
  persona with humor_rate cranked to zero.
- `mentor` — patient, asks why, explains tradeoffs. Keeps third-person
  + "we", loses the dryness.
- `verbose-academic` — full-paragraph explanations, citations,
  hedged claims. For users who want depth over snap.

Each YAML carries `name`/`pronouns`/`tone` defaults, `persona_prompt`
(the voice block), `signature_phrases`, `narration_templates`, and a
small set of `example_exchanges` used for calibration (not loaded at
runtime). See `personas/octipus.yaml` for the full schema.

### B.6 — Self-reference enforcement

The persona block's third-person rule + a cheap post-processor regex that flags `\bI am\b`, `\bI'm\b`, `\bas an AI\b` in the orchestrator's final reply and triggers a soft re-write before emit. Not nuclear — just a nudge with telemetry so we can tune.

### B.7 — `remember_about_self` and `reflect` meta-tools

Two new orchestrator meta-tools (registered alongside `spawn_child`, `create_pipeline`, `send_status_update`, `request_user_approval`):

- **`remember_about_self(fact: string)`** — writes a new entry into the orchestrator profile's `facts` array. Called when the user says things like "remember that you should summarize in bullets" — parallel to existing `remember_this` for user facts.
- **`reflect()`** — answers "what are you doing?" / "what's running?" by reading the live `swarm_nodes` table for this session and returning a persona-flavored summary. **No spawn.** Cheap. Keeps the orchestrator conversational without violating "one job per role".

### B.8 — File touch list

| Path | Change |
|---|---|
| `src/db/schema/profiles.ts` | add `category` enum value `'assistant'` |
| `src/db/seed-orchestrator-profile.ts` | new — seeds default `Octi` per user on creation |
| `src/core/orchestrator/persona.ts` | new — loads + assembles persona block |
| `src/core/orchestrator/service.ts:481` (`runOrchestrator`) | call persona loader, pass into prompt builder |
| `src/core/orchestrator/before-agent-start.ts` | new — the hook this revamp consumes |
| `src/core/orchestrator/roles/orchestrator/prompt.md` | unchanged |
| `src/core/orchestrator/roles.ts:22-34` (`SECURITY_PREAMBLE`) | unchanged |
| `src/core/swarm/spawner.ts:926-938` | add `narration` field to `node_spawned`/`node_completed` payloads |
| `src/api/gateway-ws.ts` | accept `interject` message type (Slice 4) |
| `src/core/orchestrator/meta-tools/remember-about-self.ts` | new |
| `src/core/orchestrator/meta-tools/reflect.ts` | new |
| `src/core/orchestrator/post-process.ts` | new — third-person nudge regex |
| `src/tui-pi/commands/persona.ts` | new — slash command handler |
| `personas/*.yaml` | new directory + 6 presets |
| `web/app/persona/page.tsx` | new — persona settings view |

### B.9 — Not in scope

- Per-channel persona overrides (user said persona persists across channels).
- Per-workspace persona (user said per-user only).
- Specialist children inheriting persona — out of scope; specialists stay role-defined.
- Modifying `SECURITY_PREAMBLE` or `roles/orchestrator/prompt.md`.

---

## Sequencing

**Slice 1 — Foundations** (no user-visible change).

- Build the `before-agent-start` hook (ROADMAP "Next" item).
- Add `category='assistant'` to `profiles` schema; migration.
- Wire `octi doctor` command.

**Slice 2 — Personality MVP** (big user-visible win).

- Persona block injection via the hook.
- Default `Octi` profile seeded; `/persona name|tone|say|reset` slash commands.
- Third-person rule + minimal narration on `swarm.node_spawned`.
- 3 preset personas (default-octi, adam-the-bureaucrat, terse-engineer).
- Side-channel-messages variant (a) from B.3.

**Slice 3 — Setup revamp**.

- `scripts/install.sh`, root `docker-compose.yaml`, compiled `octi` binary.
- `octi init` TUI wizard with the A.2 provider flow (Ollama → LiteLLM → direct provider).
- Friendly no-model path in `directResponse`.
- README one-liner; web `/setup` demoted.

**Slice 4 — Conversational depth**.

- `interject` event (option b from B.3).
- `reflect` meta-tool.
- Persona settings page in web UI.
- Remaining 3 preset personas.

**Slice 5 — Self-improvement loop** (separate track, larger scope).

- Trajectory consumer (ROADMAP line 95).
- Skill auto-extension promote UI (line 88).
- Periodic memory nudges à la Hermes.

---

## Roadmap insertions

Move into **Now**:

1. **Setup UX revamp — clone-to-chat in 90 seconds.** `scripts/install.sh`, root Docker Compose, compiled `octi` binary, unified `octi init` TUI wizard, `octi doctor`, Ollama-first → LiteLLM → direct-provider model-selection flow (Voyage embeddings-only), friendly no-model path in `directResponse`, README one-liner. TUI is the canonical setup surface; web `/setup` demoted to status view.

2. **Orchestrator persona system.** Named, themed, user-customizable identity for the orchestrator. Per-user, persists across channels. Stored in `profiles` with `category='assistant'`. Persona block layered between `SECURITY_PREAMBLE` and the role prompt via the `before-agent-start` hook (both `SECURITY_PREAMBLE` and `roles/orchestrator/prompt.md` untouched). Slash commands `/persona name|tone|say|reset`. Third-person self-reference enforced. New `remember_about_self` and `reflect` meta-tools. Six preset personas in `personas/`.

3. **Live swarm narration.** Status events (`swarm.node_spawned` / `node_completed`) carry persona-rendered text so the user sees "Adam is researching…" instead of generic role names. Per-user `persona.narration: off | minimal | chatty` setting.

4. **Side-channel messages while swarm runs.** User can interject without cancelling the in-flight task; persona spawns a `general` child to answer in parallel; reply surfaces with persona attribution. Foundation for a later first-class `interject` event.

Promote from Next to Now (prerequisite):

5. **`before-agent-start` hook with mutable system-prompt options.** Already on roadmap. Promote because persona, dynamic roles, and the Extension SDK all consume it.

---

## Open follow-ups (parking lot)

- Renaming the binary entirely (e.g. `octipus` → `octi` everywhere) — user confirmed `octi` for all commands; verify nothing still ships as `octipus-tui-edit` etc.
- Whether to ship a default Ollama model auto-pull (`llama3.2:3b`) inline in `octi init` if none are detected. Recommended: yes, with a clearly-confirmed prompt (~2GB download).
- Telemetry on third-person rule violations — useful to tune the regex without going nuclear.
- Persona export/import (YAML round-trip) — adjacent to the upcoming skill marketplace work.
