# Model↔Topic System — Analysis & Topic-Consolidation Plan

Status: IMPLEMENTED — Phase 1 (backup wiring, voice re-probe, orchestrator
expert index) and Phases 2–3 (topic collapse 27→7 with retired-topic aliasing,
`experts.topic` lane assignment, data migration 0074) are in. Phase 4 remains:
expert CRUD UI polish + surfacing `expert → topic → model` routing in the UI.

Implementation notes (Phases 2–3):
- Role configs intentionally KEEP their role-named `defaultTopic`s ('coding',
  'research', …). Those are retired aliases now: `canonicalTopic()` maps them
  to lanes at the model-registry/topic-config lookup layer, and the role name
  keeps doubling as the key for role-scoped skill assignments
  (`skill_topic_assignments` stays role-keyed by design).
- The orchestrator prefers the `chat` lane binding when set, else the default
  model (previously 'chat' had no consumer).
- hwfit catalog keeps editorial topic names; `buildModelEntry` canonicalizes
  them to lanes at bind time.
- Migration 0074: adds `presets.topic` (default 'agents'); elects the
  agents/background lane primary+backup from the retired-topic bindings
  (most-covered model wins, 'general' preferred on ties); pins differing
  per-role primaries as the role's system-expert `modelPreference`; copies
  'general' / newest background extras rows onto the lane rows. Retired keys in
  `topic_roles` / `topics` / `topics_config` are left in place — inert, since
  every lookup canonicalizes first.
- `seedExperts` no longer resyncs `modelPreference` (operator-owned; the
  migration writes it).
Date: 2026-07-01

## Decisions (2026-07-01)

1. **Background topics**: merge into one `background` lane — they exist to bind
   small local models; per-feature separation isn't needed.
2. **`voice`**: KEEP and wire it — it serves the telephony path (Twilio/Telnyx/
   Plivo calls). Root cause of the "lost" voice functionality found and fixed:
   configuring telephony credentials after boot only invalidated the tool
   registry cache, never the `capabilities` table that `getToolsForRole` gates
   on — so the communication worker spawned without `make_call` until restart.
   `resetTelephonyProvider()` now re-probes the `voice` capability row.
3. **Backup model**: wired. Worker failure path and swarm-child retry path now
   try the topic's backup binding (fresh node, original prompt + tools) before
   the CLI→default last resort.
