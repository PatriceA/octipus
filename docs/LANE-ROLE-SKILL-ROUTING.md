# Lane, Role & Skill Routing

How lanes, roles, skills and models connect to each other.

## Core Principle

**A role is what may be touched; a lane is what it costs.** They are separate on
purpose, and they are not 1:1. Several roles share a lane — `coding`,
`architecture`, `devops` and `data` all resolve to `build` — because the
question a lane answers is "which class of model serves this work?", not "what
is this work about". A lane exists if and only if you would plausibly bind a
DIFFERENT model to it.

The five text lanes: **build** (implementation, architecture, debugging),
**verify** (review and QA — deliberately a different model from the one that
wrote the code), **everyday** (chat, lookups, classification, drafting),
**research** (fan-out investigation), **background** (memory extraction,
judging, summaries). Plus the `ocr` / `vision` / `embedding` model classes.

## The Chain

```
User message
  ↓
Classifier (keyword matching)
  ↓
selectLane(message)          which MODEL serves this turn
  role alias, else an artefact signal (file/trace/diff) → build,
  else everyday
  ↓
Model Registry: getModelForTopic(lane)
  1. topicRoles[lane] = 'primary'
  2. the default model, for a root turn, when the lane is unbound
  3. null for a worker — fail loud, no silent fallback
  ↓
Agent spawned with: role tools + lane model + role prompt + rules + skills
```

## Roles (tools and prompt) and the lane each resolves to

| Role / Topic | Tools | Use Case |
|---|---|---|
| `general` | filesystem, browser-ext, websearch, messaging, knowledge, task_state, scheduling, profiles, email-processor, artifacts, artifacts_toolbox, mcp | Multi-purpose, browsing, messaging |
| `coding` | filesystem, shell, git, knowledge, task_state, mcp | Code generation, debugging, git |
| `research` | websearch, knowledge, filesystem, profiles, artifacts, artifacts_toolbox, task_state, mcp | Web search, investigation |
| `architecture` | filesystem, shell, knowledge, websearch, task_state, mcp | System design, requirements, specs |
| `review` | filesystem, shell, git, knowledge, task_state, visual | Code review, linting, testing (read-only) |
| `qa` | browser, browser-ext, shell, docker, filesystem, knowledge, task_state, visual, artifacts, artifacts_toolbox | Test suites, UI testing, bug reports |
| `communication` | google-workspace, microsoft365, messaging, scheduling, profiles, email-processor, voice | Email, calendar, phone calls |
| `design` | browser, filesystem | UI/UX design, mockups |
| `devops` | shell, docker, git, filesystem, mcp | CI/CD, Docker, infrastructure |
| `security` | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | Vulnerability analysis, hardening |
| `data` | shell, filesystem, knowledge, task_state, artifacts, artifacts_toolbox, mcp | Databases, data pipelines, SQL |
| `ai` | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | ML/AI, RAG, model training |
| `finance` | browser, websearch, filesystem | Financial analysis, market data |
| `automation` | shell, docker, filesystem, scheduling, mcp | Cron tasks, hooks, workflows |
| `pm` | filesystem, messaging | Project planning, tracking |
| `writing` | filesystem, browser, websearch, knowledge, task_state, messaging | Documentation, technical writing |

The lane each role resolves to lives in `RETIRED_TOPIC_ALIASES`
(`src/models/topics.ts`), not in the role config, so re-pointing a role is a
one-line change: `coding`/`architecture`/`devops`/`data`/`design`/`security`/
`ai`/`finance`/`automation` → **build**, `review`/`qa` → **verify**,
`general`/`writing`/`communication`/`pm` → **everyday**, `research` →
**research**.

Work that leaves an ARTEFACT fails up into `build`: a weak model there does not
stall, it ships something plausible that nothing downstream catches. Work whose
answer is checkable at a glance falls to `everyday`, where a wrong answer is
visible in the reply and costs a cent to redo.

Model-class lanes, bound separately because a chat model produces garbage on
them: `embedding` (vector embeddings), `ocr` (text from images), `vision` (image
understanding).

## Choosing a different model for a child

A parent that wants its child on a different model names a lane:

```
spawn_child(role: 'review', topic: 'verify')   → the verify lane's model
spawn_child(role: 'review')                    → the same, via the role alias
spawn_child(role: 'coding', topic: 'everyday') → bulk work, cheaply
```

`topic` is validated (`asLane`): a name that is not a lane — "oauth/pkce", say —
stays a label for the topic path and does not steer the model. `background` is
deliberately not routable; it is the lane for memory extraction and
summarisation, not somewhere a parent may send work.

There used to be an EXPERT layer here: a `presets` row carrying a role, a lane,
a prompt, a model preference and a set of rules, selectable with `/expert` and
passable as `spawn_child(expertId:)`. It was retired on 2026-09-18 — the model
comes from a lane, the rules belong to the role, the procedure is a skill, and
an ordered workflow is a pipeline the user writes. Nothing was left for the row
to decide.

## Skills

Skills are domain knowledge documents (markdown with principles, best practices, anti-patterns, frameworks). They are injected into the agent's system prompt as an INDEX — name plus a one-line description — and the body is pulled on demand with `get_skill`. They are tied to a ROLE, not to a lane or a model.

### Skill → Role Mapping

