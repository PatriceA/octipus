# Agent Architecture

## Core Concepts

### Tools
Executable capabilities with functions and permissions. Each tool module provides one or more functions that agents can call.

**Examples:** shell (run, env), filesystem (read, write), git (commit, push), browser (navigate, click), docker (run_container), github (create_issue), google-workspace (send_email), websearch (search)

**Location:** `src/tools/` — each extends `BaseTool`, registered in `ToolRegistry`

### Skills
Domain knowledge sets that provide expertise to agents via system prompt injection. Skills contain principles, best practices, anti-patterns, and relevant frameworks.

**Examples:** software-architecture, test-automation, security-practices, financial-analysis, ai-engineering, design-principles

**Location:** DB table `skills`, seeded from `src/db/seed-skills.ts`, managed via `SkillRegistry` and `/api/skills` CRUD

### Experts
Pre-configured agent personas that combine a role, tools, skills, and system prompt. Experts bypass the root agent for direct, focused task execution.

**Examples:** Coder (coding role + architecture/data-structures skills), DevOps Engineer (devops role + CI/CD/containers skills), Security Analyst (security role + OWASP/networking skills)

**Location:** DB table `presets`, seeded from `src/db/seed-experts.ts`

#### Structured Expert Prompts

Every system expert includes three structured prompt sections that are automatically injected into the agent's system prompt:

| Field | Schema Column | Purpose |
|-------|--------------|---------|
| **Critical Rules** | `criticalRules` (string[]) | Hard constraints the agent must follow (e.g., "Never commit directly to main", "Always validate user input") |
| **Deliverable Template** | `deliverableTemplate` (text) | Expected output format — defines the structure of the agent's final response (e.g., code review format with sections for issues, suggestions, summary) |
| **Success Metrics** | `successMetrics` (string[]) | Evaluation criteria for the agent's output (e.g., "All tests pass", "No security vulnerabilities introduced") |

These fields are defined on the `presets` table and populated for all 16 system experts. Custom experts can also define them via the API or web UI.

### Agents (Workers)
Runtime instances that execute tasks using an LLM tool loop. Each agent has a context (session, user, model, role) and iterates: call LLM → parse tool calls → execute tools → repeat.

**Location:** `src/core/agent-worker.ts`, managed by `AgentManager`

### Root agent
Depth-0 root of the swarm, and the agent the user is talking to. It runs as an ordinary role — `general` (`ROOT_ROLE`) — with the general toolset **plus** the `spawn_child` / `collect_children` / `create_pipeline` meta-tools, so it answers with its own tools and delegates sub-topics to specialist Agents when one is genuinely needed. Owns the final user-facing reply.

Until Phase 9 of the rebuild plan this was a dedicated `root agent` role holding meta-tools and `profiles` and nothing else, reached through a keyword classifier that decided per message whether to run it at all. It could do no work, so half its runs answered from parametric memory after a second model had already read the same message. Both the classifier branch and the tool-less role are gone; `AgentContext.root` is what identifies the root now, since the role string no longer does.

**Location:** `src/core/agent/service.ts` and `root-runner.ts`, role prompt at `src/core/agent/roles/general/prompt.md`, delegation mechanics at `src/core/agent/delegation-prompt.md`

#### Message Classification (Two-Layer Architecture)

The root agent uses two layers of classification with different vocabularies:

**Layer A — src/core/router.ts** (legacy, 15 topics):
coding, research, architecture, chat, embedding, design, devops, security, data, ai, qa, finance, automation, pm, writing (+ 'general' fallback).

**Layer B — src/core/agent/classifier.ts** (live, 14 categories):
coding, research, devops, security, review, qa, data, writing, architecture, design, finance, communication, automation, general.

Layer B is the active classification path. What it is NOT any more is a routing decision: it does not choose the specialist (Phase 2) and it does not choose whether an agent runs at all (Phase 9). It scopes memory retrieval, and in the lite tier only it reaches the model as a hint the request can override. `TOPIC_TO_ROLE_ALIAS` (swarm-tool.ts) still catches natural-language synonyms the model may use in `spawn_child` (e.g. `development`→`coding`, `database`→`data`). Divergences from Layer A: Layer B has distinct 'communication' category and lacks 'chat'/'embedding'/'ai'/'pm' (handled via LLM fallback).

### Swarm (3-Level Hierarchy)

Delegation runs through a fixed 3-level tree: **Root agent → Agent → Subagent**. Depth is structural, not configurable.