4. **Expert selection**: the orchestrator now receives a live AVAILABLE EXPERTS
   index (system + the user's custom experts, read from DB each turn) and passes
   `expertId` to spawn_child — extendable: new experts are routable immediately.

## Part 1 — How routing works today (as-built)

### The three per-topic model knobs

The Topics page (`web/app/topics/page.tsx`, backed by `src/api/routes/topics.ts`)
exposes three model fields per topic plus temperature/maxTokens:

| Knob | Storage | Read at runtime by |
|---|---|---|
| **Primary** | `model_config.topicRoles[topic] = 'primary'` (legacy fallback: `topics[]` array + `priority`) | `ModelRegistry.getModelForTopic()` — used everywhere (workers, swarm children, embedding, vision, OCR, memory, evaluation, summarization, toolshim…) |
| **Backup** | `model_config.topicRoles[topic] = 'backup'` | **NOTHING.** `getBackupModelForTopic()` (`src/models/model-registry.ts:158`) has zero callers. |
| **Executor** | `topics_config.executorModel` | ONLY the swarm child spawner (`src/core/swarm/spawner.ts:984`). NOT `spawnWorker()` (`src/core/orchestrator/worker-spawner.ts`), which is what pipeline stages and direct `/expert` invocations use. |

### Resolution order per path

- **Orchestrator turn** (`orchestrator-runner.ts:64` → `ModelSelector.selectForOrchestration`):
  session `/model` override → **default model** (not a topic binding), with a
  reasoner/no-tools sanity swap.
- **Worker via `spawnWorker`** (pipeline stages, `/expert` direct):
  `overrides.model` (expert modelPreference from `handleExpertMessage`) →
  auto-selected system expert's `modelPreference` → **topic primary**
  (`roleConfig.defaultTopic`) → fail loud. `executorModel` is **not** consulted.
- **Swarm child via `spawn_child`** (`spawner.ts:972-1007`):
  expert `modelPreference` → topic **executorModel** → topic **primary** → fail loud.
- **Failure fallback** (`worker-spawner.ts handleWorkerFailure`):
  transient error → retry once, same model; provider=`cli` failure → retry with
  the **default** model. The configured topic **backup is never tried**.
- **Tool-support fallback** (`model-selector.ts ensureToolSupport`): if the topic
  primary lacks tool support, silently reroute to a **local Ollama** model.

### Verdict: is it routed correctly?

Mostly yes for the primary binding (fail-loud contract is honored and consistent),
but there are real defects:

1. **Backup is dead config.** Users can bind a backup per topic in the UI; no code
   path ever reads it. The actual fallback (CLI→default) ignores it. Either wire
   `getBackupModelForTopic` into `handleWorkerFailure` (and the classified-error
   failover path) or remove the field.
2. **Executor is inconsistent.** Swarm children honor it; pipeline-stage workers and
   direct expert invocations (both via `spawnWorker`) do not. Same "worker" concept,
   two behaviors, undocumented.
3. **Two divergent keyword classifiers.**
   `src/core/orchestrator/classifier.ts` (main path) and `src/core/router.ts`
   (used only by `src/api/routes/agents.ts`) have different keyword sets and
   different valid-topic lists; `core/router.ts` also silently falls back to the
   default model, violating the fail-loud contract the registry comment promises.
4. **Dead topics.** `chat`, `simple`, `local`, `voice` are in the canonical
   registry, are shown/bindable in the Topics UI, participate in cache
   invalidation — and have **no runtime consumer** (`getModelForTopic('chat'|'simple'|'local'|'voice')` is never called).
5. **Retry/fallback workers lose the expert.** `handleWorkerFailure` respawns with
   `roleConfig.systemPromptTemplate` — the expert prompt, critical rules, and
   skills the failed worker had are dropped, so a retried task runs as a
   different, weaker persona.
6. Minor: `handleExpertMessage` tier-check resolves `modelPreference` only via
   `getModelByModelId` (the swarm spawner tries name *and* modelId);
   `selectByComplexity` still keys off the deprecated `priority` column.

### What information is given to the models

Worker system prompt assembly (`worker-spawner.ts spawnWorker` /
`handleExpertMessage`), in order:

1. `SECURITY_PREAMBLE` + `OUTPUT_FORMATTING_RULES`
2. Role prompt (`roles/<role>/prompt.md`) **or** expert override: identity
   (name + description), expert `systemPrompt`, Critical Rules, Deliverable
   Template + Success Metrics (skipped for small-tier models), Response Guidelines
3. Expert skills (full bodies for direct `/expert` on big models; index-only
   otherwise) + topic-assigned skills (`skill_topic_assignments`, deduped)
4. Current date/time; AGENTS.md instruction (+ file contents in dev mode)
5. Git status/diff for code-aware roles (coding/review/devops/security/qa)
6. User profile facts + related-person profiles (regex-triggered people queries)
7. Workspace constraints (sandbox root, plugin dir)
8. Role-scoped long-term memories (up to 8)
9. "You are a worker agent — don't message the user" directive
10. Product-docs pointer (knowledge-tool roles), MCP guidance (CLI models)

Then the user message: `task + "--- Context from previous steps ---" + input`.
Topic `temperature`/`maxTokens` overrides are applied at completion time
(`agent-worker.ts:1302` via `getTopicConfig(context.topic)`).

### Is this shown to the user?

Partially:

- **Shown**: Topics page (all 27 topics, 5 knobs each — admin only); swarm tree
  (role + model per node); `worker_spawned` events (role, model); optional
  sources footer `_Sources: expert(Coder), role(coding), skills(5)_`.
- **Not shown**: the assembled system prompt (memories, profile facts, git
  status, skills actually injected); that Backup does nothing; which fallback
  actually fired (default-model fallback, Ollama tool-support reroute — logs only).

## Part 2 — Why there are "a lot of topics"

27 topics in `src/models/topics.ts`:

- **16 worker-role topics** (`general`, `coding`, `research`, `architecture`,
  `review`, `communication`, `design`, `devops`, `security`, `data`, `ai`, `qa`,
  `finance`, `automation`, `pm`, `writing`) — 1:1 with roles (`roleConfig.defaultTopic === role`), each with exactly one seeded system expert.
- **4 orchestrator-direct text topics** (`chat`, `simple`, `local`, `voice`) — all
  currently dead.
- **5 background topics** (`memory_extraction`, `knowledge_review`, `evaluation`,
  `summarization`, `tool_translation`) — each read by exactly one feature;
  unbound = feature off.
- **3 model-class topics** (`vision`, `ocr`, `embedding`) — different model
  classes, must stay separate.

The sprawl comes from **conflating three axes into one enum**: *domain expertise*
(what the expert knows), *tool bundle* (what the role can touch), and *model
binding* (which LLM serves it). Because topic == role, adding an expert domain
today means adding a topic, a role folder, a classifier keyword block, and a
Topics-page row — and 16 nearly-identical model bindings for users who run one
model anyway (which is why `assign-all` exists).

## Part 3 — Target architecture

**Topics become model lanes** (few, about cost/latency/model-class).
**Experts become the domain layer** (many, user-extensible, each assigned to a
topic/lane). **Roles stay as tool bundles** (which tools a worker may hold).

### New topic set (27 → 7)

| Topic | Kind | Serves |
|---|---|---|
| `agents` | text | ALL expert workers (the "1 topic, many experts" lane). Primary + backup + executor + temp/maxTokens live here once. |
| `chat` | text | Orchestrator + casual/direct replies (today: default model — this makes it explicit). |
| `background` | background | memory_extraction, knowledge_review, evaluation, summarization, tool_translation (one cheap-model binding). |
| `voice` | text | Low-latency lane — keep ONLY if we actually wire it (it is dead today); otherwise drop. |
| `vision` / `ocr` / `embedding` | model classes | unchanged. |

Per-expert overrides that today would justify a separate topic move to
`experts.modelPreference` (already exists) — the escape hatch for "my Coder runs
on a bigger model".

### Expert → topic assignment

```
experts (table 'presets')
  + topic text NOT NULL DEFAULT 'agents'   -- which model lane serves this expert
  role stays                                -- tool bundle + base prompt selection
```

Model resolution for any worker becomes ONE function used by both spawn paths:

```
resolveWorkerModel(expert):
  expert.modelPreference            (name or modelId)
  → topicConfig(expert.topic).executorModel   (when spawned as executor)
  → getModelForTopic(expert.topic)            (primary)
  → getBackupModelForTopic(expert.topic)      (on failure, see Phase 1)
  → fail loud
```

### User-defined experts (future direction, enabled by this)

The `experts` table already has `userId`, prompt, skills, tools, params. What is
missing is (a) the topic column above, (b) routing: the orchestrator currently
selects `WHERE role = X AND isSystem = true LIMIT 1` — with many experts per
role it must pick by relevance. Plan: give `spawn_child` an optional `expertId`
chosen by the orchestrator from an expert index (name + description injected into
the orchestrator prompt, like skills use index-only mode), falling back to the
role's default expert. Multiple user experts per role become first-class.

## Part 4 — Phased plan

### Phase 0 — Decisions needed (see Open Questions)

### Phase 1 — Fix routing defects (independent, do first)
1. Wire backup: on worker failure (non-transient, non-denial), retry once with
   `getBackupModelForTopic(topic)` before the CLI→default fallback. Preserve the
   original system prompt + tools on retry/fallback respawns (defect 5).
2. Honor `executorModel` in `spawnWorker()` (same order as the swarm spawner) —
   or explicitly document it as swarm-only. Recommendation: honor it.
3. Delete `src/core/router.ts`'s divergent classifier; route
   `/api/routes/agents.ts` through the orchestrator classifier.
4. Remove dead topics `simple` + `local` from the registry (nothing reads them);
   decide `chat`/`voice` per Open Questions.
5. Align `modelPreference` resolution (name OR modelId) everywhere.

### Phase 2 — Decouple expert from topic
1. Migration: add `topic` column to `presets` (default `'agents'`).
2. Introduce `resolveWorkerModel()` shared by `worker-spawner.ts` and
   `swarm/spawner.ts`; workers resolve via `expert.topic` instead of
   `roleConfig.defaultTopic`.
3. Classifier keeps producing a role hint (for tools/prompt), but the model no
   longer depends on it.

### Phase 3 — Collapse the topic registry
1. New `TOPICS` list (7 entries). Keep `TopicKind` partition.
2. Data migration for `model_config.topicRoles` / `topics[]`:
   - If one model is primary for all 16 role topics (the common `assign-all`
     case) → bind it as primary for `agents`, done.
   - Else: bind the most-common primary to `agents`; for each role topic whose
     primary differed, set that model as `modelPreference` on the role's system
     expert (preserves behavior exactly).
   - Background: same most-common rule across the 5 background topics; differing
     bindings preserved via per-feature override (Open Question 1).
   - `topics_config` rows for retired topics: migrate `agents`-relevant extras,
     drop the rest.
3. Topic aliasing for one release: `getModelForTopic()` maps retired values
   (`coding` → `agents`, `memory_extraction` → `background`, …) and logs a
   deprecation warning, so stale callers/plugins keep working.
4. Update: `SINGLE_MODEL_CHAT_TOPICS`, `invalidateCache()` topic list, role
   configs' `defaultTopic`, `skill_topic_assignments` seeds (skill "topics" keep
   using role ids — rename that concept to avoid confusion, e.g. keep the table
   keyed by role), Topics page (7 cards instead of 27), QA.md flows.