| Skill | Used By |
|---|---|
| software-architecture | coding, architecture, review |
| data-structures | coding, ai |
| test-automation | review, qa |
| design-principles | design |
| design-frameworks | design |
| devops-practices | devops, automation |
| container-orchestration | devops |
| security-practices | security, review |
| cloud-platforms | devops, security |
| financial-analysis | finance |
| ai-engineering | ai |
| automation-patterns | automation |
| database-design | data, architecture |
| api-design | coding, architecture, writing |
| project-management | pm |
| technical-writing | research, pm, writing |
| performance-engineering | coding, data, review, qa |
| data-engineering | data |
| machine-learning | ai |
| plugin-development | coding |
| networking | devops, security |

### Skill lifecycle: distillation → proposal → promotion

Skills are not only seeded — octipus can **learn** them from real work and
**retire** them when they go stale. Both halves route through
`skill_proposals`; nothing becomes a live skill without human approval.

**Generate (distillation).** The `skill_distill` tool distils a *reusable
procedure* — steps and principles, not the one-off instance — into a **pending
proposal** (`kind = 'skill'`). Sources:

| `source` | Material |
|---|---|
| `conversation` | The recent turns of the current session |
| `text` | Literal `content` you pass in |
| `trajectory` | A recorded run (`ref` = a `trajectory_runs` id) — **gated on quality** |

The `trajectory` source only distils a run whose `outcome` is `success`, and —
when the session recorded [verification evidence](OBSERVABILITY.md) — only when
none of it failed. The distiller model resolves via the `skill_distillation`
topic, which canonicalizes to the shared **`background`** lane (bind a cheap /
local model there); an unbound lane fails loud. Distillation is never a silent
write: it always produces a *pending proposal*.

**Promote (approval).** `POST /api/skills/proposals/:id/approve` promotes a
proposal. It branches on `kind`:

- `kind = 'skill'` → inserts a row into the `skills` table (a distilled
  procedure).
- `kind` records what the distiller thought it was proposing; every proposal promotes to a SKILL.

Each promotion is atomic with the status flip (no orphan skill if the
status update fails). Rejecting a proposal suppresses re-proposal for 90 days.

**Prune (curation).** `runSkillCurator` flags skills unused for 30 days and
auto-archives after 90 (see the roadmap "Skill auto-extension" item for the
generative-refresh follow-up).

## Pipeline Stages

Pipeline stages specify a `topic` field that determines both the role (tools) and model:

| Pipeline | Stage | Topic |
|---|---|---|
| Full Development Cycle | Research & Discovery | `research` |
| Full Development Cycle | Requirements & Architecture | `architecture` |
| Full Development Cycle | Implementation | `coding` |
| Full Development Cycle | Testing | `qa` |
| Full Development Cycle | Code Review | `review` |
| Full Development Cycle | QA Validation | `qa` |
| Full Development Cycle | Summary & Handoff | `general` |
| Research & Analysis | Deep Investigation | `research` |
| Research & Analysis | Analysis & Recommendations | `general` |
| Bug Fix | Reproduce & Diagnose | `coding` |
| Bug Fix | Implement Fix | `coding` |
| Bug Fix | Verify Fix | `coding` |

## Model Configuration

To bind a model to a lane, use the **Topics** page in the web UI (the Models
page's default-model star is only the fallback for an unbound lane):
1. Pick the lane
2. Choose its primary model — and optionally a backup and an executor
3. Every agent routed to that lane runs on it

Binding a different model to `build` and to `verify` is the point of the split:
until they differ, routing is provably correct and economically invisible.

**Fail-loud, no default fallback.** `ModelRegistry.getModelForTopic(topic)` is the single authoritative entry point. If a topic has no model bound, the spawner returns null and throws with a message directing the user to the Models page — there is no silent "default model" fallback. Embedding and vision consumers generally use topic resolution: the knowledge base self-check (`/api/knowledge/readiness`) surfaces a 503 if no embedding model is bound. Document image extraction also retains a legacy direct OCR fallback; see [Documents](DOCUMENTS.md#ocr--vision-model). (Default model fallback applies *only* to a root turn; worker agents refuse it.)

## Swarm children resolve their own lane

When an agent spawns a child via `spawn_child`, the child resolves its model
through the **child's** lane — the one the parent named, else the child role's —
never the parent's model. A `build` agent spawning a `review` child gets the
`verify` model, which is the entire point: a second opinion from the model that
wrote the code is not a second opinion. Inheriting the parent's model would also
hide routing bugs, so an unbound lane fails loud instead.

A lane can bind three models: a **primary**, a **backup** (failure retry only, never chosen for cost or capability) and an **executor** (cheap model for pre-planned mechanical sub-work) — see [MODEL-ROUTING.md](MODEL-ROUTING.md) for the full resolution order and the planner→executor split.

## Skill Embedding Backfill

`scripts/backfill-skill-embeddings.ts` (re-)computes description embeddings
for skills missing them or whose `description_hash` no longer matches the
current `name + description`.

Run manually:

    npm run db:backfill-skill-embeddings

Recommended: cron every 15 minutes. Skill description edits invalidate the
embedding immediately at write time; the cron refills lazily. With no
embedding model configured, the script exits cleanly — discovery still
works via triggers + always_inject + stale-fallback.