| Kind | Depth | Spawned by | Can spawn? | Lifetime |
|---|---|---|---|---|
| **Root agent** | 0 | `AgentService.handleMessage()` | Yes → Agents | Per session |
| **Agent** | 1 | Parent's `spawn_child` | Yes → Subagents | Ephemeral, per topic |
| **Subagent** | 2 | Parent's `spawn_child` | **No** (leaf) | Ephemeral, per subtopic |

The LLM-facing tool is `spawn_child`. Agents also get `escalate_to_different_expert` (1/Agent lifetime) to retry a task with a different expert of the same role when children hit budget or timeout.

**Location:** `src/core/swarm/` — `spawner.ts`, `call-graph.ts`, `types.ts`, `errors.ts`, `escalate-tool.ts`, `swarm-tool.ts`, `orphan-reaper.ts`, `fan-out-budget.ts`, `node-repository.ts`. DB table `swarm_nodes`. The full design lives in `.octipus/swarm-design.md`.

## Root agent persona

A per-user identity layer the root agent inherits at every turn — name, pronouns, tone, narration volume, free-form self-facts. Default is **Octipus** (the octopus-machine). Layered between `SECURITY_PREAMBLE` and the role prompt via the `before-agent-start` hook:

```
SECURITY_PREAMBLE           (DESIGN.md rule #6 — untouched)
│
▼
PERSONA BLOCK               (from personas/<preset>.yaml + per-user overrides)
│
▼
ROLE PROMPT                 (roles/general/prompt.md + delegation-prompt.md — untouched)
│
▼
memory block, recent history, classifier hint, …
```

The same persona applies to the two remaining non-agentic surfaces that also speak to the user — the voice propose-then-confirm turn and `chat.interject` — both of which still run `directResponse`, so those replies sound like Octipus too. Live swarm events (`swarm.node_spawned`, `node_completed`, `budget_warning`) get re-emitted as `swarm.narration` carrying persona-rendered text ("Octipus dispatches a research arm.", "qa arm failed. Predictable.") — channels subscribe independently.

Specialist children **don't** inherit the persona — they stay role-defined. Persona is host-level only.

Six presets ship under `personas/`: `octipus` (default), `terse-engineer`, `mentor`, `nautilus`, `concierge`, `verbose-academic`. The `category='assistant'` row in the `profiles` table stores the user's overrides ([PROFILES.md](PROFILES.md#assistant-profile-persona)). Edit via `/persona ...` slash commands or the web `/persona` page.

## Execution Paths

```
User Message
    │
    ▼
Root agent (depth 0)
    │
    ├─ Expert bypass? ──► Spawn worker with expert's role + tools + skills
    │
    └─ Every other message ──► the root agent runs: general tools + meta-tools
                              │
                              ├─ spawn_child(role, topic, subtopic, taskBrief)
                              │     ──► Agent (depth 1) with resolved expert,
                              │         topic-bound model, intersected tools
                              │         │
                              │         └─ spawn_child / escalate_to_different_expert
                              │                ──► Subagent (depth 2), hard leaf
                              │
                              ├─ Multiple spawn_child calls with same parallelGroup
                              │     ──► Promise.all fan-out (cap 4/turn)
                              │
                              └─ create_pipeline(type) ──► Sequential stages
                                    Stage 1 → Stage 2 → ... → Stage N
```

### Delegation Priority

1. **`spawn_child`** (single) — default for single-role delegation with structured output.
2. **`spawn_child`** (multiple, parallel or sequential) — when the task has distinct sub-topics.
3. **`create_pipeline`** — the verified build loop, and the **preferred primitive for development work**: it plans the work into items, runs implement → test → review → QA once per item, and routes a failed QA verdict back to the implementer (bounded) before escalating. Prefer it over `spawn_child` whenever the user asks to build, implement, fix, refactor, migrate or ship something and "done" can be settled by *running* something — not by whether the user said "staged". A single `spawn_child` for that work skips the verification loop and leaves the child's own word as the only evidence. Not for questions, writing, or read-only audits, which have nothing to re-run. Pipelines are root-only; Agents and Subagents cannot call `create_pipeline`. Also startable outside a chat turn via `POST /api/pipelines`.

The legacy `spawn_worker` and `spawn_team` meta-tools are **removed from the LLM-visible tool surface**. The `worker-spawner.ts` internals still back pipeline stages (sequential handover, non-LLM) but the LLM no longer sees either primitive.

### Swarm Budgets

Every node has a hard budget envelope enforced pre-LLM-call inside `AgentWorker.loop()`. Breach throws a structured error (`BudgetExceededError`, `ChildTimeoutError`, `CascadedCancellationError`) which the spawner maps to `ChildResult.status`.