### Phase 4 — Many experts per topic + user experts
1. Expert picker: orchestrator prompt gets an expert index (name + description
   + role); `spawn_child` accepts `expertId`; selection falls back to the
   role's system expert.
2. Experts CRUD UI: create/edit expert (name, description, prompt, role/tool
   bundle, skills, topic lane, optional modelPreference). API mostly exists.
3. Surface routing to the user: swarm tree + sources footer show
   `expert → topic → model (+ fallback used)`, and an admin "prompt preview"
   for what a given expert's worker receives.

## Open questions

1. **Background topics**: merge all 5 into one `background` lane? Today
   "unbound = feature off" is the per-feature kill switch. Recommendation:
   merge, and move the kill switches to explicit feature toggles in Settings
   (unbound-as-toggle is undiscoverable).
2. **`voice`**: it is currently dead. Wire it as a real low-latency lane, or drop
   it until telephony needs it? Recommendation: drop now, re-add when consumed.
3. **Backup**: wire it up (Phase 1.1) or delete the field? Recommendation: wire
   it — the failure path exists and currently falls back to arbitrary models.
4. **Expert auto-selection**: should the orchestrator pick among multiple experts
   per role automatically (index in prompt), or only when the user explicitly
   selects an expert? Recommendation: automatic with fallback to the system
   expert, since that is what "add as many experts as you want" implies.