| Level | Tokens (cap) | Wall-clock (cap) | Fan-out (cap) |
|---|---|---|---|
| Root agent (0) | 200k | 10 min | 6 |
| Agent (1) | 80k | 10 min | 4 |
| Subagent (2) | 30k | 10 min | 0 |

- **Tokens cascade** (pool-shared): `child.tokens.cap = min(LEVEL_DEFAULT[depth], parent.remaining.tokens − 10% RESERVE)`.
- **Wall-clock does NOT cascade**: each node gets its own `LEVEL_DEFAULT` wall cap. Parent's clock excludes time spent awaiting children via `AgentWorker.pausedMs`.
- **Fan-out**: per-node cap enforced synchronously by the spawner before concurrency/cache/budget math. Per-turn parallel cap (4) is a secondary guard in `tool-executor.ts`; overflow returns `concurrency_limit`.

Defaults live in `src/core/swarm/types.ts` (`LEVEL_DEFAULT`, `BUDGET_RESERVE_FRACTION`).

### Cycle / Duplicate Protection

`SwarmCallGraph` per-root-session keeps a fingerprint set of `(topicPath, normalized(taskBrief), inputArtifact refs)`. Duplicate spawns within a session return `cancelled` with a `parentNotice` so the parent LLM can synthesize against the in-flight result. Ancestor-chain collisions are rejected as a second guard. Fingerprints are released on child failure so the parent may respawn with a refined brief.

### Cascade Cancel

Parent abort propagates to children via an `AbortSignal` chain rooted on the Root agent. `AgentManager.stop(id, { cascade: true })` walks the in-memory `childrenByParent` index synchronously and fires a background DB walk so zombie descendants flip to `cancelled` in `swarm_nodes`.

### Permission Inheritance

`child.allowedToolIds = parent.allowedToolIds ∩ requiredToolIds`. The root Root agent's `allowedToolIds` is the **union** of all role `toolIds` — so children inherit their role's full toolbox via intersection rather than an empty set. Children that need a tool the parent lacks escalate via `request_user_approval`.

### Observability

Gateway events (`src/core/gateway/protocol.ts`): `swarm.node_spawned`, `swarm.node_completed`, `swarm.budget_warning`, `swarm.call_graph_cycle_blocked`. The authoritative list, with each type's publishers and subscribers, is generated: [architecture catalog](architecture/generated/CATALOG.md). UI subscribes with the `swarm.*` pattern and renders a live tree per session. The replay buffer keeps swarm events for reconnection; `/api/swarm/nodes?rootSessionId=…` is the REST fallback for tree rehydration after the buffer ages out.

### Reliability & Verification

Three additions make delegation auditable, verifiable, and resumable: **receipts** (a deterministic side-effect audit of what each child's tool calls actually did, on `ChildResult.receipt`), **scorer gates** (deterministic checks a parent attaches to `spawn_child` to verify the deliverable — a failure yields the first-class `contract_failed` status), and the **swarm ledger** (an append-only history of node transitions that lets a crash-interrupted swarm be replayed and reconciled on boot). Full reference: [SWARM-RELIABILITY.md](SWARM-RELIABILITY.md).

### QA Retry Loop

Pipeline stages can be typed as `qa_validation`. When a QA stage fails, the pipeline automatically retries the previous implementation stage with the QA feedback injected into context. This loop continues up to 3 retries (configurable via `maxRetries` on the pipeline step). After max retries are exhausted, the pipeline escalates to the user for manual approval.

Pipeline step fields for QA retry:

| Field | Type | Purpose |
|-------|------|---------|
| `stageType` | `"implementation"` \| `"qa_validation"` \| `"review"` | Classifies the stage for retry logic |
| `maxRetries` | number | Maximum retry attempts before escalation (default: 3) |
| `retryTargetStage` | string | Which stage to retry on failure (typically the preceding implementation stage) |

### Handoff Context Documents

When work passes between pipeline stages, a structured **handoff document** is automatically generated and forwarded to the next stage's agent. Each handoff contains:

- **Completed work summary** — what the previous stage accomplished
- **Key decisions** — architectural or implementation choices made
- **Open questions** — unresolved issues for the next stage to address
- **Artifacts produced** — files created/modified, endpoints added, etc.
- **Role-aware instructions** — context tailored to the receiving agent's role

The full handoff chain is accumulated across all stages, so later stages have visibility into the entire pipeline history. This prevents context loss and reduces redundant work across sequential stages.

### Automatic Expert Selection

When the root agent (or an Agent) calls `spawn_child` with a `role` and no explicit `expertId`, the swarm spawner matches a system expert from the database by role. The matched expert provides:

- **System prompt** — expert-specific instructions and persona (with `SECURITY_PREAMBLE` deduplicated)
- **Domain knowledge** — skills loaded via `SkillRegistry.buildPromptFragment()` and appended
- **Model preference** — the expert's preferred model (as a fallback; see topic→model below)

**Priority chain:** Explicit `expertId` on `spawn_child` > Explicit UI expert selection > Auto-matched expert by role > Generic role config.

### Topic → Model Routing (Authoritative)

Children resolve their model strictly (no parent-model inheritance, no hardcoded defaults):

1. `ModelRegistry.getModelForTopic(topic)` — primary lookup; returns null if topic is unbound.
2. If topic model lacks tools, swap to a local Ollama tool-capable model (via `ModelSelector.ensureToolSupport()`).
3. Expert `modelPreference` — if the matched expert has an explicit preference *and no topic binding exists*, use it.
4. Fail loud — if all above resolve to null, `SwarmSpawner.resolveChildModelAndExpert` throws with a message pointing the user at the Models page. No default-model fallback for workers.

Children **inherit topic bindings, not the parent's model**. If a research Agent spawns a security Subagent, the Subagent resolves the model bound to `security`, not the parent's research model. `ModelRegistry.getModelForTopic()` is the single authoritative entry point. `litellm-client.ts:embed()` and `visual/analyzer.ts` resolve embedding/vision models the same way (or throw if unbound). Default fallback applies *only* to the root agent via `selectForOrchestration()`.

## How They Relate

| Concept | What it is | When created | Lifetime |
|---------|-----------|--------------|----------|
| **Tool** | Executable module (shell, git...) | App startup | Singleton |
| **Skill** | Domain knowledge | App startup | Singleton |
| **Expert** | Agent configuration | DB seed / user-created | Persistent |
| **Agent** | Running worker instance (depth 1) | Per `spawn_child` | Request-scoped, tracked in `swarm_nodes` |
| **Subagent** | Leaf worker (depth 2) | Per `spawn_child` from an Agent | Request-scoped |
| **Swarm** | Full tree for a session | Per root message | Session-scoped, persisted in `swarm_nodes` |
| **Pipeline** | Sequential stage chain | Per-request | DB-tracked (pipelines table) |

## Agent Roles

| Role | Tools | Default Skills | Use Case |
|------|-------|---------------|----------|
| coding | filesystem, shell, git, knowledge, task_state, mcp | architecture, data-structures, db-design, api-design | Code implementation |
| review | filesystem, shell, git, knowledge, task_state, visual | architecture, testing, security, performance | Code review |
| research | websearch, knowledge, filesystem, profiles, artifacts, artifacts_toolbox, task_state, mcp | technical-writing | Investigation |
| design | browser, filesystem | design-principles, design-frameworks | UI/UX |
| devops | shell, docker, git, filesystem, mcp | devops, containers, cloud, networking | Infrastructure |
| security | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | security, networking, cloud | Security analysis |
| data | shell, filesystem, knowledge, task_state, artifacts, artifacts_toolbox, mcp | db-design, data-engineering, performance | Data/DB work |
| ai | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | ai-engineering, ML, data-structures | AI/ML tasks |
| qa | browser, browser-ext, shell, docker, filesystem, knowledge, task_state, visual, artifacts, artifacts_toolbox | test-automation, performance | Testing |
| finance | browser, websearch, filesystem | financial-analysis | Financial work |
| automation | shell, docker, filesystem, scheduling, mcp | automation-patterns, devops | Workflows |
| pm | filesystem, messaging | project-management, technical-writing | Project mgmt |
| writing | filesystem, browser, websearch, knowledge, task_state, messaging | technical-writing, api-design | Documentation |
| communication | google-workspace, microsoft365, messaging, scheduling, profiles, email-processor, voice | — | Email/calendar |
| architecture | filesystem, shell, knowledge, task_state, websearch, mcp | — | System design |
| general | filesystem, browser-ext, websearch, messaging, knowledge, task_state, scheduling, profiles, email-processor, artifacts, artifacts_toolbox, mcp | — | Fallback |

## Thinking Token Management

Some models (Qwen3, DeepSeek) emit `<think>...</think>` reasoning blocks that consume output tokens. The system handles this at multiple levels:

- **Model-level:** "Disable Thinking" checkbox in the model Add/Edit dialog sets `extraBody: { think: false }` — prevents the model from generating reasoning tokens entirely (Ollama)
- **Agent workers (root agent AND experts):** Strip `think:false` from extraBody so the model can reason before emitting tool calls. Empirically (2026-05-12 QA), Ollama with `think:false` produces malformed tool-call JSON that the Go-side parser rejects ("Value looks like object, but can't find closing '}'"); with thinking ON, the same models emit valid tool calls. The override applies to every role that uses tools, not just experts.
- **LLM client safety net:** `<think>` blocks are stripped from both sync and streaming responses before delivery, so users never see raw reasoning output

**Strategy:** Keep thinking enabled for any agent that emits tool calls (root agent, experts) — the cost in tokens is much smaller than the cost of a failed tool call + retry storm. Disable thinking only for the toolless surfaces (`direct-response.ts` — voice propose, `chat.interject`), where there are no tool calls to corrupt.

## Steering Messages

Steering messages allow users to inject corrections or guidance into a running agent session without interrupting the current tool execution.

### How It Works

1. Client sends `{ type: 'steer', sessionId, content }` over the WebSocket gateway
2. The message is queued on the session
3. After the current tool call completes, the queue is drained
4. Steering content is injected as a system-level message before the next LLM call

### When to Use

- Redirect an agent that is going down the wrong path ("focus on the API layer, not the UI")
- Add constraints mid-run ("don't modify any test files")
- Provide clarification the agent needs without aborting and restarting

Steering messages are non-disruptive — they never interrupt a tool that is already executing. The agent sees them as additional context on its next LLM turn.

## Context Compaction

When a conversation grows large, the system compacts it using LLM-based summarization rather than simple message truncation.

### Approach

- An LLM call summarizes the conversation history into a condensed form
- **File operation metadata is preserved** — which files were read, written, created, or deleted — so the agent retains awareness of filesystem state even after compaction
- Tool call/result pairs are condensed but their essential outcomes are kept
- The compacted summary replaces older messages while recent messages remain intact

This preserves more useful context per token than naive truncation, especially for long coding sessions where file state matters.

## File Mutation Queue

Concurrent agents (teams, parallel pipeline stages) may attempt to write to the same file simultaneously, causing race conditions or corrupted output.

### How It Works

- A per-file write queue serializes all mutation operations (write, append, patch) targeting the same file path
- Read operations are not queued — only writes acquire the lock
- Each file path gets its own independent queue, so writes to different files proceed in parallel
- The queue is transparent to tool implementations — serialization is handled at the tool executor level

## Thinking Budgets

Reasoning models (Qwen3, DeepSeek, o-series) benefit from thinking tokens but consume output capacity. The system auto-manages thinking budgets.

### Levels

| Level | Thinking Budget | Use Case |
|-------|----------------|----------|
| **off** | 0 tokens | Casual chat |
| **low** | ~1024 tokens | Simple tool calls, classification |
| **medium** | ~4096 tokens | Multi-step tool reasoning |
| **high** | ~8192+ tokens | Complex planning, code generation |

### Behavior

- **Auto-detection**: The system detects reasoning-capable models and assigns a default budget based on the agent's role
- **Scaling**: Budget scales with task complexity — simple turns get `off` or `low`, agent workers get `medium` or `high`
- **Agent worker override**: Workers always enable thinking even if the model config disables it, since complex tool-use benefits from reasoning
- Thinking tokens are stripped from output before delivery to users

## Adding New Components

### New Tool
Tools auto-discover via `discovery.ts` from `src/tools/` folders. No manual registration needed; each tool extends `BaseTool` with a unique `toolId`.

### New Skill
Create via the API (`POST /api/skills`) or add to `SYSTEM_SKILLS` in `src/db/seed-skills.ts` for system skills.

### New Expert
Add entry to `SYSTEM_EXPERTS` in `src/db/seed-experts.ts` with role, skills, prompt, rules, and metrics.

### New Role
1. Create folder `src/core/agent/roles/<name>/`
2. Add `config.ts` with `RoleMeta` (role, toolIds, defaultTopic)
3. Add `prompt.md` (role system prompt)
4. Roles auto-discover from folders; no manual registration needed

## Knowledge Base (RAG)

Agent outputs are automatically indexed into the knowledge base on completion, enabling future agents to retrieve past work. Most specialist roles have access to the `knowledge` tool for search and manual indexing.

See **[RAG Documentation](RAG.md)** for full details on setup, configuration, and architecture.
